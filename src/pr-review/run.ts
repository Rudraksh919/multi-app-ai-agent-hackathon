import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { githubAuthConfigured } from '../clients/githubAuth.js';
import { makeLinearClient } from '../clients/linear.js';
import { getPrFiles, postPrComment, makeGitHubClient } from '../clients/github.js';
import { makeRepoClient } from '../clients/repo.js';
import { startSandbox } from './sandbox.js';
import { openBrowserSession } from './browserTools.js';
import { reviewPr } from './agent.js';
import { implementOnPr } from './implementAgent.js';
import { renderPrComment, renderPrImplementComment } from './render.js';
import type { GitHubPrFile } from '../clients/github.js';
import type { PrImplementRun, PrInfo, PrReviewRun } from './types.js';

/** First Linear-style identifier in the PR title/body, e.g. "AGE-59" from "Fixes AGE-59". */
function extractLinearRef(text: string): string | null {
  const m = text.match(/\b([A-Z]{2,10}-\d+)\b/);
  return m?.[1] ?? null;
}

function formatDiff(files: GitHubPrFile[]): string {
  return files
    .map(
      (f) =>
        `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${f.patch ?? '(binary or too large for a patch)'}`,
    )
    .join('\n\n')
    .slice(0, 20_000);
}

async function record(run: PrReviewRun | PrImplementRun): Promise<void> {
  await mkdir(CONFIG.prReviewsDir, { recursive: true });
  await writeFile(join(CONFIG.prReviewsDir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

export async function runPrReview(
  pr: PrInfo,
  instruction?: string,
  onLog: (s: string) => void = console.log,
): Promise<PrReviewRun> {
  const startedAt = Date.now();
  const id = `prr_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${pr.number}`;

  const run: PrReviewRun = {
    id,
    started_at: new Date().toISOString(),
    pr,
    linear_ticket: null,
    evidence: [],
    steps: [],
    result: null,
    outcome: 'ERROR',
    stats: { duration_ms: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  };

  onLog(`\n${'─'.repeat(70)}\n[${id}] reviewing PR #${pr.number}: ${pr.title}\n`);

  // ── Linear context ───────────────────────────────────────────────────
  const ref = extractLinearRef(`${pr.title} ${pr.body ?? ''}`);
  let linearContext: string | null = null;
  if (ref) {
    try {
      const linear = makeLinearClient();
      const issue = await linear.getIssue(ref);
      if (issue) {
        run.linear_ticket = { identifier: issue.identifier, title: issue.title, url: issue.url };
        linearContext = `${issue.identifier}: ${issue.title}\n\n${issue.description ?? '(no description)'}`;
        onLog(`  linked ticket: ${issue.identifier} — ${issue.title}`);
      }
    } catch (err) {
      onLog(`  linear lookup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Diff ──────────────────────────────────────────────────────────────
  let diffText = '(diff unavailable)';
  try {
    const files = await getPrFiles(pr.baseOwner, pr.baseRepo, pr.number);
    diffText = formatDiff(files);
  } catch (err) {
    onLog(`  could not fetch diff: ${err instanceof Error ? err.message : err}`);
  }

  // ── Sandbox: clone the PR's own branch, install, boot ────────────────
  onLog('  starting sandbox (clone + npm install + boot)…');
  let sandbox;
  try {
    sandbox = await startSandbox(pr.headOwner, pr.headRepo, pr.headRef);
  } catch (err) {
    run.outcome = 'SANDBOX_FAILED';
    run.error = err instanceof Error ? err.message : String(err);
    run.stats.duration_ms = Date.now() - startedAt;
    onLog(`  sandbox failed: ${run.error}`);
    await record(run);
    await postVerdict(run, onLog);
    return run;
  }
  onLog(`  sandbox live at ${sandbox.baseUrl}`);

  let browser: Awaited<ReturnType<typeof openBrowserSession>> | undefined;
  try {
    browser = await openBrowserSession(sandbox.baseUrl);

    const reviewOutcome = await reviewPr(
      { prTitle: pr.title, prBody: pr.body, diffText, linearContext, baseUrl: sandbox.baseUrl, instruction },
      { baseUrl: sandbox.baseUrl, browser },
      (s) => onLog(`  ${String(s.idx).padStart(2)}. ${s.tool.padEnd(18)} ${s.summary}`),
    );

    run.evidence = reviewOutcome.evidence;
    run.steps = reviewOutcome.steps;
    run.result = reviewOutcome.result;
    run.stats = {
      duration_ms: Date.now() - startedAt,
      tool_calls: reviewOutcome.steps.length,
      input_tokens: reviewOutcome.usage.input_tokens,
      output_tokens: reviewOutcome.usage.output_tokens,
      cost_usd: reviewOutcome.usage.cost_usd,
    };

    if (reviewOutcome.result) {
      run.outcome = 'REVIEWED';
    } else {
      run.outcome = 'ERROR';
      run.error =
        reviewOutcome.providerFailure ??
        'Review ended without a verdict (ran out of steps, or the model stopped without calling submit_review).';
    }
  } catch (err) {
    run.outcome = 'ERROR';
    run.error = err instanceof Error ? err.message : String(err);
    run.stats.duration_ms = Date.now() - startedAt;
  } finally {
    await browser?.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }

  onLog(`\n  outcome: ${run.outcome}${run.result ? ` (${run.result.verdict})` : ''}`);
  if (run.error) onLog(`  error: ${run.error}`);

  await record(run);
  await postVerdict(run, onLog);
  return run;
}

async function postVerdict(run: PrReviewRun, onLog: (s: string) => void): Promise<void> {
  if (!githubAuthConfigured()) return;
  try {
    const comment = renderPrComment(run);
    run.comment_url = await postPrComment(run.pr.baseOwner, run.pr.baseRepo, run.pr.number, comment);
    onLog(`  posted: ${run.comment_url}`);
    await record(run); // persist the comment_url alongside everything else
  } catch (err) {
    onLog(`  failed to post PR comment: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Triggered by an "@bisect implement <instruction>" comment. Reuses the same sandbox mechanism
 * as a review (clone the PR's own branch, npm install, boot) but with write access — the agent
 * edits files directly in the sandbox's checkout, which hot-reloads them into the live dev
 * server it's also testing against. On success, the change is pushed to a NEW branch and opened
 * as a follow-up PR targeting the original PR's branch — not committed straight onto it — so the
 * original stays untouched until someone reviews the fix.
 */
export async function runPrImplement(
  pr: PrInfo,
  instruction: string,
  onLog: (s: string) => void = console.log,
): Promise<PrImplementRun> {
  const startedAt = Date.now();
  const id = `pri_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${pr.number}`;

  const run: PrImplementRun = {
    id,
    started_at: new Date().toISOString(),
    pr,
    instruction,
    steps: [],
    summary: null,
    files_changed: [],
    follow_up_pr_url: null,
    outcome: 'ERROR',
    stats: { duration_ms: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  };

  onLog(`\n${'─'.repeat(70)}\n[${id}] implementing on PR #${pr.number}: ${instruction}\n`);

  let diffText = '(diff unavailable)';
  try {
    const files = await getPrFiles(pr.baseOwner, pr.baseRepo, pr.number);
    diffText = formatDiff(files);
  } catch (err) {
    onLog(`  could not fetch diff: ${err instanceof Error ? err.message : err}`);
  }

  onLog('  starting sandbox (clone + npm install + boot)…');
  let sandbox;
  try {
    sandbox = await startSandbox(pr.headOwner, pr.headRepo, pr.headRef);
  } catch (err) {
    run.outcome = 'SANDBOX_FAILED';
    run.error = err instanceof Error ? err.message : String(err);
    run.stats.duration_ms = Date.now() - startedAt;
    onLog(`  sandbox failed: ${run.error}`);
    await record(run);
    await postImplementComment(run, onLog);
    return run;
  }
  onLog(`  sandbox live at ${sandbox.baseUrl}`);

  let browser: Awaited<ReturnType<typeof openBrowserSession>> | undefined;
  try {
    browser = await openBrowserSession(sandbox.baseUrl);
    const repo = makeRepoClient(sandbox.dir);

    const result = await implementOnPr(
      { prTitle: pr.title, diffText, instruction, baseUrl: sandbox.baseUrl },
      { repo, baseUrl: sandbox.baseUrl, browser },
      (s) => onLog(`  ${String(s.idx).padStart(2)}. ${s.tool.padEnd(18)} ${s.summary}`),
    );

    run.steps = result.steps;
    run.summary = result.summary;
    run.files_changed = result.files.map((f) => f.path);
    run.stats = {
      duration_ms: Date.now() - startedAt,
      tool_calls: result.steps.length,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd: result.usage.cost_usd,
    };

    if (result.providerFailure) {
      run.outcome = 'ERROR';
      run.error = result.providerFailure;
    } else if (result.files.length === 0) {
      run.outcome = 'NO_CHANGE';
    } else {
      const github = makeGitHubClient(pr.headOwner, pr.headRepo, repo);
      run.outcome = 'IMPLEMENTED';
      if (github.available()) {
        try {
          run.follow_up_pr_url = await github.commitAndOpenPr({
            branch: `bisect-fix/pr-${pr.number}-${Date.now()}`,
            title: `Fix: ${instruction}`.slice(0, 72),
            body:
              `${result.summary ?? ''}\n\n---\nRequested via "@bisect ${instruction}" on ` +
              `#${pr.number}. Targets that PR's branch, not main — review this before it merges in.`,
            files: result.files,
            base: pr.headRef,
          });
        } catch (err) {
          onLog(`  could not open follow-up PR: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (err) {
    run.outcome = 'ERROR';
    run.error = err instanceof Error ? err.message : String(err);
    run.stats.duration_ms = Date.now() - startedAt;
  } finally {
    await browser?.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }

  onLog(`\n  outcome: ${run.outcome}`);
  if (run.error) onLog(`  error: ${run.error}`);
  if (run.follow_up_pr_url) onLog(`  follow-up PR: ${run.follow_up_pr_url}`);

  await record(run);
  await postImplementComment(run, onLog);
  return run;
}

async function postImplementComment(run: PrImplementRun, onLog: (s: string) => void): Promise<void> {
  if (!githubAuthConfigured()) return;
  try {
    const comment = renderPrImplementComment(run);
    run.comment_url = await postPrComment(run.pr.baseOwner, run.pr.baseRepo, run.pr.number, comment);
    onLog(`  posted: ${run.comment_url}`);
    await record(run);
  } catch (err) {
    onLog(`  failed to post PR comment: ${err instanceof Error ? err.message : err}`);
  }
}

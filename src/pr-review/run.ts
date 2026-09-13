import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, env } from '../config.js';
import { makeLinearClient } from '../clients/linear.js';
import { getPrFiles, postPrComment } from '../clients/github.js';
import { startSandbox } from './sandbox.js';
import { openBrowserSession } from './browserTools.js';
import { reviewPr } from './agent.js';
import { renderPrComment } from './render.js';
import type { GitHubPrFile } from '../clients/github.js';
import type { PrInfo, PrReviewRun } from './types.js';

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

async function record(run: PrReviewRun): Promise<void> {
  await mkdir(CONFIG.prReviewsDir, { recursive: true });
  await writeFile(join(CONFIG.prReviewsDir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

export async function runPrReview(pr: PrInfo, onLog: (s: string) => void = console.log): Promise<PrReviewRun> {
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
      { prTitle: pr.title, prBody: pr.body, diffText, linearContext, baseUrl: sandbox.baseUrl },
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
  if (!env.githubToken()) return;
  try {
    const comment = renderPrComment(run);
    run.comment_url = await postPrComment(run.pr.baseOwner, run.pr.baseRepo, run.pr.number, comment);
    onLog(`  posted: ${run.comment_url}`);
    await record(run); // persist the comment_url alongside everything else
  } catch (err) {
    onLog(`  failed to post PR comment: ${err instanceof Error ? err.message : err}`);
  }
}

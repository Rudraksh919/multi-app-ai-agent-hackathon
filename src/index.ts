import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, env } from './config.js';
import { makeLinearClient } from './clients/linear.js';
import { makePostHogClient } from './clients/posthog.js';
import { makeSlackClient } from './clients/slack.js';
import { investigate } from './agent/investigate.js';
import { implementFix } from './agent/implement.js';
import { parseReport } from './steps/parse.js';
import {
  approvalBlocks,
  implementResultBlocks,
  linearDescription,
  slackBlocks,
  slackFallbackText,
  title,
} from './report/render.js';
import { resolveRepo } from './repo/resolve.js';
import { hasSkills, readSkillMd } from './skills/detect.js';
import { runBootstrap } from './skills/bootstrap.js';
import { applyBootstrap } from './skills/apply.js';
import type { Investigation, PostHogEvent, SlackMessage } from './types.js';

interface Options {
  once: boolean;
  dryRun: boolean;
  text: string | null;
}

function parseArgs(argv: string[]): Options {
  const textIdx = argv.indexOf('--text');
  return {
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
    text: textIdx >= 0 ? (argv[textIdx + 1] ?? null) : null,
  };
}

/** First session id the agent actually saw, for the replay deep link. */
function firstSessionId(investigation: Investigation): string | null {
  for (const e of investigation.evidence) {
    if (e.source !== 'posthog' || !Array.isArray(e.data)) continue;
    for (const row of e.data as PostHogEvent[]) {
      if (row?.session_id) return row.session_id;
    }
  }
  return null;
}

async function runOne(message: SlackMessage, opts: Options): Promise<Investigation> {
  const startedAt = Date.now();
  const id = `inv_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

  const investigation: Investigation = {
    id,
    started_at: new Date().toISOString(),
    slack: message,
    report: null,
    evidence: [],
    steps: [],
    diagnosis: null,
    outcome: 'SKIPPED',
    stats: { duration_ms: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  };

  console.log(`\n${'─'.repeat(70)}\n[${id}] ${message.text}\n`);

  // ── 1. Triage ────────────────────────────────────────────────────────
  const report = await parseReport(message.text);
  investigation.report = report;

  if (!report.is_bug_report) {
    console.log(`  skipped — not a bug report (${report.reasoning})`);
    investigation.outcome = 'SKIPPED';
    investigation.stats.duration_ms = Date.now() - startedAt;
    await record(investigation);
    return investigation;
  }

  console.log(`  symptom : ${report.symptom}`);
  console.log(`  user    : ${report.email ?? '(not specified)'}`);
  console.log(`  window  : ${report.window.from} → ${report.window.to}\n`);

  const slack = makeSlackClient();
  if (!opts.dryRun) {
    await slack.reply(message.channel, message.ts, `🔍 Investigating: _${report.symptom}_`);
  }

  // ── 1.5 Route or map ─────────────────────────────────────────────────
  // CASE 1: bisect-skills/ doesn't exist yet — pay the "understand this codebase" cost
  // once, in a dedicated pass, and persist it. CASE 2: it exists — read the small routing
  // skill.md and hand it to the investigator instead of rediscovering services from scratch.
  const { repo, github } = await resolveRepo();
  let skillMd: string | null = null;

  if (await hasSkills(repo)) {
    skillMd = await readSkillMd(repo);
  } else {
    console.log('  no bisect-skills/ found — mapping this codebase once (first run)…');
    const bootstrap = await runBootstrap(repo, (s) =>
      console.log(`    map ${String(s.idx).padStart(2)}. ${s.tool.padEnd(16)} ${s.summary}`),
    );
    const applied = await applyBootstrap(repo, github, bootstrap);
    skillMd = bootstrap.skill_md;
    console.log(
      applied.pr_url
        ? `  bisect-skills/ opened as a PR: ${applied.pr_url} (using it for this run only until merged)`
        : `  bisect-skills/ written locally: ${applied.files.join(', ')}`,
    );
  }

  // ── 2. Investigate ───────────────────────────────────────────────────
  const result = await investigate(
    report,
    { posthog: makePostHogClient(), repo },
    {
      skillMd,
      onStep: (s) =>
        console.log(`  ${String(s.idx).padStart(2)}. ${s.tool.padEnd(26)} ${s.summary}`),
    },
  );

  investigation.evidence = result.evidence;
  investigation.steps = result.steps;
  investigation.diagnosis = result.diagnosis;
  investigation.outcome = result.outcome;
  investigation.abstain_reason = result.abstain_reason;
  investigation.stats = {
    duration_ms: Date.now() - startedAt,
    tool_calls: result.steps.length,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cost_usd: result.usage.cost_usd,
  };

  const sessionId = firstSessionId(investigation);
  if (sessionId) investigation.replay_url = makePostHogClient().replayUrl(sessionId);

  console.log(`\n  outcome : ${investigation.outcome}`);
  if (investigation.diagnosis) {
    console.log(`  cause   : ${investigation.diagnosis.cause}`);
    console.log(`  where   : ${investigation.diagnosis.file ?? '—'}`);
    console.log(`  cites   : ${investigation.diagnosis.evidence_refs.join(', ') || '(none)'}`);
  }
  if (investigation.abstain_reason) console.log(`  reason  : ${investigation.abstain_reason}`);

  // ── 3. Report ────────────────────────────────────────────────────────
  if (opts.dryRun) {
    console.log(`\n${'─'.repeat(70)}\n${linearDescription(investigation)}\n`);
  } else {
    const issue = await makeLinearClient().createIssue({
      title: title(investigation),
      description: linearDescription(investigation),
    });
    investigation.linear_url = issue.url;
    console.log(`  ticket  : ${issue.identifier} ${issue.url}`);

    await slack.postBlocks(
      message.channel,
      message.ts,
      slackBlocks(investigation),
      slackFallbackText(investigation),
    );

    // ── 4. Offer to implement ─────────────────────────────────────────
    // Only above a real confidence bar — asking "should I write code?" on a shaky
    // diagnosis is worse than just filing the ticket.
    if (
      investigation.outcome === 'DIAGNOSED' &&
      investigation.diagnosis &&
      investigation.diagnosis.confidence >= CONFIG.implement.minConfidence
    ) {
      const askTs = await slack.postBlocks(
        message.channel,
        message.ts,
        approvalBlocks(investigation),
        'Want bisect to implement this fix?',
      );
      const reaction = await slack.awaitReaction(
        message.channel,
        askTs,
        ['white_check_mark', 'ticket'],
        CONFIG.approval.timeoutMs,
      );

      if (reaction === 'white_check_mark') {
        console.log('  approved — implementing fix…');
        const implemented = await implementFix(investigation.diagnosis, repo, github);
        console.log(
          `  implement: ${implemented.filesChanged.join(', ') || '(no files changed)'}` +
            (implemented.prUrl ? ` -> ${implemented.prUrl}` : ''),
        );
        await slack.postBlocks(
          message.channel,
          message.ts,
          implementResultBlocks(implemented),
          implemented.prUrl ? `Fix implemented: ${implemented.prUrl}` : 'Fix implemented locally',
        );
      } else {
        console.log(`  auto-implement: ${reaction === 'ticket' ? 'declined (ticket only)' : 'timed out'}`);
      }
    }
  }

  console.log(
    `\n  ${(investigation.stats.duration_ms / 1000).toFixed(1)}s · ` +
      `${investigation.stats.tool_calls} tool calls · $${investigation.stats.cost_usd.toFixed(3)}`,
  );

  await record(investigation);
  return investigation;
}

/** Every run is persisted — this is the foundation of the benchmark and --replay. */
async function record(investigation: Investigation): Promise<void> {
  await mkdir(CONFIG.runsDir, { recursive: true });
  await writeFile(
    join(CONFIG.runsDir, `${investigation.id}.json`),
    JSON.stringify(investigation, null, 2),
    'utf8',
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Ad-hoc mode: skip Slack entirely and investigate a string. The fast dev loop.
  if (opts.text) {
    await runOne(
      { channel: process.env.SLACK_CHANNEL_ID ?? 'local', ts: '0', user: 'local', text: opts.text },
      { ...opts, dryRun: true },
    );
    return;
  }

  const slack = makeSlackClient();
  let lastSeen: string | null = null;

  // Prime the cursor so we only react to messages sent after startup.
  const existing = await slack.fetchNew(null);
  lastSeen = existing.at(-1)?.ts ?? null;

  // Warm the repo (clones GITHUB_REPO if configured) before the first message arrives,
  // so the first investigation isn't the one paying clone latency.
  const { slug } = await resolveRepo();
  console.log(
    `bisect listening on ${env.slackChannel()}${opts.dryRun ? ' (dry run)' : ''} — ` +
      `repo: ${slug ?? env.repoPath()}`,
  );

  for (;;) {
    try {
      const messages = await slack.fetchNew(lastSeen);
      for (const message of messages) {
        lastSeen = message.ts;
        await runOne(message, opts);
      }
    } catch (err) {
      console.error('poll error:', err instanceof Error ? err.message : err);
    }

    if (opts.once) break;
    await new Promise((r) => setTimeout(r, CONFIG.slack.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

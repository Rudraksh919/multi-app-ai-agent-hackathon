import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, env } from './config.js';
import { makeLinearClient } from './clients/linear.js';
import { makePostHogClient } from './clients/posthog.js';
import { makeRepoClient } from './clients/repo.js';
import { makeSlackClient } from './clients/slack.js';
import { investigate } from './agent/investigate.js';
import { parseReport } from './steps/parse.js';
import { linearDescription, slackReply, title } from './report/render.js';
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

  // ── 2. Investigate ───────────────────────────────────────────────────
  const result = await investigate(
    report,
    { posthog: makePostHogClient(), repo: makeRepoClient() },
    {
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

    await slack.reply(message.channel, message.ts, slackReply(investigation));
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
  console.log(
    `bisect listening on ${env.slackChannel()}${opts.dryRun ? ' (dry run)' : ''} — ` +
      `repo: ${env.repoPath()}`,
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

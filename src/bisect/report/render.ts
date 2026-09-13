import type { Evidence, Investigation } from '../types.js';
import type { PostHogEvent } from '../../types.js';

/** The richest event list the agent pulled — used to show a human what it saw. */
function timelineFrom(evidence: Evidence[]): PostHogEvent[] {
  let best: PostHogEvent[] = [];
  for (const e of evidence) {
    if (e.source !== 'posthog' || !Array.isArray(e.data)) continue;
    const rows = e.data as PostHogEvent[];
    if (rows[0]?.timestamp && rows.length > best.length) best = rows;
  }
  return best;
}

function timelineLine(e: PostHogEvent): string {
  const time = e.timestamp.slice(11, 19);
  const path = e.url ? new URL(e.url, 'http://x').pathname : '';
  const label = e.el_text ? ` "${e.el_text}"` : '';
  const status = e.properties.status ?? e.properties.status_code;
  const extra = status !== undefined ? ` → ${status}` : '';
  return `${time}  ${e.event.padEnd(14)} ${path}${label}${extra}`;
}

function renderTimeline(events: PostHogEvent[], limit = 20): string {
  if (events.length === 0) return '_No events found._';

  const shown = events.length > limit ? [...events.slice(0, 8), ...events.slice(-12)] : events;
  const lines = shown.map(timelineLine);
  if (events.length > limit) lines.splice(8, 0, `          … ${events.length - 20} more events …`);
  return ['```', ...lines, '```'].join('\n');
}

const OUTCOME_EMOJI: Record<Investigation['outcome'], string> = {
  DIAGNOSED: '✅',
  NO_SESSION: '❓',
  NO_DIAGNOSIS: '🟡',
  SKIPPED: '⏭️',
};

const OUTCOME_LABEL: Record<Investigation['outcome'], string> = {
  DIAGNOSED: 'Diagnosed',
  NO_SESSION: 'Need more information',
  NO_DIAGNOSIS: 'No defensible diagnosis',
  SKIPPED: 'Skipped',
};

export function title(inv: Investigation): string {
  const symptom = inv.report?.symptom ?? inv.slack.text.slice(0, 80);
  const prefix =
    inv.outcome === 'DIAGNOSED' ? '' : inv.outcome === 'NO_SESSION' ? '[needs info] ' : '[unconfirmed] ';
  return `${prefix}${symptom}`.slice(0, 250);
}

// ─── Linear ────────────────────────────────────────────────────────────────

export function linearDescription(inv: Investigation): string {
  const parts: string[] = [];
  const events = timelineFrom(inv.evidence);
  const d = inv.diagnosis;

  // At-a-glance header — the thing a human reads before anything else.
  const glance = [
    `${OUTCOME_EMOJI[inv.outcome]} **${OUTCOME_LABEL[inv.outcome]}**`,
    d ? `Confidence \`${d.confidence.toFixed(2)}\`` : null,
    d?.file ? `\`${d.file}${d.lines ? `:${d.lines[0]}-${d.lines[1]}` : ''}\`` : null,
    typeof d?.affected_users === 'number' ? `👥 ${d.affected_users} other user${d.affected_users === 1 ? '' : 's'} hit this` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  parts.push(glance);

  if (inv.outcome === 'DIAGNOSED' && d) {
    const diagLines = [`## Diagnosis`, `**${d.cause}**`];
    if (typeof d.affected_users === 'number') {
      diagLines.push(`👥 **${d.affected_users}** other user${d.affected_users === 1 ? '' : 's'} hit the same pattern.`);
    }
    diagLines.push(
      '',
      `- [ ] Review suggested change: ${d.suggested_change}`,
      `- [ ] Confirm against replay${inv.replay_url ? ` — [watch](${inv.replay_url})` : ''}`,
    );
    parts.push(diagLines.join('\n'));
  } else {
    parts.push(
      `## No diagnosis\n\n${inv.abstain_reason ?? 'The investigation did not reach a conclusion.'}\n\n` +
        `_The trace below is attached so a human can pick this up from where the agent stopped._`,
    );
  }

  parts.push(
    [
      `## Reported`,
      `> ${inv.slack.text.replace(/\n/g, '\n> ')}`,
      inv.report?.email ? `**Affected user:** ${inv.report.email}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  parts.push(`## Session timeline\n\n${renderTimeline(events)}`);

  if (inv.evidence.length > 0) {
    const cited = new Set(d?.evidence_refs ?? []);
    const rows = inv.evidence.map(
      (e) => `| ${cited.has(e.id) ? `**${e.id}** ✓` : e.id} | ${e.source} | ${e.summary} |`,
    );
    parts.push(
      [
        '## Evidence',
        cited.size > 0 ? '_✓ = cited in the diagnosis above._' : '',
        '| id | source | what |',
        '|---|---|---|',
        ...rows,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  parts.push(
    [
      '<details>',
      '<summary>Investigation steps</summary>',
      '',
      '```',
      ...inv.steps.map((s) => `${String(s.idx).padStart(2)}. ${s.tool.padEnd(26)} ${s.summary}`),
      '```',
      '</details>',
    ].join('\n'),
  );

  parts.push(
    `---\n_bisect · ${(inv.stats.duration_ms / 1000).toFixed(1)}s · ` +
      `${inv.stats.tool_calls} tool calls · $${inv.stats.cost_usd.toFixed(3)}_`,
  );

  return parts.join('\n\n');
}

// ─── Slack (Block Kit) ───────────────────────────────────────────────────────

type Block = Record<string, unknown>;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function slackFallbackText(inv: Investigation): string {
  return `${OUTCOME_EMOJI[inv.outcome]} ${OUTCOME_LABEL[inv.outcome]} — ${inv.report?.symptom ?? inv.slack.text}`;
}

export function slackBlocks(inv: Investigation): Block[] {
  const events = timelineFrom(inv.evidence);
  const d = inv.diagnosis;
  const blocks: Block[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${OUTCOME_EMOJI[inv.outcome]} ${OUTCOME_LABEL[inv.outcome]}`, emoji: true },
  });

  const fields: Block[] = [];
  if (d) fields.push({ type: 'mrkdwn', text: `*Confidence*\n${d.confidence.toFixed(2)}` });
  if (d?.file) {
    fields.push({
      type: 'mrkdwn',
      text: `*Location*\n\`${d.file}${d.lines ? `:${d.lines[0]}-${d.lines[1]}` : ''}\``,
    });
  }
  if (typeof d?.affected_users === 'number') {
    fields.push({
      type: 'mrkdwn',
      text: `*Affected*\n👥 ${d.affected_users} other user${d.affected_users === 1 ? '' : 's'}`,
    });
  }
  if (fields.length) blocks.push({ type: 'section', fields });

  if (inv.outcome === 'DIAGNOSED' && d) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Cause*\n${truncate(d.cause, 500)}` } });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested fix*\n${truncate(d.suggested_change, 500)}` },
    });
  } else if (inv.abstain_reason) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(inv.abstain_reason, 800) },
    });
    if (inv.outcome === 'NO_SESSION') {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Reply with a confirmed email or a tighter time window.' }],
      });
    }
  }

  if (events.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*What actually happened* (${events.length} events)\n${truncate(renderTimeline(events, 10), 2900)}` },
    });
  }

  blocks.push({ type: 'divider' });

  const links: string[] = [];
  if (inv.replay_url) links.push(`<${inv.replay_url}|▶ Session replay>`);
  if (inv.linear_url) links.push(`<${inv.linear_url}|📋 Linear ticket>`);
  links.push(
    `_bisect · ${(inv.stats.duration_ms / 1000).toFixed(1)}s · ${inv.stats.tool_calls} tool calls · $${inv.stats.cost_usd.toFixed(3)}_`,
  );
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: links.join('   ·   ') }] });

  return blocks;
}

/** Appended as a separate message once a DIAGNOSED verdict clears the auto-implement bar. */
export function approvalBlocks(inv: Investigation): Block[] {
  const d = inv.diagnosis;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `Want bisect to implement this fix and open a PR?\n` +
          `React ✅ to implement · react 🎫 to leave it as a ticket only.` +
          (d ? `\n_(confidence ${d.confidence.toFixed(2)})_` : ''),
      },
    },
  ];
}

export function implementResultBlocks(input: {
  summary: string;
  filesChanged: string[];
  prUrl: string | null;
}): Block[] {
  const lines = [
    input.prUrl ? `🔧 *Fix implemented* — <${input.prUrl}|open PR>` : `🔧 *Fix implemented locally*`,
    input.summary,
    input.filesChanged.length ? `_Files changed: ${input.filesChanged.map((f) => `\`${f}\``).join(', ')}_` : '',
  ].filter(Boolean);
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } }];
}

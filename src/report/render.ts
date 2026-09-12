import type { Evidence, Investigation, PostHogEvent } from '../types.js';

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

function renderTimeline(events: PostHogEvent[], limit = 20): string {
  if (events.length === 0) return '_No events found._';

  const shown = events.length > limit ? [...events.slice(0, 8), ...events.slice(-12)] : events;
  const lines = shown.map((e) => {
    const time = e.timestamp.slice(11, 19);
    const path = e.url ? new URL(e.url, 'http://x').pathname : '';
    const label = e.el_text ? ` "${e.el_text}"` : '';
    const status = e.properties.status ?? e.properties.status_code;
    const extra = status !== undefined ? ` → ${status}` : '';
    return `${time}  ${e.event.padEnd(14)} ${path}${label}${extra}`;
  });

  if (events.length > limit) lines.splice(8, 0, `          … ${events.length - 20} more events …`);
  return ['```', ...lines, '```'].join('\n');
}

export function title(inv: Investigation): string {
  const symptom = inv.report?.symptom ?? inv.slack.text.slice(0, 80);
  const prefix =
    inv.outcome === 'DIAGNOSED' ? '' : inv.outcome === 'NO_SESSION' ? '[needs info] ' : '[unconfirmed] ';
  return `${prefix}${symptom}`.slice(0, 250);
}

export function linearDescription(inv: Investigation): string {
  const parts: string[] = [];
  const events = timelineFrom(inv.evidence);

  parts.push(`**Reported in Slack**\n> ${inv.slack.text.replace(/\n/g, '\n> ')}`);

  if (inv.report?.email) parts.push(`**Affected user:** ${inv.report.email}`);
  if (inv.replay_url) parts.push(`**Session replay:** ${inv.replay_url}`);

  parts.push(`## What actually happened\n\n${renderTimeline(events)}`);

  if (inv.outcome === 'DIAGNOSED' && inv.diagnosis) {
    const d = inv.diagnosis;
    const where = d.file ? `\`${d.file}\`${d.lines ? `:${d.lines[0]}-${d.lines[1]}` : ''}` : '_not localised_';
    parts.push(
      [
        `## Diagnosis`,
        ``,
        `**Cause:** ${d.cause}`,
        ``,
        `**Where:** ${where}`,
        ``,
        `**Suggested change:** ${d.suggested_change}`,
        ``,
        `**Confidence:** ${d.confidence.toFixed(2)}`,
      ].join('\n'),
    );
  } else {
    parts.push(
      `## No diagnosis\n\n${inv.abstain_reason ?? 'The investigation did not reach a conclusion.'}\n\n` +
        `_The trace above is still attached so a human can pick this up from where the agent stopped._`,
    );
  }

  if (inv.evidence.length > 0) {
    const cited = new Set(inv.diagnosis?.evidence_refs ?? []);
    const rows = inv.evidence.map(
      (e) => `| ${cited.has(e.id) ? `**${e.id}**` : e.id} | ${e.source} | ${e.summary} |`,
    );
    parts.push(['## Evidence', '', '| id | source | what |', '|---|---|---|', ...rows].join('\n'));
  }

  parts.push(
    [
      '## How this was investigated',
      '',
      '```',
      ...inv.steps.map((s) => `${String(s.idx).padStart(2)}. ${s.tool.padEnd(26)} ${s.summary}`),
      '```',
    ].join('\n'),
  );

  parts.push(
    `---\n_Investigated by bisect in ${(inv.stats.duration_ms / 1000).toFixed(1)}s · ` +
      `${inv.stats.tool_calls} tool calls · $${inv.stats.cost_usd.toFixed(3)}_`,
  );

  return parts.join('\n\n');
}

export function slackReply(inv: Investigation): string {
  const events = timelineFrom(inv.evidence);
  const lines: string[] = [];

  if (inv.outcome === 'DIAGNOSED' && inv.diagnosis) {
    const d = inv.diagnosis;
    lines.push(`*Diagnosed* — confidence ${d.confidence.toFixed(2)}`);
    lines.push('');
    if (events.length) lines.push(`Found the session: ${events.length} events`);
    if (inv.replay_url) lines.push(`▶ <${inv.replay_url}|watch replay>`);
    lines.push('');
    lines.push(renderTimeline(events, 12));
    lines.push('');
    lines.push(`*Cause:* ${d.cause}`);
    if (d.file) lines.push(`*Where:* \`${d.file}${d.lines ? `:${d.lines[0]}-${d.lines[1]}` : ''}\``);
    lines.push(`*Fix:* ${d.suggested_change}`);
    lines.push(`_cites ${d.evidence_refs.join(', ')}_`);
  } else if (inv.outcome === 'NO_SESSION') {
    lines.push(`*Need more information*`);
    lines.push('');
    lines.push(inv.abstain_reason ?? 'No matching session found.');
    lines.push('');
    lines.push('Can you confirm the email address, or roughly when it happened?');
  } else {
    lines.push(`*Could not determine a cause*`);
    lines.push('');
    lines.push(inv.abstain_reason ?? '');
    if (events.length) {
      lines.push('');
      lines.push("Here is what the user did, so you don't have to start from scratch:");
      lines.push(renderTimeline(events, 12));
    }
    if (inv.replay_url) lines.push(`▶ <${inv.replay_url}|watch replay>`);
  }

  if (inv.linear_url) {
    lines.push('');
    lines.push(`📋 <${inv.linear_url}|ticket created>`);
  }

  return lines.join('\n');
}

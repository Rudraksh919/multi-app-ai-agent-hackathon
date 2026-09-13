import type { PrImplementRun, PrReviewRun } from './types.js';

const VERDICT_LABEL: Record<string, string> = {
  approve: '✅ Approved',
  request_changes: '🔴 Changes requested',
  comment: '💬 Comment',
};

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: '🔴',
  major: '🟠',
  minor: '🟡',
  nit: '⚪',
};

/** The comment posted back on the PR. Neat over exhaustive — a wall of raw tool output helps no one. */
export function renderPrComment(run: PrReviewRun): string {
  if (run.outcome === 'SANDBOX_FAILED') {
    return [
      '### 🤖 bisect review',
      '',
      "Couldn't test this PR — the sandbox never came up (clone, `npm install`, or boot failed).",
      '',
      '```',
      run.error ?? 'unknown error',
      '```',
      '',
      "_Not a verdict on the code — just that I wasn't able to run it._",
    ].join('\n');
  }

  if (run.outcome === 'ERROR' || !run.result) {
    return [
      '### 🤖 bisect review',
      '',
      'Something went wrong mid-review and no verdict was reached.',
      '',
      '```',
      run.error ?? 'unknown error',
      '```',
    ].join('\n');
  }

  const { result } = run;
  const lines: string[] = [];
  lines.push(`### 🤖 bisect review — ${VERDICT_LABEL[result.verdict] ?? result.verdict}`);
  lines.push('');
  lines.push(result.summary);

  if (run.linear_ticket) {
    lines.push('');
    lines.push(
      `Tested against [${run.linear_ticket.identifier}](${run.linear_ticket.url}) — ${run.linear_ticket.title}`,
    );
  }

  if (result.findings.length > 0) {
    lines.push('');
    lines.push('| | Severity | Area | Finding |');
    lines.push('|---|---|---|---|');
    for (const f of result.findings) {
      lines.push(`| ${SEVERITY_EMOJI[f.severity] ?? ''} | ${f.severity} | ${f.area} | ${f.description} |`);
    }
  }

  lines.push('');
  lines.push(
    `<sub>${run.steps.length} live checks against a sandboxed instance of this branch · ` +
      `${(run.stats.duration_ms / 1000).toFixed(0)}s · not a static diff read.</sub>`,
  );

  return lines.join('\n');
}

/** The comment posted back after an "@bisect implement ..." request. */
export function renderPrImplementComment(run: PrImplementRun): string {
  if (run.outcome === 'SANDBOX_FAILED') {
    return [
      '### 🤖 bisect implement',
      '',
      "Couldn't work on this — the sandbox never came up (clone, `npm install`, or boot failed).",
      '',
      '```',
      run.error ?? 'unknown error',
      '```',
    ].join('\n');
  }

  if (run.outcome === 'ERROR') {
    return [
      '### 🤖 bisect implement',
      '',
      'Something went wrong and no change was completed.',
      '',
      '```',
      run.error ?? 'unknown error',
      '```',
    ].join('\n');
  }

  if (run.outcome === 'NO_CHANGE') {
    return [
      '### 🤖 bisect implement',
      '',
      `> ${run.instruction}`,
      '',
      run.summary ?? "Didn't end up making a change.",
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push('### 🤖 bisect implement');
  lines.push('');
  lines.push(`> ${run.instruction}`);
  lines.push('');
  lines.push(run.summary ?? '');

  if (run.files_changed.length > 0) {
    lines.push('');
    lines.push(`Changed: ${run.files_changed.map((f) => `\`${f}\``).join(', ')}`);
  }

  if (run.follow_up_pr_url) {
    lines.push('');
    lines.push(`Opened as a follow-up PR, targeting this branch: ${run.follow_up_pr_url}`);
  }

  lines.push('');
  lines.push(
    `<sub>${run.steps.length} steps against a live sandboxed instance · ` +
      `${(run.stats.duration_ms / 1000).toFixed(0)}s.</sub>`,
  );

  return lines.join('\n');
}

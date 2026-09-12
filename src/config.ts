import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} — copy .env.example to .env and fill it in.`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  anthropicKey: () => required('ANTHROPIC_API_KEY'),

  slackToken: () => required('SLACK_BOT_TOKEN'),
  slackChannel: () => required('SLACK_CHANNEL_ID'),

  posthogKey: () => required('POSTHOG_API_KEY'),
  posthogProject: () => required('POSTHOG_PROJECT_ID'),
  posthogHost: () => optional('POSTHOG_HOST', 'https://us.posthog.com').replace(/\/$/, ''),

  linearKey: () => required('LINEAR_API_KEY'),
  linearTeam: () => process.env.LINEAR_TEAM_ID || null,

  repoPath: () => optional('REPO_PATH', '../acme-shop'),
};

export const CONFIG = {
  models: {
    /** Cheap, high-volume: parsing a Slack message into a structured report. */
    triage: 'claude-sonnet-5',
    /** The investigation loop — reasoning over traces and code. */
    investigate: 'claude-opus-5',
  },

  /** Per 1M tokens, for the cost line on the scorecard. */
  pricing: {
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-opus-5': { input: 15, output: 75 },
  } as Record<string, { input: number; output: number }>,

  agent: {
    /** Hard ceiling on tool calls. Exhausting it is an abstention, not a failure. */
    maxSteps: 20,
    maxTokens: 8000,
  },

  slack: {
    pollIntervalMs: 5_000,
  },

  posthog: {
    /** Cap rows returned to the agent so one query can't blow the context. */
    eventLimit: 300,
  },

  diagnosis: {
    /**
     * Below this, we still file a ticket with the trace attached but make no
     * claim about the code. A ticket that says "here is the session, here is
     * the failed request, I don't know why" is useful. A confident wrong
     * answer is worse than nothing.
     */
    minConfidence: 0.4,
  },

  /** Every run is written to runs/<id>.json for --replay and the benchmark. */
  runsDir: 'runs',
} as const;

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = CONFIG.pricing[model];
  if (!p) return 0;
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

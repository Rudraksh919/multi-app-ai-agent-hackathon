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
  /**
   * One or more OpenRouter keys, tried in order on every LLM call — see
   * src/clients/llm.ts:createChatCompletion(). Free-tier "service temporarily overloaded"
   * errors are common and per-key, so a second/third key (different accounts) often just
   * works when the first doesn't. OPENROUTER_API_KEYS is comma-separated and takes priority;
   * falls back to the single OPENROUTER_API_KEY for backward compatibility.
   */
  openrouterKeys: (): string[] => {
    const multi = process.env.OPENROUTER_API_KEYS;
    if (multi) {
      const keys = multi
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      if (keys.length > 0) return keys;
    }
    return [required('OPENROUTER_API_KEY')];
  },

  /**
   * Optional local fallback. Ollama exposes an OpenAI-compatible endpoint, so the same
   * tool-calling agent requests can be retried locally after every OpenRouter key fails.
   * Leaving OLLAMA_MODEL unset disables the fallback.
   */
  ollamaModel: () => process.env.OLLAMA_MODEL || null,
  ollamaBaseUrl: () => optional('OLLAMA_BASE_URL', 'http://localhost:11434/v1').replace(/\/$/, ''),

  slackToken: () => required('SLACK_BOT_TOKEN'),
  slackChannel: () => required('SLACK_CHANNEL_ID'),

  posthogKey: () => required('POSTHOG_API_KEY'),
  posthogProject: () => required('POSTHOG_PROJECT_ID'),
  posthogHost: () => optional('POSTHOG_HOST', 'https://us.posthog.com').replace(/\/$/, ''),

  linearKey: () => required('LINEAR_API_KEY'),
  linearTeam: () => process.env.LINEAR_TEAM_ID || null,

  /**
   * Sentry is optional, unlike PostHog — not every target codebase has it, and bisect-skills
   * routing (see src/skills/) is what decides whether to query it at all for a given bug.
   * All three null = the sentry tools tell the agent it isn't configured, rather than crash.
   */
  sentryAuthToken: () => process.env.SENTRY_AUTH_TOKEN || null,
  sentryOrg: () => process.env.SENTRY_ORG || null,
  sentryProject: () => process.env.SENTRY_PROJECT || null,
  sentryHost: () => optional('SENTRY_HOST', 'https://sentry.io').replace(/\/$/, ''),

  /**
   * Repo access is either GITHUB_REPO ("owner/repo", cloned fresh via git) or a plain
   * local REPO_PATH. GITHUB_REPO is what makes bisect work on any codebase rather than
   * one fixed local checkout — see src/bisect/repo/resolve.ts.
   */
  repoPath: () => optional('REPO_PATH', '../acme-shop'),
  githubRepo: () => process.env.GITHUB_REPO || null, // "owner/repo"
  githubBranch: () => process.env.GITHUB_BASE_BRANCH || null, // null = repo default
  githubToken: () => process.env.GITHUB_TOKEN || null,

  /** HMAC secret configured on the GitHub webhook (Settings -> Webhooks). Required to trust a payload. */
  githubWebhookSecret: () => process.env.GITHUB_WEBHOOK_SECRET || null,
  prReviewPort: () => Number(optional('PR_REVIEW_PORT', '4322')),

  /**
   * GitHub App identity — when all three are set, API calls (comments, reactions, clones)
   * authenticate as the App's own installation token instead of a personal token, so they
   * show up as "bisect[bot]" rather than whichever human's PAT is in GITHUB_TOKEN. Falls
   * back to GITHUB_TOKEN when unset. See src/pr-manager/setupGithubApp.ts.
   */
  githubAppId: () => process.env.GITHUB_APP_ID || null,
  githubAppPrivateKeyPath: () => process.env.GITHUB_APP_PRIVATE_KEY_PATH || null,
  githubAppInstallationId: () => process.env.GITHUB_APP_INSTALLATION_ID || null,
};

export const CONFIG = {
  /** OpenAI-compatible endpoint — OpenRouter, so the `openai` SDK works unmodified. */
  llm: {
    baseURL: 'https://openrouter.ai/api/v1',
  },

  models: {
    /** Cheap, high-volume: parsing a Slack message into a structured report. */
    triage: 'nvidia/nemotron-3.5-lightning:free',
    /** The investigation loop — reasoning over traces and code. */
    investigate: 'nvidia/nemotron-3-super-120b-a12b:free',
    /** One-time-per-codebase discovery: mapping services -> bisect-skills/. Same tier as investigate. */
    bootstrap: 'nvidia/nemotron-3-super-120b-a12b:free',
    /** Writing an actual code patch. Same tier as investigate. */
    implement: 'nvidia/nemotron-3-super-120b-a12b:free',
    /** Driving the PR-review sandbox — reasoning over a diff plus live HTTP/browser output. */
    prReview: 'nvidia/nemotron-3-super-120b-a12b:free',
  },

  /**
   * Per 1M tokens, for the cost line on the scorecard. Both models are free-tier on
   * OpenRouter, so this is $0 today — kept as a real lookup (not hardcoded 0) so swapping
   * to a paid model later just means adding a row here.
   */
  pricing: {
    'nvidia/nemotron-3.5-lightning:free': { input: 0, output: 0 },
    'nvidia/nemotron-3-super-120b-a12b:free': { input: 0, output: 0 },
  } as Record<string, { input: number; output: number }>,

  agent: {
    /** Hard ceiling on tool calls. Exhausting it is an abstention, not a failure. */
    maxSteps: 25,
    maxTokens: 8000,
  },

  skills: {
    dir: 'bisect-skills',
    maxSteps: 20,
  },

  implement: {
    maxSteps: 15,
    /** Only offer to auto-implement above this confidence. */
    minConfidence: 0.7,
  },

  /** How long to wait for a ✅/🎫 reaction before defaulting to ticket-only. */
  approval: {
    pollIntervalMs: 5_000,
    timeoutMs: 5 * 60_000,
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

  prReview: {
    /** Hard ceiling on tool calls (http/browser actions) per PR review. */
    maxSteps: 20,
    maxTokens: 8000,
    /** Higher than review's — implementing needs read+write+verify cycles, not just probing. */
    implementMaxSteps: 25,
    /** How long to wait for `npm install && npm run dev` to answer HTTP before giving up. */
    sandboxReadyTimeoutMs: 90_000,
    npmInstallTimeoutMs: 5 * 60_000,
    port: env.prReviewPort(),
  },

  /** Every PR review is written to pr-reviews/<id>.json, same idea as runsDir. */
  prReviewsDir: 'pr-reviews',
} as const;

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = CONFIG.pricing[model];
  if (!p) return 0;
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

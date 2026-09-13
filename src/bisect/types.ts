/**
 * bisect's own pipeline types — the investigation loop's domain shapes. Client contracts
 * (PostHogClient, GitHubClient, ...) live in the top-level src/types.ts instead, since both
 * bisect and pr-manager depend on those.
 *
 * Two rules keep the system honest, and both are enforced in code rather than
 * asked for in a prompt:
 *
 *   1. Every claim cites evidence. A Diagnosis whose `evidence_refs` are empty
 *      (or reference evidence that was never collected) is discarded.
 *   2. Abstention is a first-class outcome. "I could not find a session" and
 *      "I found the session but cannot explain it" are valid, reportable results.
 */
import type { SlackMessage } from '../types.js';

/** What the triage model extracts from a messy human bug report. */
export interface ParsedReport {
  is_bug_report: boolean; // false => ignore the message entirely
  email: string | null; // the affected user, if named
  symptom: string; // "checkout spinner never resolves after clicking Pay"
  entities: string[]; // ["checkout", "payment"] — used for grep fallback
  window: { from: string; to: string }; // ISO. Fuzzy time resolved to concrete.
  reasoning: string;
}

// ─── Evidence ────────────────────────────────────────────────────────────

/**
 * Everything the agent observes becomes an Evidence item with a stable id.
 * The diagnosis must cite these ids; uncited conclusions do not ship.
 */
export interface Evidence {
  id: string; // "ph_01", "file_03", "grep_02"
  source: 'posthog' | 'sentry' | 'repo' | 'slack';
  summary: string; // one line, shown to humans
  data: unknown; // full payload, kept for the run log
}

// ─── Agent loop ──────────────────────────────────────────────────────────

export interface AgentStep {
  idx: number;
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string; // what came back, one line
  evidence_ids: string[];
  duration_ms: number;
}

/** Emitted by the agent's `conclude` tool. */
export interface Diagnosis {
  cause: string; // one sentence: what is broken and why
  file: string | null; // repo-relative
  lines: [number, number] | null;
  suggested_change: string; // description, not a patch
  confidence: number; // 0..1
  evidence_refs: string[]; // REQUIRED non-empty, must resolve
  /** How many OTHER users hit the same failure signature, if the agent could quantify it. */
  affected_users: number | null;
}

// ─── Outcome ─────────────────────────────────────────────────────────────

export type Outcome =
  /** Session found, cause identified, evidence cited. */
  | 'DIAGNOSED'
  /** No PostHog session matched the user/window. Ask a human for more. */
  | 'NO_SESSION'
  /** Session found, but no defensible cause. File the trace, claim nothing. */
  | 'NO_DIAGNOSIS'
  /** Not a bug report, or deliberately ignored. */
  | 'SKIPPED';

// ─── The object that flows through everything ────────────────────────────

export interface Investigation {
  id: string; // "inv_20260913_142211"
  started_at: string;
  slack: SlackMessage;
  report: ParsedReport | null;
  evidence: Evidence[];
  steps: AgentStep[];
  diagnosis: Diagnosis | null;
  outcome: Outcome;
  /** Why we abstained, in plain language, when outcome !== 'DIAGNOSED'. */
  abstain_reason?: string;
  linear_url?: string;
  replay_url?: string;
  stats: {
    duration_ms: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}

// ─── bisect-skills/ — per-codebase routing so investigation doesn't rediscover
// the same services from scratch on every bug report. See src/bisect/skills/.

export interface SkillReference {
  /** e.g. "posthog" -> bisect-skills/references/posthog.md */
  name: string;
  content: string;
}

export interface SkillBootstrap {
  skill_md: string;
  references: SkillReference[];
}

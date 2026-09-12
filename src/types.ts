/**
 * The contracts every module talks through.
 *
 * Two rules keep the system honest, and both are enforced in code rather than
 * asked for in a prompt:
 *
 *   1. Every claim cites evidence. A Diagnosis whose `evidence_refs` are empty
 *      (or reference evidence that was never collected) is discarded.
 *   2. Abstention is a first-class outcome. "I could not find a session" and
 *      "I found the session but cannot explain it" are valid, reportable results.
 */

// ─── Intake ──────────────────────────────────────────────────────────────

export interface SlackMessage {
  channel: string;
  ts: string; // Slack's message id, also used as thread_ts for replies
  user: string;
  text: string;
}

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
  source: 'posthog' | 'repo' | 'slack';
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

// ─── Client interfaces ───────────────────────────────────────────────────
// Every external app sits behind an interface so the benchmark and --replay
// can swap in recorded fixtures without touching pipeline code.

export interface SlackClient {
  /** Messages newer than `oldest` (a Slack ts). Bot messages filtered out. */
  fetchNew(oldest: string | null): Promise<SlackMessage[]>;
  reply(channel: string, threadTs: string, text: string): Promise<void>;
  postBlocks(channel: string, threadTs: string, blocks: unknown[], fallback: string): Promise<void>;
}

export interface PostHogPerson {
  id: string;
  distinct_ids: string[];
  properties: Record<string, unknown>;
}

export interface PostHogEvent {
  timestamp: string;
  event: string;
  url: string | null;
  el_text: string | null;
  session_id: string | null;
  properties: Record<string, unknown>;
}

export interface PostHogClient {
  findPerson(email: string): Promise<PostHogPerson | null>;
  /** Raw HogQL escape hatch — the agent can ask its own questions. */
  query(sql: string): Promise<{ columns: string[]; results: unknown[][] }>;
  eventsForPerson(distinctId: string, from: string, to: string): Promise<PostHogEvent[]>;
  eventsForSession(sessionId: string): Promise<PostHogEvent[]>;
  replayUrl(sessionId: string): string;
}

export interface RepoClient {
  /** Directory listing, repo-relative, directories suffixed with '/'. */
  list(dir: string): Promise<string[]>;
  /** File contents with 1-based line numbers prepended. */
  read(file: string, fromLine?: number, toLine?: number): Promise<string>;
  /** ripgrep-style search. Returns "path:line: text" rows. */
  grep(pattern: string, glob?: string): Promise<string[]>;
}

export interface LinearIssue {
  id: string;
  identifier: string; // "ACME-214"
  url: string;
}

export interface LinearClient {
  teamId(): Promise<string>;
  createIssue(input: { title: string; description: string }): Promise<LinearIssue>;
}

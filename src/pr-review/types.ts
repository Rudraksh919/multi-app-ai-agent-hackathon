/**
 * A sibling pipeline to the bug-investigation one: instead of reading a Slack report and
 * PostHog traces, it reads a GitHub PR and drives a live sandboxed instance of the app —
 * HTTP requests against the backend, a real browser against the UI — the way a human
 * tester would. Same rules as investigate(): every claim cites evidence, and "I couldn't
 * verify this" is a valid, reportable outcome.
 */

export interface PrInfo {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  baseOwner: string;
  baseRepo: string;
  headOwner: string;
  headRepo: string;
  headRef: string;
  headSha: string;
}

export interface ReviewEvidence {
  id: string; // "http_01", "ui_02", "diff", "linear"
  kind: 'http' | 'browser' | 'diff' | 'linear';
  summary: string;
  data: unknown;
}

export interface ReviewStep {
  idx: number;
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
  duration_ms: number;
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  area: string; // free text, e.g. "backend", "checkout UI"
  description: string;
  evidence_refs: string[];
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}

export type PrReviewOutcome =
  | 'REVIEWED' // sandbox booted, agent tested it, verdict reached
  | 'SANDBOX_FAILED' // clone/install/boot never got a live app to test
  | 'ERROR'; // unexpected failure (provider, GitHub API, etc.)

export interface PrReviewRun {
  id: string;
  started_at: string;
  pr: PrInfo;
  linear_ticket: { identifier: string; title: string; url: string } | null;
  evidence: ReviewEvidence[];
  steps: ReviewStep[];
  result: ReviewResult | null;
  outcome: PrReviewOutcome;
  error?: string;
  comment_url?: string;
  stats: {
    duration_ms: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}

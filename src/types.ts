/**
 * Shared client contracts — every external service (Slack, PostHog, Sentry, a repo checkout,
 * GitHub, Linear) sits behind one of these interfaces, implemented in src/clients/. Both
 * bisect's and pr-manager's pipelines depend on these; pipeline-specific data shapes
 * (Investigation, Diagnosis, ...) live in src/bisect/types.ts and src/pr-manager/types.ts
 * instead, next to the pipeline that actually produces them.
 */

export interface SlackMessage {
  channel: string;
  ts: string; // Slack's message id, also used as thread_ts for replies
  user: string;
  text: string;
}

export interface SlackClient {
  /** Messages newer than `oldest` (a Slack ts). Bot messages filtered out. */
  fetchNew(oldest: string | null): Promise<SlackMessage[]>;
  reply(channel: string, threadTs: string, text: string): Promise<void>;
  /** Returns the created message's ts, needed to poll reactions on it. */
  postBlocks(channel: string, threadTs: string, blocks: unknown[], fallback: string): Promise<string>;
  /**
   * Poll a message's reactions until one of `emojis` appears, or timeoutMs elapses.
   * Returns the emoji name that fired, or null on timeout.
   */
  awaitReaction(channel: string, ts: string, emojis: string[], timeoutMs: number): Promise<string | null>;
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

/** One crash Sentry grouped repeated occurrences of — PostHog's "what the user did" counterpart
 * for "what the code actually threw". */
export interface SentryIssue {
  id: string;
  title: string;
  culprit: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
}

export interface SentryStackFrame {
  filename: string | null;
  function: string | null;
  lineno: number | null;
  contextLine: string | null;
}

/** The most recent occurrence of an issue, with the detail a diagnosis actually needs:
 * the stack trace and the breadcrumb trail leading up to the throw. */
export interface SentryEventDetail {
  eventId: string;
  title: string;
  message: string | null;
  exceptionType: string | null;
  exceptionValue: string | null;
  frames: SentryStackFrame[];
  breadcrumbs: { timestamp: string; category: string | null; message: string | null; level: string }[];
  tags: Record<string, string>;
}

export interface SentryClient {
  /** Sentry's own search syntax, e.g. "user.email:x@y.com" or "is:unresolved checkout". */
  searchIssues(query: string): Promise<SentryIssue[]>;
  findIssuesForUser(email: string): Promise<SentryIssue[]>;
  issueLatestEvent(issueId: string): Promise<SentryEventDetail | null>;
}

export interface RepoClient {
  /** Directory listing, repo-relative, directories suffixed with '/'. */
  list(dir: string): Promise<string[]>;
  /** File contents with 1-based line numbers prepended. */
  read(file: string, fromLine?: number, toLine?: number): Promise<string>;
  /** ripgrep-style search. Returns "path:line: text" rows. */
  grep(pattern: string, glob?: string): Promise<string[]>;
  /** Raw file contents, no line numbers — used for skill bootstrap and patches. */
  readRaw(file: string): Promise<string>;
  /** Create or overwrite a file. Creates parent directories as needed. */
  write(file: string, content: string): Promise<void>;
  /** Absolute path on disk this client is rooted at — needed for shelling out to git. */
  root(): string;
}

export interface GitHubClient {
  /** true if this repo has GitHub write access configured (a token + owner/repo). */
  available(): boolean;
  /** Create a branch, commit the given file writes, push, and open a PR. Returns the PR URL.
   * `base` overrides the repo's default branch — used when the fix should target an existing
   * PR's own branch rather than main. */
  commitAndOpenPr(input: {
    branch: string;
    title: string;
    body: string;
    files: { path: string; content: string }[];
    base?: string;
  }): Promise<string | null>;
}

export interface LinearIssue {
  id: string;
  identifier: string; // "ACME-214"
  url: string;
}

export interface LinearIssueDetail extends LinearIssue {
  title: string;
  description: string | null;
}

export interface LinearClient {
  teamId(): Promise<string>;
  createIssue(input: { title: string; description: string }): Promise<LinearIssue>;
  /** Closes the loop when a fix lands — links the PR (or the applied patch) back onto the ticket. */
  addComment(issueId: string, body: string): Promise<void>;
  /** Look up a ticket by its human identifier (e.g. "AGE-59"). Null if not found. */
  getIssue(identifier: string): Promise<LinearIssueDetail | null>;
}

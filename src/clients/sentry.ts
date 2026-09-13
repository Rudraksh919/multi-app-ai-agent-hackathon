import type { SentryClient, SentryEventDetail, SentryIssue, SentryStackFrame } from '../types.js';
import { env } from '../config.js';

/** The slice of Sentry's issue-list JSON shape we actually read. */
interface RawIssue {
  id: string;
  title?: string;
  metadata?: { type?: string };
  culprit?: string | null;
  count?: string | number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
}

interface RawFrame {
  filename?: string | null;
  function?: string | null;
  lineNo?: number | null;
  context?: [number, string][];
}

interface RawEntry {
  type: string;
  data: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: RawFrame[] };
      timestamp?: string;
      category?: string | null;
      message?: string | null;
      level?: string;
    }[];
  };
}

interface RawEventDetail {
  eventID?: string;
  id?: string;
  title?: string;
  message?: string | null;
  entries?: RawEntry[];
  tags?: { key: string; value: string }[];
}

async function api<T>(path: string): Promise<T> {
  const token = env.sentryAuthToken();
  if (!token) throw new Error('Sentry is not configured (SENTRY_AUTH_TOKEN unset).');

  const res = await fetch(`${env.sentryHost()}/api/0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sentry ${path} -> ${res.status}: ${body.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

function rowToIssue(raw: RawIssue): SentryIssue {
  return {
    id: String(raw.id),
    title: raw.title ?? raw.metadata?.type ?? 'Unknown issue',
    culprit: raw.culprit ?? null,
    count: Number(raw.count ?? 0),
    firstSeen: raw.firstSeen ?? '',
    lastSeen: raw.lastSeen ?? '',
    permalink: raw.permalink ?? '',
  };
}

function frameContextLine(frame: RawFrame): string | null {
  const lineno = frame.lineNo;
  if (lineno == null || !frame.context) return null;
  return frame.context.find(([n]) => n === lineno)?.[1] ?? null;
}

function toStackFrame(frame: RawFrame): SentryStackFrame {
  return {
    filename: frame.filename ?? null,
    function: frame.function ?? null,
    lineno: frame.lineNo ?? null,
    contextLine: frameContextLine(frame),
  };
}

/** True by default in most SDKs — that's what makes it the standard "root cause" frame. */
function isExceptionEntry(entry: RawEntry): boolean {
  return entry.type === 'exception';
}

function isBreadcrumbsEntry(entry: RawEntry): boolean {
  return entry.type === 'breadcrumbs';
}

export function makeSentryClient(): SentryClient {
  const org = env.sentryOrg();
  const project = env.sentryProject();

  async function searchIssues(query: string): Promise<SentryIssue[]> {
    if (!org || !project) throw new Error('Sentry is not configured (SENTRY_ORG/SENTRY_PROJECT unset).');
    // No statsPeriod: this endpoint only accepts a small enum of values (24h, 14d, ...) and
    // "90d" 400s — omitting it lets Sentry use its own default rather than guessing at the
    // accepted set.
    const raw = await api<RawIssue[]>(`/projects/${org}/${project}/issues/?query=${encodeURIComponent(query)}`);
    return raw.map(rowToIssue);
  }

  return {
    searchIssues,

    findIssuesForUser(email) {
      return searchIssues(`user.email:${email}`);
    },

    async issueLatestEvent(issueId) {
      const raw = await api<RawEventDetail>(`/issues/${issueId}/events/latest/`);
      if (!raw) return null;

      const exceptionEntry = raw.entries?.find(isExceptionEntry);
      const exception = exceptionEntry?.data.values?.[0];
      const frames = (exception?.stacktrace?.frames ?? []).map(toStackFrame);

      const breadcrumbsEntry = raw.entries?.find(isBreadcrumbsEntry);
      const breadcrumbs = (breadcrumbsEntry?.data.values ?? []).map((b) => ({
        timestamp: b.timestamp ?? '',
        category: b.category ?? null,
        message: b.message ?? null,
        level: b.level ?? '',
      }));

      const result: SentryEventDetail = {
        eventId: raw.eventID ?? raw.id ?? '',
        title: raw.title ?? '',
        message: raw.message ?? null,
        exceptionType: exception?.type ?? null,
        exceptionValue: exception?.value ?? null,
        frames,
        breadcrumbs,
        tags: Object.fromEntries((raw.tags ?? []).map((t) => [t.key, t.value])),
      };
      return result;
    },
  };
}

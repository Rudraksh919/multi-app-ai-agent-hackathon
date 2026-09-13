import type { PostHogClient, PostHogEvent, PostHogPerson } from '../types.js';
import { CONFIG, env } from '../config.js';

/** Quote a value as a HogQL string literal. */
export function lit(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.posthogHost()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.posthogKey()}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostHog ${path} -> ${res.status}: ${body.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

/** Columns every event query selects, in order. Keep in sync with rowToEvent. */
const EVENT_COLS = `timestamp, event, properties.$current_url, properties.$el_text, properties.$session_id, properties`;

function rowToEvent(row: unknown[]): PostHogEvent {
  let props: Record<string, unknown> = {};
  const raw = row[5];
  if (typeof raw === 'string') {
    try {
      props = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      props = {};
    }
  } else if (raw && typeof raw === 'object') {
    props = raw as Record<string, unknown>;
  }

  return {
    timestamp: String(row[0] ?? ''),
    event: String(row[1] ?? ''),
    url: row[2] ? String(row[2]) : null,
    el_text: row[3] ? String(row[3]) : null,
    session_id: row[4] ? String(row[4]) : null,
    properties: props,
  };
}

export function makePostHogClient(): PostHogClient {
  const project = env.posthogProject();
  const targetUrl = env.targetAppUrl();
  let targetHost: string | null = null;

  if (targetUrl) {
    try {
      targetHost = new URL(targetUrl).host;
    } catch {
      throw new Error(`TARGET_APP_URL must be a full URL, received: ${targetUrl}`);
    }
  }

  const targetHostClause = targetHost ? `AND properties.$host = ${lit(targetHost)}` : '';

  const client: PostHogClient = {
    async findPerson(email) {
      const res = await api<{ results: PostHogPerson[] }>(
        `/api/projects/${project}/persons/?search=${encodeURIComponent(email)}`,
      );
      return res.results?.[0] ?? null;
    },

    async query(sql) {
      const res = await api<{ columns: string[]; results: unknown[][] }>(
        `/api/projects/${project}/query/`,
        {
          method: 'POST',
          body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
        },
      );
      return { columns: res.columns ?? [], results: res.results ?? [] };
    },

    async eventsForPerson(distinctId, from, to) {
      const { results } = await client.query(
        `SELECT ${EVENT_COLS}
         FROM events
         WHERE distinct_id = ${lit(distinctId)}
           AND timestamp >= ${lit(from)}
           AND timestamp <= ${lit(to)}
           ${targetHostClause}
         ORDER BY timestamp ASC
         LIMIT ${CONFIG.posthog.eventLimit}`,
      );
      return results.map(rowToEvent);
    },

    async eventsForSession(sessionId) {
      const { results } = await client.query(
        `SELECT ${EVENT_COLS}
         FROM events
         WHERE properties.$session_id = ${lit(sessionId)}
           ${targetHostClause}
         ORDER BY timestamp ASC
         LIMIT ${CONFIG.posthog.eventLimit}`,
      );
      return results.map(rowToEvent);
    },

    replayUrl(sessionId) {
      const base = env.posthogHost().replace('us.posthog.com', 'us.posthog.com');
      return `${base}/project/${project}/replay/${sessionId}`;
    },
  };

  return client;
}

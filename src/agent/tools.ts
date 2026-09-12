import type { Diagnosis, Evidence, PostHogClient, PostHogEvent, RepoClient } from '../types.js';

/** What a tool call produces: a human summary, optional evidence, optional loop exit. */
export interface ToolOutcome {
  text: string;
  evidence?: Evidence;
  terminal?: { kind: 'conclude'; diagnosis: Diagnosis } | { kind: 'abstain'; reason: string };
}

/** Provider-agnostic tool definition — adapted to whichever SDK's shape at the call site. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'posthog_find_person',
    description:
      'Look up a PostHog person by email address. Returns their distinct_id, which every other ' +
      'PostHog query needs. Start here when the report names a user. Returns nothing if the ' +
      'email is unknown — that is a real answer, not an error.',
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email'],
    },
  },
  {
    name: 'posthog_events_for_person',
    description:
      'Every event this person fired in a time window, oldest first: page views, clicks (with ' +
      'the button label), rage clicks, exceptions, and custom events the app emits. This is the ' +
      'record of what the user actually did — prefer it over guessing from the report text.',
    input_schema: {
      type: 'object',
      properties: {
        distinct_id: { type: 'string' },
        from: { type: 'string', description: 'ISO timestamp' },
        to: { type: 'string', description: 'ISO timestamp' },
      },
      required: ['distinct_id', 'from', 'to'],
    },
  },
  {
    name: 'posthog_events_for_session',
    description:
      'Every event in one session, oldest first. Use after you have picked the session that ' +
      'matches the reported symptom, to get the full detail of that visit.',
    input_schema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'posthog_query',
    description:
      'Run arbitrary read-only HogQL against the events table. Use for questions the other ' +
      'tools cannot answer, e.g. how many OTHER users hit the same pattern.\n\n' +
      'Schema: top-level columns are timestamp, event, distinct_id, person_id. Everything else ' +
      "lives inside properties (a JSON map) — access it as properties.$session_id, " +
      'properties.$current_url, properties.status, etc. There is no bare `session_id` or ' +
      '`$person_id` column.\n\n' +
      'Examples:\n' +
      "  SELECT event, timestamp, properties.status FROM events WHERE distinct_id = 'abc' ORDER BY timestamp\n" +
      "  SELECT count(DISTINCT person_id) FROM events WHERE event = 'checkout_response' " +
      "AND properties.status = 402 AND timestamp > '2026-09-01'\n\n" +
      'If a query errors, fix the specific problem and try once more — do not keep rephrasing ' +
      'the same question. If a query returns nothing new, stop querying and use what you have.',
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
  {
    name: 'repo_list',
    description:
      'List a directory in the application source. In a Next.js app the URL maps to the path: ' +
      '/checkout -> app/checkout/, POST /api/checkout -> app/api/checkout/route.ts. Use the URLs ' +
      'and failed requests from the session to navigate straight to the relevant code.',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string', description: "repo-relative, '' for root" } },
      required: ['dir'],
    },
  },
  {
    name: 'repo_read',
    description:
      'Read a source file with line numbers. Optionally restrict to a line range. Read the files ' +
      'the failing URL and the failing API route map to before forming any hypothesis.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        from_line: { type: 'number' },
        to_line: { type: 'number' },
      },
      required: ['file'],
    },
  },
  {
    name: 'repo_grep',
    description:
      'Case-insensitive regex search across the source. Use to find where a status code, error ' +
      'string, event name, or component is handled.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string', description: "optional path filter, e.g. 'app/**'" },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'conclude',
    description:
      'Report the cause of the bug. Only call this when session evidence and source code TOGETHER ' +
      'support the explanation. Every id in evidence_refs must be one you actually collected; ' +
      'uncited conclusions are discarded. If you cannot explain the behaviour, call abstain instead ' +
      '— an honest abstention is more valuable than a confident guess.',
    input_schema: {
      type: 'object',
      properties: {
        cause: { type: 'string', description: 'One sentence: what is broken and why.' },
        file: { type: 'string', description: 'repo-relative path, or null' },
        lines: {
          type: 'array',
          items: { type: 'number' },
          description: '[start, end], or omit if unknown',
        },
        suggested_change: { type: 'string', description: 'What to change. Prose, not a patch.' },
        confidence: { type: 'number', description: '0..1' },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'ids of evidence supporting this, e.g. ["ph_02","file_01"]',
        },
        affected_users: {
          type: 'number',
          description:
            'Optional. If your evidence includes a specific failure signature (a named event ' +
            "with a distinguishing property, e.g. checkout_response with status=402), you may " +
            'run one extra posthog_query counting DISTINCT person_id for that exact pattern ' +
            'across a wider window (e.g. the last 30 days) to see how many OTHER users hit the ' +
            'same thing, not just the one who reported it. Omit if you have no clean signature ' +
            'to count — do not guess a number.',
        },
      },
      required: ['cause', 'suggested_change', 'confidence', 'evidence_refs'],
    },
  },
  {
    name: 'abstain',
    description:
      'Stop and report that you cannot diagnose this. Use when no session matches the user, when ' +
      'the session shows no failure, or when the code does not explain what you observed. Say ' +
      'precisely what you looked at and what was missing.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

/** Props worth surfacing per event without dumping the whole blob. */
const INTERESTING = [
  'status',
  'status_code',
  'error',
  'message',
  'reason',
  '$exception_message',
  '$exception_type',
  'path',
  'method',
];

function formatEvents(events: PostHogEvent[]): string {
  if (events.length === 0) return 'No events found.';

  const lines = events.map((e) => {
    const time = e.timestamp.slice(11, 19);
    const bits: string[] = [`${time}  ${e.event}`];
    if (e.url) bits.push(new URL(e.url, 'http://x').pathname);
    if (e.el_text) bits.push(`"${e.el_text}"`);

    const extra = INTERESTING.filter((k) => e.properties[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(e.properties[k])}`)
      .join(' ');
    if (extra) bits.push(extra);

    return bits.join('  ');
  });

  const sessions = [...new Set(events.map((e) => e.session_id).filter(Boolean))];
  const header = `${events.length} events across ${sessions.length} session(s): ${sessions.join(', ')}`;
  return `${header}\n\n${lines.join('\n')}`;
}

function clamp(s: string, max = 8000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… truncated (${s.length} chars total)`;
}

export interface ToolDeps {
  posthog: PostHogClient;
  repo: RepoClient;
  /** Mutated as evidence accumulates; the loop owns the array. */
  evidence: Evidence[];
}

function nextId(evidence: Evidence[], prefix: string): string {
  const n = evidence.filter((e) => e.id.startsWith(`${prefix}_`)).length + 1;
  return `${prefix}_${String(n).padStart(2, '0')}`;
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolOutcome> {
  const { posthog, repo, evidence } = deps;

  switch (name) {
    case 'posthog_find_person': {
      const person = await posthog.findPerson(String(input.email));
      if (!person) return { text: `No PostHog person found for ${input.email}.` };
      const id = nextId(evidence, 'ph');
      const distinct = person.distinct_ids?.[0] ?? person.id;
      const ev: Evidence = {
        id,
        source: 'posthog',
        summary: `Person ${input.email} -> distinct_id ${distinct}`,
        data: person,
      };
      return {
        text: `[${id}] Found person. distinct_id: ${distinct}\nproperties: ${JSON.stringify(person.properties).slice(0, 600)}`,
        evidence: ev,
      };
    }

    case 'posthog_events_for_person': {
      const events = await posthog.eventsForPerson(
        String(input.distinct_id),
        String(input.from),
        String(input.to),
      );
      const id = nextId(evidence, 'ph');
      return {
        text: `[${id}]\n${clamp(formatEvents(events))}`,
        evidence: {
          id,
          source: 'posthog',
          summary: `${events.length} events for ${input.distinct_id}`,
          data: events,
        },
      };
    }

    case 'posthog_events_for_session': {
      const events = await posthog.eventsForSession(String(input.session_id));
      const id = nextId(evidence, 'ph');
      return {
        text: `[${id}]\n${clamp(formatEvents(events))}`,
        evidence: {
          id,
          source: 'posthog',
          summary: `${events.length} events in session ${input.session_id}`,
          data: events,
        },
      };
    }

    case 'posthog_query': {
      const sql = String(input.sql);
      if (/\b(insert|update|delete|drop|alter|create)\b/i.test(sql)) {
        return { text: 'Refused: only read-only SELECT queries are allowed.' };
      }
      const res = await posthog.query(sql);
      const id = nextId(evidence, 'ph');
      const table = [res.columns.join(' | '), ...res.results.slice(0, 50).map((r) => r.join(' | '))].join('\n');
      return {
        text: `[${id}] ${res.results.length} rows\n${clamp(table, 4000)}`,
        evidence: { id, source: 'posthog', summary: `HogQL: ${sql.slice(0, 120)}`, data: res },
      };
    }

    case 'repo_list': {
      const entries = await repo.list(String(input.dir ?? ''));
      return { text: entries.join('\n') || '(empty)' };
    }

    case 'repo_read': {
      const file = String(input.file);
      const content = await repo.read(
        file,
        input.from_line ? Number(input.from_line) : undefined,
        input.to_line ? Number(input.to_line) : undefined,
      );
      const id = nextId(evidence, 'file');
      return {
        text: `[${id}] ${file}\n${clamp(content)}`,
        evidence: { id, source: 'repo', summary: `Read ${file}`, data: { file, content } },
      };
    }

    case 'repo_grep': {
      const hits = await repo.grep(String(input.pattern), input.glob ? String(input.glob) : undefined);
      if (hits.length === 0) return { text: `No matches for /${input.pattern}/.` };
      const id = nextId(evidence, 'grep');
      return {
        text: `[${id}] ${hits.length} matches\n${clamp(hits.join('\n'), 4000)}`,
        evidence: {
          id,
          source: 'repo',
          summary: `grep /${input.pattern}/ -> ${hits.length} hits`,
          data: hits,
        },
      };
    }

    case 'conclude': {
      const rawLines = Array.isArray(input.lines) ? (input.lines as number[]) : null;
      const diagnosis: Diagnosis = {
        cause: String(input.cause),
        file: input.file ? String(input.file) : null,
        lines:
          rawLines && rawLines.length === 2 && rawLines[0] !== undefined && rawLines[1] !== undefined
            ? [rawLines[0], rawLines[1]]
            : null,
        suggested_change: String(input.suggested_change),
        confidence: Number(input.confidence),
        evidence_refs: Array.isArray(input.evidence_refs) ? (input.evidence_refs as string[]) : [],
        affected_users:
          typeof input.affected_users === 'number' && Number.isFinite(input.affected_users)
            ? Math.max(0, Math.round(input.affected_users))
            : null,
      };
      return { text: 'Diagnosis recorded.', terminal: { kind: 'conclude', diagnosis } };
    }

    case 'abstain':
      return {
        text: 'Abstention recorded.',
        terminal: { kind: 'abstain', reason: String(input.reason) },
      };

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

/** Adapt our provider-agnostic ToolDef[] to the OpenAI-compatible function-calling shape. */
export function toOpenAITools(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

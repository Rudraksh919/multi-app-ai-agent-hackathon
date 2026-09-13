import type { ToolDef } from '../clients/llm.js';
import type { ReviewEvidence, ReviewFinding, ReviewResult, ReviewVerdict } from './types.js';
import { clickTarget, readPage, typeInto, type BrowserSession } from './browserTools.js';

export interface ReviewToolOutcome {
  text: string;
  evidence?: ReviewEvidence;
  terminal?: ReviewResult;
}

export const REVIEW_TOOLS: ToolDef[] = [
  {
    name: 'http_request',
    description:
      'Send an HTTP request directly to the running app backend, bypassing the UI — for testing ' +
      'an API route the same way an integration test would (status codes, validation, error ' +
      'bodies). Path is relative to the app root, e.g. "/api/checkout".',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE' },
        path: { type: 'string' },
        body: { type: 'object', description: 'JSON body, if any' },
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the browser to a path relative to the app root, e.g. "/checkout".',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'browser_read',
    description:
      'Read the current page: visible text, plus every clickable element and input field, so you ' +
      'know what you can interact with next. Call this after every navigate/click/type to see what ' +
      'changed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description:
      'Click something on the page, identified by its visible text (e.g. "Add to cart", "Pay now") ' +
      'the way a human would point at it. Falls back to treating the target as a CSS selector.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input, identified by its placeholder, label, or name attribute. Falls back ' +
      'to treating the target as a CSS selector.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' }, text: { type: 'string' } },
      required: ['target', 'text'],
    },
  },
  {
    name: 'submit_review',
    description:
      'Report your verdict on this PR. Only claim something is broken (request_changes, or a ' +
      'finding with severity blocker/major) if you actually observed it fail — a failed http_request, ' +
      'a browser_read that shows an error or a stuck UI state, or code in the diff that contradicts ' +
      'what you observed. Every finding must cite the evidence id(s) that support it. If you tested ' +
      "the relevant paths and they worked, say so — 'approve' is a real, useful outcome.",
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', description: 'approve | request_changes | comment' },
        summary: { type: 'string', description: 'One paragraph: what you tested and what you concluded.' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', description: 'blocker | major | minor | nit' },
              area: { type: 'string', description: 'e.g. "backend", "checkout UI"' },
              description: { type: 'string' },
              evidence_refs: { type: 'array', items: { type: 'string' } },
            },
            required: ['severity', 'area', 'description', 'evidence_refs'],
          },
        },
      },
      required: ['verdict', 'summary', 'findings'],
    },
  },
];

export interface ReviewToolDeps {
  baseUrl: string;
  browser: BrowserSession;
  evidence: ReviewEvidence[];
}

function nextId(evidence: ReviewEvidence[], prefix: string): string {
  const n = evidence.filter((e) => e.id.startsWith(`${prefix}_`)).length + 1;
  return `${prefix}_${String(n).padStart(2, '0')}`;
}

function clamp(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… truncated (${s.length} chars total)`;
}

export async function runReviewTool(
  name: string,
  input: Record<string, unknown>,
  deps: ReviewToolDeps,
): Promise<ReviewToolOutcome> {
  const { baseUrl, browser, evidence } = deps;

  switch (name) {
    case 'http_request': {
      const method = String(input.method ?? 'GET').toUpperCase();
      const path = String(input.path ?? '/');
      const url = new URL(path, baseUrl).toString();

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: input.body ? { 'Content-Type': 'application/json' } : undefined,
          body: input.body ? JSON.stringify(input.body) : undefined,
        });
      } catch (err) {
        return { text: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const bodyText = await res.text().catch(() => '');
      const id = nextId(evidence, 'http');
      return {
        text: `[${id}] ${method} ${path} -> ${res.status}\n${clamp(bodyText)}`,
        evidence: {
          id,
          kind: 'http',
          summary: `${method} ${path} -> ${res.status}`,
          data: { method, path, status: res.status, body: bodyText.slice(0, 2000) },
        },
      };
    }

    case 'browser_navigate': {
      const path = String(input.path ?? '/');
      await browser.page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
      // domcontentloaded fires before client-side hydration finishes — a client component
      // that reads state in a post-mount useEffect (e.g. hydrating from localStorage) hasn't
      // run yet. Reading the page immediately here produces false positives like "empty
      // cart" for state that populates a beat later. Give it a moment, same as browser_click.
      await browser.page.waitForTimeout(400);
      const text = await readPage(browser.page);
      const id = nextId(evidence, 'ui');
      return {
        text: `[${id}] Navigated to ${path}.\n${clamp(text)}`,
        evidence: { id, kind: 'browser', summary: `Navigated to ${path}`, data: text },
      };
    }

    case 'browser_read': {
      const text = await readPage(browser.page);
      const id = nextId(evidence, 'ui');
      return {
        text: `[${id}]\n${clamp(text)}`,
        evidence: { id, kind: 'browser', summary: `Read page ${browser.page.url()}`, data: text },
      };
    }

    case 'browser_click': {
      const target = String(input.target ?? '');
      try {
        const clickText = await clickTarget(browser.page, target);
        await browser.page.waitForTimeout(300); // let the click's effect (nav, state update) settle
        const after = await readPage(browser.page);
        const id = nextId(evidence, 'ui');
        return {
          text: `[${id}] ${clickText}\n${clamp(after)}`,
          evidence: { id, kind: 'browser', summary: `Clicked "${target}"`, data: after },
        };
      } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'browser_type': {
      const target = String(input.target ?? '');
      const value = String(input.text ?? '');
      try {
        const result = await typeInto(browser.page, target, value);
        return { text: result };
      } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'submit_review': {
      const known = new Set(evidence.map((e) => e.id));
      const rawFindings = Array.isArray(input.findings) ? (input.findings as Record<string, unknown>[]) : [];

      const findings: ReviewFinding[] = rawFindings.map((f) => ({
        severity: (['blocker', 'major', 'minor', 'nit'].includes(String(f.severity))
          ? f.severity
          : 'minor') as ReviewFinding['severity'],
        area: String(f.area ?? 'general'),
        description: String(f.description ?? ''),
        evidence_refs: (Array.isArray(f.evidence_refs) ? (f.evidence_refs as string[]) : []).filter((r) =>
          known.has(r),
        ),
      }));

      let verdict = (['approve', 'request_changes', 'comment'].includes(String(input.verdict))
        ? input.verdict
        : 'comment') as ReviewVerdict;

      // Enforcement, not just prompting: a request_changes verdict must be backed by at least
      // one finding that actually cites evidence collected this run. Otherwise it's an opinion,
      // not a test result — downgrade it to a comment rather than let it land as a blocking review.
      const hasCitedSeriousFinding = findings.some(
        (f) => (f.severity === 'blocker' || f.severity === 'major') && f.evidence_refs.length > 0,
      );
      if (verdict === 'request_changes' && !hasCitedSeriousFinding) {
        verdict = 'comment';
      }

      const result: ReviewResult = { verdict, summary: String(input.summary ?? ''), findings };
      return { text: 'Review recorded.', terminal: result };
    }

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

import type { ToolDef } from '../agent/tools.js';
import type { RepoClient } from '../types.js';
import { clickTarget, readPage, typeInto, type BrowserSession } from './browserTools.js';

export interface ImplementToolOutcome {
  text: string;
  terminal?: { summary: string };
}

export const IMPLEMENT_TOOLS: ToolDef[] = [
  {
    name: 'repo_read',
    description: 'Read a source file with line numbers. Read a file before writing it.',
    input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
  {
    name: 'repo_list',
    description: 'List a directory in the checked-out source, repo-relative.',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string', description: "repo-relative, '' for root" } },
      required: ['dir'],
    },
  },
  {
    name: 'repo_grep',
    description: 'Case-insensitive regex search across the source.',
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
    name: 'repo_write',
    description:
      'Overwrite a file with new full contents. Read it first. The live sandbox hot-reloads on ' +
      'write — follow this with an http_request or browser tool to confirm the change actually ' +
      'took effect, not just that it was written. Keep the change minimal and scoped to the ' +
      'instruction — this is not a refactor.',
    input_schema: {
      type: 'object',
      properties: { file: { type: 'string' }, content: { type: 'string' } },
      required: ['file', 'content'],
    },
  },
  {
    name: 'http_request',
    description: 'Send an HTTP request directly to the running app backend. Path is relative to the app root.',
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
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'browser_read',
    description: 'Read the current page: visible text, plus every clickable element and input field.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click something on the page, identified by its visible text.',
    input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input, identified by its placeholder, label, or name attribute.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' }, text: { type: 'string' } },
      required: ['target', 'text'],
    },
  },
  {
    name: 'submit_implementation',
    description:
      'Report the change as complete. Only call this after verifying the fix actually works against ' +
      'the live sandbox (an http_request or browser check that shows the new behavior) — if you ' +
      'could not verify it, say so honestly in the summary rather than claiming success.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What changed, why, and how it was verified.' } },
      required: ['summary'],
    },
  },
];

export interface ImplementToolDeps {
  repo: RepoClient;
  baseUrl: string;
  browser: BrowserSession;
  /** Mutated as files are written; the caller reads this after the loop to know what to commit. */
  written: Map<string, string>;
}

function clamp(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… truncated (${s.length} chars total)`;
}

export async function runImplementTool(
  name: string,
  input: Record<string, unknown>,
  deps: ImplementToolDeps,
): Promise<ImplementToolOutcome> {
  const { repo, baseUrl, browser, written } = deps;

  switch (name) {
    case 'repo_read': {
      const file = String(input.file);
      return { text: await repo.read(file) };
    }

    case 'repo_list': {
      const entries = await repo.list(String(input.dir ?? ''));
      return { text: entries.join('\n') || '(empty)' };
    }

    case 'repo_grep': {
      const hits = await repo.grep(String(input.pattern), input.glob ? String(input.glob) : undefined);
      return { text: hits.length === 0 ? `No matches for /${input.pattern}/.` : hits.join('\n') };
    }

    case 'repo_write': {
      const file = String(input.file);
      const content = String(input.content);
      // Written straight to disk (not buffered) so the sandbox's dev server hot-reloads it —
      // that's what makes live re-verification after a write actually mean something.
      await repo.write(file, content);
      written.set(file, content);
      return { text: `Wrote ${file} (${content.length} chars). Verify with http_request or a browser tool.` };
    }

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
      return { text: `${method} ${path} -> ${res.status}\n${clamp(bodyText)}` };
    }

    case 'browser_navigate': {
      const path = String(input.path ?? '/');
      await browser.page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
      await browser.page.waitForTimeout(400);
      return { text: `Navigated to ${path}.\n${clamp(await readPage(browser.page))}` };
    }

    case 'browser_read':
      return { text: clamp(await readPage(browser.page)) };

    case 'browser_click': {
      try {
        const clickText = await clickTarget(browser.page, String(input.target ?? ''));
        await browser.page.waitForTimeout(300);
        return { text: `${clickText}\n${clamp(await readPage(browser.page))}` };
      } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'browser_type': {
      try {
        return { text: await typeInto(browser.page, String(input.target ?? ''), String(input.text ?? '')) };
      } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'submit_implementation':
      return { text: 'Recorded.', terminal: { summary: String(input.summary ?? '') } };

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

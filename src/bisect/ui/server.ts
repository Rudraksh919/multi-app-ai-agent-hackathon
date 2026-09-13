import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../config.js';
import type { Investigation } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.UI_PORT) || 4321;

interface RunSummary {
  id: string;
  started_at: string;
  symptom: string;
  outcome: Investigation['outcome'];
  confidence: number | null;
  duration_ms: number;
  cost_usd: number;
  tool_calls: number;
}

async function listRuns(): Promise<RunSummary[]> {
  let files: string[];
  try {
    files = (await readdir(CONFIG.runsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const runs = await Promise.all(
    files.map(async (f) => {
      const raw = await readFile(join(CONFIG.runsDir, f), 'utf8');
      const inv = JSON.parse(raw) as Investigation;
      return {
        id: inv.id,
        started_at: inv.started_at,
        symptom: inv.report?.symptom ?? inv.slack.text.slice(0, 100),
        outcome: inv.outcome,
        confidence: inv.diagnosis?.confidence ?? null,
        duration_ms: inv.stats.duration_ms,
        cost_usd: inv.stats.cost_usd,
        tool_calls: inv.stats.tool_calls,
      } satisfies RunSummary;
    }),
  );

  return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

async function getRun(id: string): Promise<Investigation | null> {
  try {
    const raw = await readFile(join(CONFIG.runsDir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as Investigation;
  } catch {
    return null;
  }
}

interface PrRunFile {
  id: string;
  started_at: string;
  pr: { number: number; title: string; htmlUrl: string };
  outcome: string;
  error?: string;
  result?: { verdict: string; summary: string } | null;
  summary?: string | null;
  stats: { duration_ms: number; tool_calls: number; cost_usd: number };
}

interface PrRunSummary {
  id: string;
  kind: 'review' | 'implement';
  started_at: string;
  pr_number: number;
  pr_title: string;
  outcome: string;
  verdict: string | null;
  duration_ms: number;
  cost_usd: number;
  tool_calls: number;
}

function prRunKind(run: PrRunFile): 'review' | 'implement' {
  return run.id.startsWith('pri_') ? 'implement' : 'review';
}

async function listPrRuns(): Promise<PrRunSummary[]> {
  let files: string[];
  try {
    files = (await readdir(CONFIG.prReviewsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const runs = await Promise.all(
    files.map(async (f) => {
      const raw = await readFile(join(CONFIG.prReviewsDir, f), 'utf8');
      const run = JSON.parse(raw) as PrRunFile;
      return {
        id: run.id,
        kind: prRunKind(run),
        started_at: run.started_at,
        pr_number: run.pr.number,
        pr_title: run.pr.title,
        outcome: run.outcome,
        verdict: run.result?.verdict ?? null,
        duration_ms: run.stats.duration_ms,
        cost_usd: run.stats.cost_usd,
        tool_calls: run.stats.tool_calls,
      } satisfies PrRunSummary;
    }),
  );

  return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

async function getPrRun(id: string): Promise<PrRunFile | null> {
  try {
    const raw = await readFile(join(CONFIG.prReviewsDir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as PrRunFile;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/runs') {
      const runs = await listRuns();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(runs));
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
    if (runMatch?.[1]) {
      const inv = await getRun(runMatch[1]);
      if (!inv) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(inv));
      return;
    }

    if (url.pathname === '/api/pr-reviews') {
      const runs = await listPrRuns();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(runs));
      return;
    }

    const prRunMatch = url.pathname.match(/^\/api\/pr-reviews\/([\w-]+)$/);
    if (prRunMatch?.[1]) {
      const run = await getPrRun(prRunMatch[1]);
      if (!run) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(run));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`bisect UI on http://localhost:${PORT}  (reading ${CONFIG.runsDir}/*.json)`);
});

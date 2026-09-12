import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
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

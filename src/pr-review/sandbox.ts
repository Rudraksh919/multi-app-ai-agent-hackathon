import { exec, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { CONFIG } from '../config.js';
import { cloneRepo } from '../clients/github.js';

const run = promisify(exec);

export interface Sandbox {
  dir: string;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`App never answered at ${url} within ${timeoutMs}ms (last: ${lastErr})`);
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${child.pid} /T /F`);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Clone a PR's head branch, `npm install`, boot the dev server on a free port, and block
 * until it actually answers HTTP — a "the code compiles" isn't the same claim as "the app
 * runs", and only the second one is worth testing against.
 */
export async function startSandbox(owner: string, repo: string, branch: string): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-'));
  await cloneRepo(owner, repo, dir, branch);

  await run('npm install', {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
    timeout: CONFIG.prReview.npmInstallTimeoutMs,
  });

  const port = await freePort();
  const child = spawn('npm', ['run', 'dev', '--', '-p', String(port)], {
    cwd: dir,
    stdio: 'ignore',
    shell: true,
    detached: process.platform !== 'win32',
  });

  const baseUrl = `http://localhost:${port}`;

  try {
    await waitForReady(baseUrl, CONFIG.prReview.sandboxReadyTimeoutMs);
  } catch (err) {
    killTree(child);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return {
    dir,
    port,
    baseUrl,
    async stop() {
      killTree(child);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

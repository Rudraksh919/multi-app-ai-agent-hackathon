import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { RepoClient } from '../types.js';
import { env } from '../config.js';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.vercel']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|ya?ml|prisma|sql|html)$/i;

/** Keep every path inside the repo root — the agent chooses these strings. */
function safeJoin(root: string, p: string): string {
  const full = resolve(root, p.replace(/^[/\\]+/, ''));
  const rel = relative(root, full);
  if (rel.startsWith('..') || resolve(root, rel) !== full) {
    throw new Error(`Path escapes repository root: ${p}`);
  }
  return full;
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out, limit);
    else if (TEXT_EXT.test(e.name)) out.push(relative(root, full).split(sep).join('/'));
  }
}

export function makeRepoClient(rootOverride?: string): RepoClient {
  const root = resolve(rootOverride ?? env.repoPath());

  return {
    root() {
      return root;
    },

    async readRaw(file) {
      const target = safeJoin(root, file);
      return readFile(target, 'utf8');
    },

    async write(file, content) {
      const target = safeJoin(root, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    },

    async list(dir) {
      const target = safeJoin(root, dir || '.');
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .filter((e) => !SKIP.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
    },

    async read(file, fromLine, toLine) {
      const target = safeJoin(root, file);
      const info = await stat(target);
      if (info.size > 400_000) throw new Error(`${file} is too large to read (${info.size} bytes)`);

      const lines = (await readFile(target, 'utf8')).split('\n');
      const start = Math.max(1, fromLine ?? 1);
      const end = Math.min(lines.length, toLine ?? lines.length);

      return lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}| ${l}`)
        .join('\n');
    },

    async grep(pattern, glob) {
      // Plain JS rather than shelling out to ripgrep: no external dependency,
      // and the repos we search are small.
      const files: string[] = [];
      await walk(root, root, files, 4000);

      const re = new RegExp(pattern, 'i');
      const globRe = glob ? new RegExp(glob.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')) : null;

      const hits: string[] = [];
      for (const rel of files) {
        if (globRe && !globRe.test(rel)) continue;
        let content: string;
        try {
          content = await readFile(join(root, rel), 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line !== undefined && re.test(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (hits.length >= 60) return hits;
          }
        }
      }
      return hits;
    },
  };
}

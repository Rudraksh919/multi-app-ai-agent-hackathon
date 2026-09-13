import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config.js';
import { cloneRepo, makeGitHubClient, parseGithubRepo } from '../../clients/github.js';
import { makeRepoClient } from '../../clients/repo.js';
import type { GitHubClient, RepoClient } from '../../types.js';

export interface ResolvedRepo {
  repo: RepoClient;
  github: GitHubClient;
  /** "owner/name" if this is a GitHub-backed repo, else null (plain local REPO_PATH). */
  slug: string | null;
}

let cached: Promise<ResolvedRepo> | null = null;
/** Tracked outside the `cached` promise so the exit handler can clean up synchronously
 * without awaiting a promise that may never settle if the process is already dying. */
let clonedDir: string | null = null;
let exitHandlersRegistered = false;

/**
 * Repo access is either:
 *   - GITHUB_REPO="owner/name" — shallow-cloned fresh into a temp dir on first use, so
 *     bisect works against any repo it has a token for, not one fixed local checkout.
 *   - REPO_PATH — a plain local directory, for local dev against acme-shop.
 *
 * Cloning happens once per process and is cached — an investigation loop makes many
 * repo_read/repo_grep calls and re-cloning per call would be wasteful and slow. The clone is
 * deliberately NOT cleaned up between investigations in the long-running poll loop (that
 * would defeat the point of caching); it's cleaned up when the process actually terminates —
 * see registerExitCleanup() — or explicitly via invalidateRepoCache().
 */
export function resolveRepo(): Promise<ResolvedRepo> {
  if (!cached) cached = doResolve();
  return cached;
}

async function doResolve(): Promise<ResolvedRepo> {
  const githubRepo = env.githubRepo();

  if (!githubRepo) {
    const repo = makeRepoClient();
    return { repo, github: makeGitHubClient(null, null, repo), slug: null };
  }

  const { owner, name } = parseGithubRepo(githubRepo);

  const dir = await mktempDir();
  registerExitCleanup();
  try {
    await cloneRepo(owner, name, dir, env.githubBranch());
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  clonedDir = dir;

  const repo = makeRepoClient(dir);
  return { repo, github: makeGitHubClient(owner, name, repo), slug: `${owner}/${name}` };
}

async function mktempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bisect-repo-'));
}

/** Cleans up the clone when the process actually terminates — normal exit, Ctrl+C, or a kill
 * signal — as opposed to between investigations, where the same clone is deliberately reused.
 * Registered lazily, only once there's actually a clone to clean up. */
function registerExitCleanup(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  // 'exit' only allows synchronous work — the final, unconditional safety net regardless of
  // how the process is going down.
  process.on('exit', () => {
    if (clonedDir) rmSync(clonedDir, { recursive: true, force: true });
  });

  // SIGINT/SIGTERM get a plain exit() call, which triggers the 'exit' handler above rather
  // than duplicating the cleanup here.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => process.exit(0));
  }
}

/** Force a fresh clone on the next resolveRepo() call — used after a first-run bootstrap
 * writes bisect-skills/ (see src/bisect/skills/), since commitAndOpenPr() leaves the cached
 * clone checked out on the bootstrap's own branch rather than the repo's normal default
 * branch. */
export async function invalidateRepoCache(): Promise<void> {
  if (!cached) return;
  const { repo, slug } = await cached;
  cached = null;
  clonedDir = null;
  if (slug) {
    await rm(repo.root(), { recursive: true, force: true }).catch(() => {});
  }
}

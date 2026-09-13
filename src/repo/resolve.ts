import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config.js';
import { cloneRepo, makeGitHubClient } from '../clients/github.js';
import { makeRepoClient } from '../clients/repo.js';
import type { GitHubClient, RepoClient } from '../types.js';

export interface ResolvedRepo {
  repo: RepoClient;
  github: GitHubClient;
  /** "owner/name" if this is a GitHub-backed repo, else null (plain local REPO_PATH). */
  slug: string | null;
}

let cached: Promise<ResolvedRepo> | null = null;

/**
 * Repo access is either:
 *   - GITHUB_REPO="owner/name" — shallow-cloned fresh into a temp dir on first use, so
 *     bisect works against any repo it has a token for, not one fixed local checkout.
 *   - REPO_PATH — a plain local directory, for local dev against acme-shop.
 *
 * Cloning happens once per process and is cached — an investigation loop makes many
 * repo_read/repo_grep calls and re-cloning per call would be wasteful and slow.
 */
export function resolveRepo(): Promise<ResolvedRepo> {
  if (!cached) cached = doResolve();
  return cached;
}

/** Accepts "owner/repo", a full https URL, or a git@ URL — whatever someone pastes in. */
export function parseGithubRepo(raw: string): { owner: string; name: string } {
  const cleaned = raw
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  const [owner, name] = cleaned.split('/');
  if (!owner || !name) {
    throw new Error(`GITHUB_REPO must be "owner/repo" or a GitHub URL, got: ${raw}`);
  }
  return { owner, name };
}

async function doResolve(): Promise<ResolvedRepo> {
  const githubRepo = env.githubRepo();

  if (!githubRepo) {
    const repo = makeRepoClient();
    return { repo, github: makeGitHubClient(null, null, repo), slug: null };
  }

  const { owner, name } = parseGithubRepo(githubRepo);

  const dir = await mktempDir();
  await cloneRepo(owner, name, dir, env.githubBranch());
  const repo = makeRepoClient(dir);
  return { repo, github: makeGitHubClient(owner, name, repo), slug: `${owner}/${name}` };
}

async function mktempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bisect-repo-'));
}

/** Force a fresh clone on the next resolveRepo() call — used after a bootstrap PR merges. */
export async function invalidateRepoCache(): Promise<void> {
  if (!cached) return;
  const { repo, slug } = await cached;
  cached = null;
  if (slug) {
    await rm(repo.root(), { recursive: true, force: true }).catch(() => {});
  }
}

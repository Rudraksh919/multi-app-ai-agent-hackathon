import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient, RepoClient } from '../types.js';
import { env } from '../config.js';

const run = promisify(execFile);

/**
 * Auth flags for a single git invocation, via a per-command HTTP header rather than a
 * token embedded in the remote URL. This matters: on machines using Git Credential Manager
 * (Windows' default `credential.helper = manager`), a token baked into a clone URL gets
 * silently cached and then reused for *every* github.com remote afterward — including
 * unrelated repos the user is logged into normally, breaking their own pushes with a
 * wrong-scope 403. `-c credential.helper=` disables the helper for just this process, and
 * `http.extraHeader` supplies the credential directly, so nothing ever touches the OS
 * credential store.
 */
function authFlags(token: string | null): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', [...authFlags(env.githubToken()), ...args], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Shallow-clone `owner/repo` into `destDir`. Plain URL — see authFlags() for why. */
export async function cloneRepo(
  owner: string,
  repo: string,
  destDir: string,
  branch: string | null,
): Promise<string> {
  const url = `https://github.com/${owner}/${repo}.git`;
  const args = [...authFlags(env.githubToken()), 'clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(url, destDir);

  await run('git', args, { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
  return destDir;
}

async function ghApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.githubToken()}`,
      Accept: 'application/vnd.github+json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

export interface GitHubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubPrDetail {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  base: { ref: string; repo: { full_name: string } };
  /** null when the head branch/fork was deleted after the PR was opened. */
  head: { ref: string; sha: string; repo: { full_name: string; owner: { login: string }; name: string } | null };
}

/** The PR's own metadata — used by the one-shot `--pr` CLI path, where a webhook payload isn't available. */
export async function getPr(owner: string, repo: string, prNumber: number): Promise<GitHubPrDetail> {
  return ghApi<GitHubPrDetail>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

/** The changed files with unified-diff patches — the review agent's "what changed" context. */
export async function getPrFiles(owner: string, repo: string, prNumber: number): Promise<GitHubPrFile[]> {
  return ghApi<GitHubPrFile[]>(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
}

/** Post the review verdict as a normal issue comment on the PR. Returns the comment's URL. */
export async function postPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<string> {
  const json = await ghApi<{ html_url: string }>(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return json.html_url;
}

async function defaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    return 'main';
  }
}

export function makeGitHubClient(owner: string | null, repo: string | null, repoClient: RepoClient): GitHubClient {
  return {
    available() {
      return Boolean(env.githubToken() && owner && repo);
    },

    async commitAndOpenPr({ branch, title, body, files }) {
      if (!this.available() || !owner || !repo) return null;
      const cwd = repoClient.root();

      for (const f of files) {
        await repoClient.write(f.path, f.content);
      }

      const base = await defaultBranch(cwd);
      await git(['checkout', '-b', branch], cwd);
      await git(['add', ...files.map((f) => f.path)], cwd);
      await git(['-c', 'user.email=bisect@local', '-c', 'user.name=bisect', 'commit', '-m', title], cwd);
      await git(['push', 'origin', branch], cwd);

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.githubToken()}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, head: branch, base, body }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub PR create -> ${res.status}: ${text.slice(0, 400)}`);
      }

      const json = (await res.json()) as { html_url: string };
      return json.html_url;
    },
  };
}

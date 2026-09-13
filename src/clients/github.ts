import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient, RepoClient } from '../types.js';
import { resolveGithubToken, githubAuthConfigured } from './githubAuth.js';

const run = promisify(execFile);

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

/**
 * Auth for a single git invocation, via a per-command HTTP header rather than a token
 * embedded in the remote URL. This matters: on machines using Git Credential Manager
 * (Windows' default `credential.helper = manager`), a token baked into a clone URL gets
 * silently cached and then reused for *every* github.com remote afterward — including
 * unrelated repos the user is logged into normally, breaking their own pushes with a
 * wrong-scope 403.
 *
 * Passed as environment variables (git's GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n mechanism),
 * NOT as `-c` CLI flags — this is load-bearing, not a style choice. A flag value lives in
 * argv, and argv is exactly what a failed child_process call dumps into its Error.message
 * for debugging. That's how an installation token once ended up posted in full, in plain
 * text, as a public PR comment: a clone failure's error text got logged and forwarded
 * upstream with the credential still embedded in it. Env vars aren't included in that dump.
 */
async function gitAuthEnv(): Promise<NodeJS.ProcessEnv> {
  const token = await resolveGithubToken();
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.extraHeader',
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
  };
}

/** Belt-and-suspenders: even with the credential out of argv, redact anything that still
 * looks like a bearer/basic credential before an error ever leaves this module — this is
 * what stands between a future mistake here and another public leak. */
function sanitizeGitError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = message.replace(/(Basic|Bearer|token)[=:\s]+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 [redacted]');
  return new Error(redacted);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(await gitAuthEnv()) },
    });
    return stdout.trim();
  } catch (err) {
    throw sanitizeGitError(err);
  }
}

/** Shallow-clone `owner/repo` into `destDir`. Plain URL — see gitAuthEnv() for why the
 * credential lives in the environment, not here or in the URL. */
export async function cloneRepo(
  owner: string,
  repo: string,
  destDir: string,
  branch: string | null,
): Promise<string> {
  const url = `https://github.com/${owner}/${repo}.git`;
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(url, destDir);

  try {
    await run('git', args, {
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(await gitAuthEnv()) },
    });
  } catch (err) {
    throw sanitizeGitError(err);
  }
  return destDir;
}

async function ghApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await resolveGithubToken();
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
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

/** React to a comment (e.g. 👀 to ack a "@bisect review" mention before the multi-minute review runs). */
export async function reactToComment(owner: string, repo: string, commentId: number, content: string): Promise<void> {
  await ghApi(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
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
      return Boolean(githubAuthConfigured() && owner && repo);
    },

    async commitAndOpenPr({ branch, title, body, files, base: baseOverride }) {
      if (!this.available() || !owner || !repo) return null;
      const cwd = repoClient.root();

      for (const f of files) {
        await repoClient.write(f.path, f.content);
      }

      const base = baseOverride ?? (await defaultBranch(cwd));
      await git(['checkout', '-b', branch], cwd);
      await git(['add', ...files.map((f) => f.path)], cwd);
      await git(['-c', 'user.email=bisect@local', '-c', 'user.name=bisect', 'commit', '-m', title], cwd);
      await git(['push', 'origin', branch], cwd);

      const json = await ghApi<{ html_url: string }>(`/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title, head: branch, base, body }),
      });

      return json.html_url;
    },
  };
}

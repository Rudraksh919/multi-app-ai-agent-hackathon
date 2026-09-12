import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient, RepoClient } from '../types.js';
import { env } from '../config.js';

const run = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Shallow-clone `owner/repo` into `destDir`. If a token is present it's baked into the
 * remote URL, so a later `git push` from that same clone just works — this is a scratch
 * checkout, not a long-lived one, so an embedded credential in .git/config is fine.
 */
export async function cloneRepo(
  owner: string,
  repo: string,
  destDir: string,
  branch: string | null,
): Promise<string> {
  const token = env.githubToken();
  const auth = token ? `x-access-token:${token}@` : '';
  const url = `https://${auth}github.com/${owner}/${repo}.git`;

  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(url, destDir);

  await run('git', args, { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
  return destDir;
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

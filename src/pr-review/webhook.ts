import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env, CONFIG } from '../config.js';
import { reactToComment } from '../clients/github.js';
import { runPrReview } from './run.js';
import { prInfoFromNumber } from './lookup.js';
import type { PrInfo } from './types.js';

/** Matches "@bisect", "@bisect review", etc. — same mention pattern GitHub's own bots use. */
const MENTION = /@bisect\b/i;

function verifySignature(payload: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface GitHubPullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    title: string;
    body: string | null;
    html_url: string;
    base: { ref: string; repo: { owner: { login: string }; name: string } };
    head: { ref: string; sha: string; repo: { owner: { login: string }; name: string } | null };
  };
}

/** GitHub models a PR comment as an "issue comment" — `issue.pull_request` is only present
 * when the issue being commented on is actually a PR. */
interface GitHubIssueCommentEvent {
  action: string;
  comment: { id: number; body: string };
  issue: { number: number; pull_request?: unknown };
  repository: { owner: { login: string }; name: string };
}

/** synchronize = a new commit was pushed to an already-open PR — re-review it. */
const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

function toPrInfo(payload: GitHubPullRequestEvent): PrInfo {
  const pr = payload.pull_request;
  const headRepo = pr.head.repo; // null if the source branch/fork was deleted
  return {
    number: payload.number,
    title: pr.title,
    body: pr.body,
    htmlUrl: pr.html_url,
    baseOwner: pr.base.repo.owner.login,
    baseRepo: pr.base.repo.name,
    headOwner: headRepo?.owner.login ?? pr.base.repo.owner.login,
    headRepo: headRepo?.name ?? pr.base.repo.name,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
  };
}

export function startWebhookServer(): void {
  const secret = env.githubWebhookSecret();
  if (!secret) {
    console.error(
      'GITHUB_WEBHOOK_SECRET is not set — refusing to start (would accept unsigned/unverifiable payloads).',
    );
    process.exit(1);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/webhook') {
        res.writeHead(404).end();
        return;
      }

      const body = await readBody(req);
      const signatureHeader = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

      if (!verifySignature(body, signature, secret)) {
        console.warn('rejected webhook delivery: bad or missing signature');
        res.writeHead(401).end('bad signature');
        return;
      }

      const event = req.headers['x-github-event'];
      let raw: unknown;
      try {
        raw = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400).end('invalid JSON');
        return;
      }

      if (event === 'pull_request') {
        const payload = raw as GitHubPullRequestEvent;
        if (!HANDLED_ACTIONS.has(payload.action)) {
          res.writeHead(202).end(`ignored (action: ${payload.action})`);
          return;
        }

        // Respond immediately — cloning, installing, booting, and testing the PR takes minutes,
        // far past what GitHub's webhook delivery waits for before marking it timed out.
        res.writeHead(202).end('reviewing');

        const pr = toPrInfo(payload);
        runPrReview(pr).catch((err) => {
          console.error(`PR review crashed for #${pr.number}:`, err);
        });
        return;
      }

      if (event === 'issue_comment') {
        const payload = raw as GitHubIssueCommentEvent;
        const isOnPr = Boolean(payload.issue.pull_request);
        const mentioned = MENTION.test(payload.comment.body);
        // Guard against reviewing our own review comments if they ever happened to match —
        // they never say "@bisect", but this is cheap insurance against a future feedback loop.
        const isOwnComment = payload.comment.body.includes('🤖 bisect review');

        if (payload.action !== 'created' || !isOnPr || !mentioned || isOwnComment) {
          res.writeHead(202).end('ignored');
          return;
        }

        res.writeHead(202).end('reviewing');

        const { owner, name } = { owner: payload.repository.owner.login, name: payload.repository.name };
        const prNumber = payload.issue.number;

        reactToComment(owner, name, payload.comment.id, 'eyes').catch(() => {});
        prInfoFromNumber(owner, name, prNumber)
          .then((pr) => runPrReview(pr))
          .catch((err) => {
            console.error(`PR review crashed for #${prNumber} (mention trigger):`, err);
          });
        return;
      }

      res.writeHead(202).end('ignored (unhandled event type)');
    })();
  });

  server.listen(CONFIG.prReview.port, () => {
    console.log(`bisect PR-review webhook listening on :${CONFIG.prReview.port}/webhook`);
    console.log(
      'Point a GitHub webhook (Settings -> Webhooks) at a public URL for this path, content type ' +
        'application/json, events: Pull requests, secret matching GITHUB_WEBHOOK_SECRET.',
    );
  });
}

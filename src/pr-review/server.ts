import { env } from '../config.js';
import { getPr } from '../clients/github.js';
import { parseGithubRepo } from '../repo/resolve.js';
import { startWebhookServer } from './webhook.js';
import { runPrReview } from './run.js';
import type { PrInfo } from './types.js';

/** Ad-hoc mode: review one existing PR directly, no webhook or public URL required. */
async function runOnce(prNumber: number): Promise<void> {
  const githubRepo = env.githubRepo();
  if (!githubRepo) throw new Error('GITHUB_REPO must be set to use --pr.');
  const { owner, name } = parseGithubRepo(githubRepo);

  const detail = await getPr(owner, name, prNumber);
  const pr: PrInfo = {
    number: detail.number,
    title: detail.title,
    body: detail.body,
    htmlUrl: detail.html_url,
    baseOwner: owner,
    baseRepo: name,
    headOwner: detail.head.repo?.owner.login ?? owner,
    headRepo: detail.head.repo?.name ?? name,
    headRef: detail.head.ref,
    headSha: detail.head.sha,
  };

  const run = await runPrReview(pr);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`outcome: ${run.outcome}${run.result ? ` (${run.result.verdict})` : ''}`);
  if (run.result) {
    console.log(`summary: ${run.result.summary}`);
    for (const f of run.result.findings) {
      console.log(`  [${f.severity}] ${f.area}: ${f.description}`);
    }
  }
  if (run.comment_url) console.log(`comment: ${run.comment_url}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const prIdx = argv.indexOf('--pr');

  if (prIdx >= 0) {
    const num = Number(argv[prIdx + 1]);
    if (!Number.isFinite(num)) throw new Error('--pr requires a PR number, e.g. --pr 3');
    runOnce(num).catch((err) => {
      console.error(err);
      process.exit(1);
    });
    return;
  }

  startWebhookServer();
}

main();

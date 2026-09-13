import { env } from '../config.js';
import { parseGithubRepo } from '../repo/resolve.js';
import { startWebhookServer } from './webhook.js';
import { runPrReview, runPrImplement } from './run.js';
import { prInfoFromNumber, isImplementIntent } from './lookup.js';

/** Ad-hoc mode: review (or implement on) one existing PR directly, no webhook or public URL
 * required — the same routing an "@bisect ..." comment would trigger, for local testing. */
async function runOnce(prNumber: number, instruction?: string): Promise<void> {
  const githubRepo = env.githubRepo();
  if (!githubRepo) throw new Error('GITHUB_REPO must be set to use --pr.');
  const { owner, name } = parseGithubRepo(githubRepo);

  const pr = await prInfoFromNumber(owner, name, prNumber);

  if (instruction && isImplementIntent(instruction)) {
    const run = await runPrImplement(pr, instruction);
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`outcome: ${run.outcome}`);
    if (run.summary) console.log(`summary: ${run.summary}`);
    if (run.follow_up_pr_url) console.log(`follow-up PR: ${run.follow_up_pr_url}`);
    if (run.comment_url) console.log(`comment: ${run.comment_url}`);
    return;
  }

  const run = await runPrReview(pr, instruction);

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

    const instructionIdx = argv.indexOf('--instruction');
    const instruction = instructionIdx >= 0 ? argv[instructionIdx + 1] : undefined;

    runOnce(num, instruction).catch((err) => {
      console.error(err);
      process.exit(1);
    });
    return;
  }

  startWebhookServer();
}

main();

import { getPr } from '../clients/github.js';
import type { PrInfo } from './types.js';

/** "@bisect implement X", "fix the ...", "can you patch ..." — anything that reads as asking
 * for a code change. Anything else (including no instruction at all) is a review request,
 * optionally scoped by whatever text was given. Shared between the webhook's "@bisect" comment
 * handler and the `--pr --instruction` CLI path so both route identically. */
const IMPLEMENT_INTENT = /\b(implement|fix|patch|write the|make the change|add|remove|update)\b/i;

export function isImplementIntent(instruction: string): boolean {
  return instruction.trim().length > 0 && IMPLEMENT_INTENT.test(instruction);
}

/** Fetch a PR's full metadata from the GitHub API and shape it into a PrInfo — used wherever
 * we only have an owner/repo/number (a comment mention, the `--pr` CLI flag) rather than a
 * full webhook payload that already carries base/head refs. */
export async function prInfoFromNumber(owner: string, repo: string, prNumber: number): Promise<PrInfo> {
  const detail = await getPr(owner, repo, prNumber);
  return {
    number: detail.number,
    title: detail.title,
    body: detail.body,
    htmlUrl: detail.html_url,
    baseOwner: owner,
    baseRepo: repo,
    headOwner: detail.head.repo?.owner.login ?? owner,
    headRepo: detail.head.repo?.name ?? repo,
    headRef: detail.head.ref,
    headSha: detail.head.sha,
  };
}

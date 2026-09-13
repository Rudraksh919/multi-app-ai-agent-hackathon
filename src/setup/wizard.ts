/**
 * Interactive setup for pointing bisect at your own repo, Slack workspace, Linear team, and
 * observability stack. Everything typed here is written straight to your local .env and never
 * leaves this machine — this script makes no network calls of its own. (Input isn't masked as
 * you type — keeping this to plain readline avoids fighting raw-mode stdin across terminals —
 * so make sure nothing's shoulder-surfing your screen while you paste keys in.)
 *
 * Run with: npm run setup
 */
import { createInterface } from 'node:readline/promises';
import { upsertEnvVar } from './envFile.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(`${question} (${suffix}) `);
  if (!answer) return defaultYes;
  return /^y/i.test(answer);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

async function setIfProvided(key: string, value: string): Promise<void> {
  if (value) await upsertEnvVar(key, value);
}

async function main(): Promise<void> {
  console.log(
    'bisect setup — a few questions, written straight to your local .env.\n' +
      'Blank answers are skipped (fill them in later, or re-run this anytime).',
  );

  section('OpenRouter — every LLM call');
  console.log('Free tier: openrouter.ai/keys. Add a second key later for automatic failover');
  console.log('(OPENROUTER_API_KEYS, comma-separated) if the free tier rate-limits you.');
  await setIfProvided('OPENROUTER_API_KEY', await ask('OpenRouter API key: '));

  section('Slack — where bug reports come from');
  console.log('api.slack.com/apps → your app → OAuth & Permissions. Scopes: channels:history,');
  console.log('chat:write, channels:read, reactions:read. Then /invite the bot into the channel');
  console.log('it should watch — every call 403s otherwise.');
  await setIfProvided('SLACK_BOT_TOKEN', await ask('Slack bot token (xoxb-...): '));
  await setIfProvided('SLACK_CHANNEL_ID', await ask('Slack channel ID (right-click channel → View details): '));

  section('Linear — where diagnoses get filed as tickets');
  console.log('Linear → Settings → API → Personal API keys.');
  await setIfProvided('LINEAR_API_KEY', await ask('Linear API key: '));
  await setIfProvided('LINEAR_TEAM_ID', await ask('Linear team ID (blank = your default team): '));

  section('The repo bisect investigates and pr-manager reviews');
  const repo = await ask('GitHub repo (owner/repo, or a full github.com URL): ');
  await setIfProvided('GITHUB_REPO', repo);
  if (!repo) {
    console.log('No repo given — set REPO_PATH in .env instead for local-only dev against a checkout.');
  }

  section('GitHub write access');
  console.log('Needed for: opening bisect-skills/ as a PR, auto-implement → PR, and pr-manager');
  console.log('posting review comments.');
  const useApp = await askYesNo(
    'Set up a real GitHub App identity afterward (comments post as a bot, not your account)?',
    true,
  );
  if (useApp) {
    console.log('OK — run `npm run setup:github-app` once this finishes.');
  } else {
    await setIfProvided('GITHUB_TOKEN', await ask('GitHub personal access token (repo write scope): '));
  }

  section('PostHog — product/UI bug traces (optional)');
  if (await askYesNo('Configure PostHog now?', true)) {
    console.log('PostHog → Settings → Personal API keys. Must be phx_... (personal key), not phc_...');
    await setIfProvided('POSTHOG_API_KEY', await ask('PostHog API key: '));
    await setIfProvided('POSTHOG_PROJECT_ID', await ask('PostHog project ID: '));
  } else {
    console.log('Skipped — add POSTHOG_API_KEY / POSTHOG_PROJECT_ID to .env whenever you want it.');
  }

  section('Sentry — crash/exception traces (optional)');
  if (await askYesNo('Configure Sentry now?', false)) {
    console.log('Sentry → Settings → Auth Tokens, scopes project:read + event:read.');
    await setIfProvided('SENTRY_AUTH_TOKEN', await ask('Sentry auth token: '));
    await setIfProvided('SENTRY_ORG', await ask('Sentry org slug: '));
    await setIfProvided('SENTRY_PROJECT', await ask('Sentry project slug: '));
  } else {
    console.log('Skipped — codebases without Sentry configured just get an honest "not configured"');
    console.log('response from the sentry_* tools rather than an error.');
  }

  rl.close();

  console.log(`\n${'─'.repeat(70)}`);
  console.log('.env written. Next:');
  if (useApp) console.log('  npm run setup:github-app                                    one-click bot identity');
  console.log('  npm run start -- --text "checkout is broken for jane@..."  fast dry-run, no Slack needed');
  console.log('  npm run dev                                                 the real thing: polls Slack');
  console.log('  npx tsx src/pr-review/server.ts --pr <N>                    review one PR directly');
  console.log('\nSee README.md for the rest of it.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

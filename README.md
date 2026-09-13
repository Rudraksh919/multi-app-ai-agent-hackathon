# bisect

bisect is two agents sharing one codebase-agnostic core, built around a single rule: a claim
needs evidence, or it doesn't get made.

- **bisect** (the investigator) takes a bug report from Slack, finds the reporting user's real
  session in PostHog and/or their real crash in Sentry, reads the actual source code that
  handled that request, and only then produces a diagnosis, cited against the specific
  evidence ids that support it. If the trace and the code do not add up to an explanation, it
  says exactly what it looked at and what was missing instead of guessing. It then files a
  Linear ticket and, above a confidence bar and with a human's Slack approval, can write the fix
  itself and open a real PR.
- **pr-manager** (the reviewer) takes a GitHub pull request, clones its branch into a sandbox,
  runs `npm install`, boots the dev server, and actually uses the running app: hitting API
  routes directly and driving a real browser through the UI, before writing a review. A human
  can also ask it for more via an `@bisect ...` PR comment, either a scoped re-review or an
  actual code change, live-verified in the same sandbox before it opens a follow-up PR.

Neither agent is wired to one fixed codebase. The first time bisect looks at a repo it maps
which observability services that repo actually uses and writes a small, reusable routing skill
into it (`bisect-skills/`), so every bug report after that routes straight to "query PostHog
like this" instead of rediscovering the codebase from scratch. `npm run setup` is the guided
path to pointing either agent at your own repo, your own Slack, your own Linear team, your own
PostHog/Sentry project.

## Demo video

[Demo video](https://drive.google.com/drive/folders/1Owqc2kI3GZt7kysIOSOo-6gG5hH-hmUz)

## How the pieces fit together

```
bisect:      Slack (#bugs) -> parse -> [route or map] -> [ investigation loop ] -> Linear + Slack
                                                              tools: PostHog, Sentry, repo read/grep
                                                                  |  (if confident + approved in Slack)
                                                                  v
                                                        [ implement agent ] -> PR on GitHub

pr-manager:  PR opened -> clone + npm install + boot -> [ live-tested review ] -> PR comment
                                                              tools: http_request, real browser
                                                                  |  ("@bisect fix ..." on the PR)
                                                                  v
                                                        [ implement agent, same sandbox ] -> follow-up PR
```

Two rules are enforced in code, not just asked for in a prompt:

1. **Every diagnosis and every review finding cites evidence.** `conclude()` in
   [src/bisect/agent/investigate.ts](src/bisect/agent/investigate.ts) and `submit_review()` in
   [src/pr-manager/tools.ts](src/pr-manager/tools.ts) both filter their claims against evidence
   ids that were actually collected during the run. An uncited claim is discarded regardless of
   what the model said.
2. **Abstention is a first-class outcome.** `DIAGNOSED`, `NO_SESSION`, `NO_DIAGNOSIS`, and
   `SKIPPED` are all valid results for bisect. `approve`, `request_changes`, and `comment` are
   all valid verdicts for pr-manager. "I found the session, the checkout succeeded, I cannot
   reproduce the complaint" is a more useful ticket than a plausible guess.

## Requirements

- Node.js 18 or newer (the codebase uses the built-in `fetch` and `node:readline/promises`,
  both of which need a reasonably current Node).
- git, available on your PATH.
- npm.
- A Slack workspace, a Linear workspace, and the GitHub repository you want to point either
  agent at. PostHog and Sentry are optional, per codebase.

## Installation

```bash
git clone https://github.com/Rudraksh919/multi-app-ai-agent-hackathon
cd multi-app-ai-agent-hackathon
npm install
```

`pr-manager` drives a real Chromium browser via Playwright. `npm install` normally downloads the
browser binary automatically; if the review or implement agent later fails to launch a browser,
run:

```bash
npx playwright install chromium
```

## Setup

The fastest path is the interactive wizard:

```bash
npm run setup
```

It asks for OpenRouter, Slack, Linear, the repo to work on, and optionally PostHog and Sentry,
then writes everything straight to a local `.env` file. Nothing it collects leaves your machine;
the script makes no network calls of its own. Blank answers are skipped, so it is safe to run it
once, fill in what you have, and re-run it later to add the rest. Input is not masked as you
type, so make sure nothing is reading your screen while you paste keys in.

If you would rather edit `.env` by hand, copy `.env.example` to `.env` and fill it in; every
variable there is documented with where to get it. The rest of this section walks through each
service in more detail than the wizard has room for.

### OpenRouter (required, every LLM call)

1. Go to [openrouter.ai/keys](https://openrouter.ai/keys) and sign up or log in.
2. Create a key. Copy it into `OPENROUTER_API_KEY` in `.env`.

The models configured in [src/config.ts](src/config.ts) are all free-tier Nemotron models
(`nvidia/nemotron-3.5-lightning:free` and `nvidia/nemotron-3-super-120b-a12b:free`), so running
this costs nothing in API fees as shipped. Free-tier models occasionally return a "temporarily
overloaded" response. Two ways to work around that:

- **Multiple keys.** Set `OPENROUTER_API_KEYS` to a comma-separated list of keys (for example
  from separate free accounts). Every LLM call tries them in order until one answers, and a key
  that reports an exhausted daily free quota is temporarily skipped for the rest of the run.
  `OPENROUTER_API_KEYS` takes priority over the single `OPENROUTER_API_KEY` if both are set.
- **A local Ollama fallback.** Install [Ollama](https://ollama.com), pull a tool-calling capable
  model, and point bisect at it:

  ```bash
  ollama pull qwen3:4b
  ```

  ```
  OLLAMA_MODEL=qwen3:4b
  OLLAMA_BASE_URL=http://localhost:11434/v1
  ```

  Ollama is only tried after every configured OpenRouter key has failed for that call, so it is
  a safety net, not a replacement.

### Slack (required, where bug reports come from)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or use an
   existing one) "from scratch," in the workspace you want to watch.
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `channels:history` (read messages in the channel)
   - `chat:write` (post replies and Block Kit messages)
   - `channels:read` (resolve channel info)
   - `reactions:read` (needed for the "implement this fix?" approval poll)
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`) into
   `SLACK_BOT_TOKEN`.
4. In Slack, right-click the channel you want bisect to watch and choose **View channel
   details**; the channel ID is at the bottom of that panel. Put it in `SLACK_CHANNEL_ID`.
5. `/invite @your-bot-name` into that channel. Every Slack call 403s with `not_in_channel`
   otherwise, which is the most common first-run failure.

### Linear (required, where diagnoses get filed)

1. In Linear, go to **Settings > API > Personal API keys** and create one.
2. Put it in `LINEAR_API_KEY`.
3. `LINEAR_TEAM_ID` is optional. If you leave it blank, bisect uses whichever team your API key
   sees first. Set it explicitly if your workspace has more than one team and you want tickets
   filed somewhere specific.

### The repository bisect investigates and pr-manager reviews

Set exactly one of these:

- `GITHUB_REPO`, as `owner/repo` or a full GitHub URL. bisect shallow-clones this repo fresh on
  first use and caches the clone for the life of the process. This is what lets bisect work on
  any repo the configured token can read, not one fixed local checkout.
- `REPO_PATH`, a plain local directory (a checkout you already have on disk). Useful for local
  development against a fixture app without needing GitHub access at all.

If both are set, `GITHUB_REPO` wins. `GITHUB_BASE_BRANCH` is optional and only needed if the
repo's default branch is not the one you want cloned or opened against.

`pr-manager` assumes an `npm install && npm run dev`-shaped repo (see
[src/pr-manager/sandbox.ts](src/pr-manager/sandbox.ts)): it works well for Next.js/React-style
apps, and less well for a fundamentally different install/boot story. A different package
manager's lockfile is fine; a non-Node stack is not, today.

### GitHub write access

Write access is needed for opening `bisect-skills/` as a PR, the auto-implement to PR path, and
for pr-manager posting review comments and follow-up PRs. Pick one:

**Option A: a real GitHub App identity (recommended).** This makes every comment, commit, and PR
show up under its own bot account rather than a human's personal token. Run:

```bash
npm run setup:github-app
```

This starts a tiny local server and prints a `localhost` URL to open in a browser you are logged
into GitHub with. It walks through GitHub's "manifest flow":

1. Opening the printed URL redirects you straight to GitHub's "Create GitHub App" confirmation
   page, with every field (name, permissions, events) already filled in by the script. Click
   **Create GitHub App**, the one step that has to be a real, deliberate click from you, since
   creating an App is an account-level authorization grant.
2. GitHub redirects back to the local server with everything needed to finish setup. The
   script downloads the App's private key to `.github-app-key.pem` and writes `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY_PATH`, and `GITHUB_WEBHOOK_SECRET` into `.env` automatically.
3. It then prints an "Install" link. Click it and install the App on whichever repo (or repos,
   or your whole account) you want bisect and pr-manager to have write access to.
4. The script polls in the background and, once it sees the installation, writes
   `GITHUB_APP_INSTALLATION_ID` into `.env` on its own. Setup is then complete.

If it times out waiting for the install, just install the App manually from its GitHub settings
page and re-run the script; it picks up the existing App rather than creating a new one. Delete
`GITHUB_APP_ID` from `.env` first if you actually want a brand new App.

Note that write access is one App/token for however many repos you point `GITHUB_REPO` at. The
App itself is installed per-repo (or per-org) from its own GitHub settings page, so install it
on every repository you want either agent to write to.

**Option B: a plain personal access token.** Simpler, but every action shows up as your own
account. Create a classic token with the `repo` scope (or a fine-grained token with Contents:
Read and write, and Pull requests: Read and write, on the repos you need), and put it in
`GITHUB_TOKEN`. If the App variables above are all unset, `GITHUB_TOKEN` is what every GitHub
API call and git push authenticates with.

### PostHog (optional, product and UI bug traces)

1. In PostHog, go to **Settings > Personal API keys** and create one. It must start with `phx_`.
   The project write key that starts with `phc_` will not work here; that key is for sending
   events into PostHog, not querying them.
2. Put the key in `POSTHOG_API_KEY`.
3. Your project ID is visible in the project's URL or under **Settings > Project**. Put it in
   `POSTHOG_PROJECT_ID`.
4. `POSTHOG_HOST` defaults to `https://us.posthog.com`. Change it if your PostHog instance is
   self-hosted or on the EU cloud.
5. Optionally set `TARGET_APP_URL` to the deployed app you are investigating, for example
   `https://your-app.vercel.app`. When set, every person and session lookup, and the
   investigation agent's own raw HogQL queries, are restricted to that host's events, so local
   development traffic never gets mixed into a production-shaped bug report.

### Sentry (optional, crash and exception traces)

1. In Sentry, go to **Settings > Auth Tokens** and create one with the `project:read` and
   `event:read` scopes.
2. Put it in `SENTRY_AUTH_TOKEN`, and set `SENTRY_ORG` and `SENTRY_PROJECT` to your
   organization and project slugs (both visible in the Sentry URL for that project).
3. `SENTRY_HOST` defaults to `https://sentry.io`. Change it for a self-hosted instance.

If Sentry is left unset, the `sentry_*` tools tell the investigating agent that Sentry is not
configured for this codebase, rather than throwing an error. Whether a given bug even calls
those tools is decided by the routing skill, `bisect-skills/`, described below.

### GitHub webhook (only needed for pr-manager's live "opened" auto-review)

Set `GITHUB_WEBHOOK_SECRET` to a secret string, then configure it on the repo:

1. On GitHub, go to the repo's **Settings > Webhooks > Add webhook**.
2. Set the Payload URL to `https://your-public-host/webhook`.
3. Content type: `application/json`.
4. Secret: the same value as `GITHUB_WEBHOOK_SECRET`.
5. Under "Which events would you like to trigger this webhook," choose individual events and
   select both **Pull requests** and **Issue comments**. Pull request events trigger the
   automatic review when a PR is opened; issue comment events are what let an `@bisect ...`
   comment trigger a follow-up review or an implement request.

`PR_REVIEW_PORT` (default `4322`) is the local port the webhook server listens on. For local
development, point a tunnel such as ngrok at that port and use the tunnel's URL as the webhook's
Payload URL. The server refuses to start at all if `GITHUB_WEBHOOK_SECRET` is unset, since it
would otherwise accept unsigned, unverifiable payloads.

## Environment variable reference

| Variable | Required | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | yes, unless `OPENROUTER_API_KEYS` is set | openrouter.ai/keys |
| `OPENROUTER_API_KEYS` | no | comma-separated, tried in order, overrides the single key |
| `OLLAMA_MODEL` | no | enables the local fallback when set, e.g. `qwen3:4b` |
| `OLLAMA_BASE_URL` | no | defaults to `http://localhost:11434/v1` |
| `SLACK_BOT_TOKEN` | yes | `xoxb-...`, bot token scopes above |
| `SLACK_CHANNEL_ID` | yes | the channel bisect polls |
| `LINEAR_API_KEY` | yes | Linear Settings > API > Personal API keys |
| `LINEAR_TEAM_ID` | no | blank uses your default team |
| `GITHUB_REPO` | one of these two | `owner/repo` or a full URL, clones fresh |
| `REPO_PATH` | one of these two | a local checkout path, no clone |
| `GITHUB_BASE_BRANCH` | no | blank uses the repo's default branch |
| `GITHUB_TOKEN` | no, unless not using a GitHub App | classic PAT with `repo` scope |
| `GITHUB_APP_ID` | no | written by `npm run setup:github-app` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | no | written by `npm run setup:github-app` |
| `GITHUB_APP_INSTALLATION_ID` | no | written by `npm run setup:github-app` |
| `GITHUB_WEBHOOK_SECRET` | only for the webhook server | HMAC secret for `/webhook` |
| `PR_REVIEW_PORT` | no | defaults to `4322` |
| `POSTHOG_API_KEY` | no | `phx_...`, a personal key, not `phc_...` |
| `POSTHOG_PROJECT_ID` | no | required if `POSTHOG_API_KEY` is set |
| `POSTHOG_HOST` | no | defaults to `https://us.posthog.com` |
| `TARGET_APP_URL` | no | scopes PostHog queries to one deployed host |
| `SENTRY_AUTH_TOKEN` | no | Sentry Settings > Auth Tokens |
| `SENTRY_ORG` / `SENTRY_PROJECT` | no | required if `SENTRY_AUTH_TOKEN` is set |
| `SENTRY_HOST` | no | defaults to `https://sentry.io` |

## Running bisect

The real thing, polling Slack continuously:

```bash
npm run dev      # tsx watch, restarts on file changes
npm run start    # same thing, no watch
npm run once     # process whatever is new in the channel once, then exit
```

The local dashboard, reading everything under `runs/` and `pr-reviews/`:

```bash
npm run ui       # http://localhost:4321
```

It has two tabs: **Investigations** (bisect's runs) and **PR Reviews** (pr-manager's reviews and
implement runs). The PR Reviews tab shows a stats bar (approved, changes requested, fixes
implemented, average duration, total cost), a list of PRs with their verdict or outcome, and a
detail view with findings cited against evidence, or, for an implement run, the files changed and
a link to the follow-up PR.

Fast dev loop, skipping Slack and Linear entirely and printing the would-be ticket to stdout:

```bash
npm run start -- --text "checkout is broken for jane@acme.com, she says it just spins after clicking pay"
```

Add `--auto-implement` to the same command to also exercise the implement to PR path, without
waiting on a live Slack reaction:

```bash
npm run start -- --text "..." --auto-implement
```

### What happens on each message

1. **Listen.** bisect polls `SLACK_CHANNEL_ID` for new messages.
2. **Parse.** An LLM call in [src/bisect/steps/parse.ts](src/bisect/steps/parse.ts) turns the raw
   text into a structured `{ is_bug_report, symptom, email, window, entities }`. Messages that
   are not actual bug reports (chatter, questions, status updates) are skipped here.
3. **Route or map.** The first time bisect looks at a given repo, there is no
   `bisect-skills/skill.md` yet, so it runs a one-time discovery pass (see below) before
   investigating anything. Every time after, it reads that file instead of rediscovering the
   codebase from scratch.
4. **Investigate.** An agentic tool-use loop decides its own path through PostHog, Sentry, and
   the repository, the way a person debugging the issue would follow one lead into the next.
5. **Report.** A Linear ticket is always filed, with the evidence table and citations in the
   description, and a reply always goes back into the Slack thread.
6. **Implement, if warranted.** If the outcome is `DIAGNOSED` and the diagnosis's confidence
   clears `CONFIG.implement.minConfidence` (0.7 by default), bisect posts "want me to fix this?"
   in the thread. A checkmark reaction runs a second agent that writes a patch, live-verifies
   nothing else, and opens a real GitHub PR (or applies the change locally if no GitHub write
   access is configured). A ticket reaction, or letting the poll time out, leaves it at
   ticket-only.

### `bisect-skills/`: why the agent does not re-read your whole codebase every time

On a brand-new repo, bisect runs a discovery agent that reads the codebase, figures out which
observability services it is actually wired to, and writes:

```
bisect-skills/
  skill.md                 routing index: which bug category maps to which service, in
                            concrete terms (real event names, real env vars)
  references/
    posthog.md              how to query this specific app's PostHog instance
    aws.md, infra.md, etc.  one file per detected service
```

Every investigation after that reads `skill.md` up front instead of exploring from scratch. If
bisect has GitHub write access, this goes out as a pull request, so a human reviews what the
agent inferred about the codebase before it becomes load-bearing. With only `REPO_PATH`
configured, the files are written straight to disk instead. The instructions the discovery agent
itself runs on, `src/bisect/skills/first-time.md`, live only in this repository and are never
copied into a target codebase.

### The investigation agent's tools

```
posthog_find_person          posthog_events_for_person / posthog_events_for_session
posthog_query (raw HogQL)    sentry_find_issues_for_user / sentry_search_issues / sentry_issue_detail
repo_list / repo_read / repo_grep
conclude(evidence_refs!)     abstain(reason)
```

`conclude` also accepts an optional `affected_users`. If the evidence includes a clean failure
signature (a named event with a distinguishing property), the agent can run one extra query to
report how many other users hit the same thing, not just the one who reported it. Every id
listed in `evidence_refs` is checked in code against ids that were actually produced by a tool
call during that run; anything else is stripped before the diagnosis is reported.

## Running pr-manager

Review one existing PR directly, with no public URL or webhook needed:

```bash
npx tsx src/pr-manager/server.ts --pr 17
```

Scope the review with a free-text instruction, the same way an `@bisect ...` PR comment would:

```bash
npx tsx src/pr-manager/server.ts --pr 17 --instruction "focus on the checkout API only"
```

An instruction that reads as asking for a change (containing words like implement, fix, patch,
add, remove, or update) switches from reviewing to writing and live-verifying a fix in the same
sandbox:

```bash
npx tsx src/pr-manager/server.ts --pr 17 --instruction "fix the cart total to multiply by quantity"
```

Start the webhook server instead, for live automatic review on `opened` and `@bisect ...`
comment handling:

```bash
npx tsx src/pr-manager/server.ts
```

npm shortcuts for the same two paths: `npm run review` (webhook server) and `npm run review:pr
<N>` (one-shot).

### What happens on a review

1. bisect clones the PR's head branch into a fresh temporary directory, runs `npm install`,
   boots `npm run dev` on a free local port, and waits for it to actually answer HTTP before
   doing anything else.
2. A browser session (Playwright, Chromium) and the sandbox's base URL are handed to a review
   agent, along with the PR's diff, its title and body, and, if the PR title or body mentions a
   Linear ticket id (like `AGE-59`), that ticket's description.
3. The agent decides for itself which paths to exercise: `http_request` for backend routes,
   `browser_navigate` / `browser_read` / `browser_click` / `browser_type` for the UI, going
   straight at whatever the diff actually touched.
4. It calls `submit_review` with a verdict (`approve`, `request_changes`, or `comment`) and a
   list of findings, each required to cite the evidence id of an actual `http_request` or
   `browser_*` result. A `request_changes` verdict with no findings that cite real evidence is
   automatically downgraded to a plain comment, since an opinion is not a test result.
5. The sandbox and browser are torn down, the run is recorded to `pr-reviews/<id>.json`, and the
   verdict is posted back to the PR as a comment (only if GitHub write access is configured).

Only a PR's `opened` event auto-triggers a review; pushing more commits afterward does not.
Everything after that is driven by an `@bisect ...` mention in a PR comment: anything that reads
as a review request re-reviews, scoped by whatever text follows the mention, and anything that
reads as asking for a change writes and live-verifies a fix in the same sandbox, then opens a
follow-up PR targeting the original PR's branch, not `main`, so a human still reviews it before
it lands.

## Where everything is recorded

Every bisect run, including every tool call, all evidence collected, the diagnosis or the
abstention reason, cost, and duration, is written to `runs/<id>.json`. Every pr-manager run,
both a review (`prr_<id>.json`) and an implement run (`pri_<id>.json`), is written the same way
to `pr-reviews/`. `npm run ui` reads both directories and renders them at
`http://localhost:4321`, with a tab for each.

## Project layout

```
src/
  types.ts                 shared client contracts only (SlackClient, PostHogClient,
                            SentryClient, RepoClient, GitHubClient, LinearClient, and their
                            data shapes), implemented by clients/, used by both pipelines
  config.ts                 env loading, model tiers, cost table, thresholds
  setup/
    wizard.ts                 npm run setup, the interactive .env walkthrough
    envFile.ts                 shared "add or update one KEY=value line" helper
  clients/                  every external service, used by whichever pipeline needs it
    slack.ts                 poll history, reply, Block Kit post, reaction polling
    posthog.ts                person lookup, HogQL query, event fetch, replay URL
    sentry.ts                 issue search, latest-event stack trace and breadcrumbs
    repo.ts                   list/read/grep/write, path traversal blocked
    linear.ts                 issueCreate / addComment / getIssue
    github.ts                 clone / branch / commit / push (git CLI), PR open (REST),
                               parseGithubRepo
    githubApp.ts               App JWT signing and installation token exchange
    githubAuth.ts              resolves either the App's installation token or a plain PAT
    llm.ts                     createChatCompletion (OpenRouter multi-key failover, then
                               optional local Ollama fallback), plus the tool-def adapter
                               both pipelines' tool loops build on

  bisect/                   the investigation pipeline
    index.ts                  poll loop, --text dry-run mode, run recording to runs/
    types.ts                   Investigation, Diagnosis, Evidence, AgentStep, ParsedReport,
                               SkillBootstrap
    agent/
      tools.ts                  investigation tools, evidence-id bookkeeping
      investigate.ts             the loop, post-hoc enforcement, skill.md injection
      implement.ts               the Slack-approved auto-fix agent, patch, and PR
    repo/resolve.ts            GITHUB_REPO (clone) or REPO_PATH (local), cached per process
    skills/
      first-time.md             the discovery agent's own bootstrap instructions, never
                                 copied into a target repo
      bootstrap.ts               the discovery agent loop
      detect.ts                  does bisect-skills/skill.md already exist in the target repo
      apply.ts                   writes skill.md + references/*.md, as a PR or to disk
    steps/parse.ts              Slack text to structured report
    report/render.ts            Linear markdown and Slack Block Kit formatting
    ui/
      server.ts                  a small Node http server, no framework, serving both
                                 runs/*.json and pr-reviews/*.json
      index.html                  the dashboard, one tab per pipeline

  pr-manager/                the review pipeline
    types.ts                    ReviewResult, PrReviewRun, PrImplementRun
    server.ts                   --pr N (one-shot) or the webhook server
    webhook.ts                   signature verification, opened-only auto-trigger, @bisect
                                 routing
    setupGithubApp.ts            npm run setup:github-app, the manifest-flow App creation
    sandbox.ts                    clone PR branch, npm install, boot, wait for real HTTP
    agent.ts / tools.ts           the review loop: http_request, browser_*, submit_review
    implementAgent.ts / implementTools.ts   the write-capable loop, same live sandbox
    run.ts                        orchestrates both, renders and posts the PR comment
```

## Troubleshooting

- **Slack call fails with `not_in_channel`.** The bot has not been invited into the channel
  named by `SLACK_CHANNEL_ID`. Run `/invite @your-bot-name` in that channel.
- **PostHog auth fails, or queries return nothing.** Double check `POSTHOG_API_KEY` starts with
  `phx_`, not `phc_`. The project write key does not have permission to query.
- **Linear returns an auth error.** Linear's API takes the raw key in the `Authorization` header
  with no `Bearer` prefix; if you are calling it manually outside this codebase, that is the
  usual mistake.
- **A GitHub clone or push fails with a 403.** Check that the token (personal or App
  installation) actually has access to that repo, and, for the App path, that it has been
  installed on that specific repository.
- **The webhook server refuses to start.** `GITHUB_WEBHOOK_SECRET` is unset. It has to be set,
  and it has to match the secret configured on the GitHub webhook, or every delivery is rejected
  as unverifiable.
- **pr-manager's sandbox times out waiting for the app to boot.** The target repo likely does
  not follow the `npm install && npm run dev`-shaped assumption the sandbox makes (see
  [src/pr-manager/sandbox.ts](src/pr-manager/sandbox.ts)), or the app takes longer to boot than
  `CONFIG.prReview.sandboxReadyTimeoutMs` (90 seconds by default). Raise that value in
  [src/config.ts](src/config.ts) if the app is just slow to start.
- **The browser tools fail to launch.** Run `npx playwright install chromium` once.
- **Every OpenRouter call fails with a free-tier or overload message.** Add a second key via
  `OPENROUTER_API_KEYS`, or configure an Ollama fallback as described above.

## Status

The core loop, the OpenRouter free-tier backend with multi-key failover, `bisect-skills/`
routing, GitHub repo generalization (via either a real GitHub App identity or a plain PAT), a
Sentry query tool alongside PostHog, Block Kit Slack output, Linear formatting, Slack-approved
auto-implement to PR, pr-manager's live-sandboxed PR review and its own write-capable
`@bisect fix ...` implement flow, the interactive setup wizard, and the local UI have all been
verified end to end against real Slack, PostHog, Sentry, Linear, and a GitHub-hosted demo app,
including a real PR opened and merged from a diagnosis this agent produced.

Not yet built: a labelled benchmark or scorecard harness (`runs/*.json` and
`pr-reviews/*.json` already capture everything one would need for it). pr-manager's own webhook
triggers (auto-review on open, `@bisect ...` comments) are code-reviewed and
signature-verified but need a public URL (a tunnel, or real hosting) to exercise live; the
`--pr` and `--instruction` CLI paths cover the same logic and have been run end to end.

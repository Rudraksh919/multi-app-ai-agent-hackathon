# bisect

## What is the app?

bisect is two agents sharing one codebase-agnostic core, built around a single rule: **a claim
needs evidence, or it doesn't get made.** Most "AI triage" tools read a bug report or a diff and
produce a plausible-sounding guess. Both halves of bisect refuse to do that — they go find out
what actually happened, and say so honestly when they can't.

- **bisect** (the investigator) takes a bug report from Slack, finds the reporting user's *real*
  session in PostHog and/or their *real* crash in Sentry, reads the actual source code that
  handled that request, and only then produces a diagnosis — cited against the specific
  evidence ids that support it. If the trace and the code don't add up to an explanation, it
  says exactly what it looked at and what was missing, instead of guessing. It then files a
  Linear ticket and, above a confidence bar and with a human's Slack approval, can write the fix
  itself and open a real PR.
- **pr-manager** (the reviewer) takes a GitHub pull request, clones its branch into a sandbox,
  runs `npm install`, boots the dev server, and *actually uses the running app* — hitting API
  routes directly and driving a real browser through the UI — before writing a review. It caught
  a real seeded bug this way (a cart total that stopped multiplying by quantity) by adding two
  items and reading the wrong total off the live page, not by noticing the diff looked
  suspicious. A human can also ask it for more via an `@bisect ...` PR comment — a scoped
  re-review, or an actual code change, live-verified in the same sandbox before it opens a
  follow-up PR.

Neither agent is wired to one fixed codebase. The first time bisect looks at a repo it maps
which observability services that repo actually uses and writes a small, reusable routing skill
into it (`bisect-skills/`), so every bug report after that routes straight to "query PostHog
like this" instead of rediscovering the codebase from scratch. `npm run setup` is the guided
path to pointing either agent at your own repo, your own Slack, your own Linear team, your own
PostHog/Sentry project.

## How you used the apps?

| App | What it's actually used for |
|---|---|
| **Slack** | The bug-report intake channel bisect polls. Also the approval gate for auto-implement — bisect posts "want me to fix this?" and a ✅ reaction is what authorizes it to write code and open a PR. |
| **Linear** | Every investigation outcome — diagnosed, abstained, or skipped — gets filed as a ticket, with the evidence table and citations in the description, not just a one-line summary. |
| **PostHog** | Person lookup by email → their real event history (page views, clicks, custom events like `checkout_response`) → raw HogQL for anything the built-in tools can't answer. This is what makes "diagnosed" mean something. |
| **Sentry** | The crash-trace counterpart to PostHog — search issues by the reporting user's email, pull the latest event's stack trace and breadcrumb trail. Optional per codebase; a repo without Sentry just gets an honest "not configured" from the tool instead of an error. |
| **GitHub** | Repo cloning, PR diffs, PR comments, branch/commit/push for auto-fix PRs — and a real **GitHub App** (not a personal token), registered via GitHub's manifest flow with one click, so every automated action shows up as its own bot identity instead of a human's account. |
| **Stripe** | Wired into the test-fixture app (`acme-shop`) as a genuine test-mode payment integration, so there's a real `PaymentIntent` and real decline codes to reason about instead of a fake gateway that just checks if a string ends in `0000`. |
| **Vercel** | Where the test-fixture app is actually deployed — used to validate the full pipeline (bisect *and* pr-manager) against a live, production-shaped target, not just a local dev server. |
| **OpenRouter / Ollama** | OpenRouter is tried first for every agent call, with automatic multi-key failover. If all remote keys fail, an optional local Ollama model can finish the same tool-calling loop without API cost. |

## Demo link

`[ADD YOUR DEMO VIDEO / LIVE LINK HERE]`

## Your evaluation criteria

What this is actually trying to be good at, in order:

1. **Does a diagnosis or review cite real evidence, or is it a guess?** Every `conclude()` and
   `submit_review()` is checked in code against the evidence ids actually collected that run —
   an uncited claim is discarded regardless of what the model asserted. This is the single
   thing most worth checking: read a `runs/*.json` or `pr-reviews/*.json` and see whether the
   cited evidence actually supports the claim.
2. **Does it abstain honestly when it can't back a claim?** `NO_DIAGNOSIS` / `NO_SESSION` /
   an `ERROR` review outcome are meant to be *common and correct* outputs, not failures of the
   system — a confident wrong answer is the actual failure mode being designed against.
3. **Does pr-manager really run the code, or read the diff and guess?** It caught the seeded
   cart-quantity bug by adding items to a live cart and reading the total, not by pattern-
   matching the diff. Check whether a review's findings trace back to an `http_request` or
   `browser_*` evidence id, not just "the diff looks wrong."
4. **Does it generalize, or is it secretly hardcoded to `acme-shop`?** `bisect-skills/` is
   generated per-repo on first contact, not shipped with the demo fixture — and `npm run setup`
   is meant to make "point this at a different repo entirely" a real, testable claim, not an
   aspirational one.
5. **Breadth and depth of real integration**, not mocked stand-ins — eight services above, each
   doing something the system's core claim (evidence over guessing) actually depends on.

## Codebase-agnostic core

Two agents sharing one codebase-agnostic core: **bisect** investigates bug reports the way a
human engineer would — finding the user's real session, reading the actual code, and only then
saying what's wrong, not guessing from one Slack sentence. **pr-manager** does the same thing
for pull requests — it clones a PR's branch, boots it for real, and actually clicks/curls
through it before reviewing, rather than reading the diff and guessing.

Neither is wired to one fixed codebase. The first time bisect looks at a repo it maps which
observability services that repo actually uses and writes a small, reusable routing skill into
it (`bisect-skills/`), so every bug report after that routes straight to "query PostHog like
this" instead of rediscovering the codebase from scratch. Point either agent at your own repo,
your own Slack, your own Linear team, your own PostHog/Sentry project — `npm run setup` walks
through it (see Quickstart).

```
bisect:      Slack (#bugs) → parse → [route or map] → [ investigation loop ] → Linear + Slack
                                                            tools: PostHog, Sentry, repo read/grep
                                                                ↓ (if confident + approved in Slack)
                                                      [ implement agent ] → PR on GitHub

pr-manager:  PR opened → clone + npm install + boot → [ live-tested review ] → PR comment
                                                            tools: http_request, real browser
                                                                ↓ ("@bisect fix ..." on the PR)
                                                      [ implement agent, same sandbox ] → follow-up PR
```

## Why this, not a script with an LLM call in it

Most "AI triage" tools read a bug report and produce a plausible-sounding guess. bisect is built
around two rules that are **enforced in code, not just asked for in a prompt** — because a
confident wrong answer is worse than no answer at all:

1. **Every diagnosis cites evidence.** `conclude()`'s `evidence_refs` are filtered against ids
   that were actually collected during the investigation; if none survive, the outcome is
   downgraded to `NO_DIAGNOSIS` regardless of what the model claimed. See
   [investigate.ts](src/agent/investigate.ts).
2. **Abstention is a first-class, reported outcome** — `DIAGNOSED` / `NO_SESSION` /
   `NO_DIAGNOSIS` / `SKIPPED` are all valid results. "I found the session, the checkout
   succeeded, I cannot reproduce the complaint" is a more useful ticket than a plausible guess.

## How it works

| Step | What happens | |
|---|---|---|
| **1. Listen** | Polls a Slack channel for new messages | deterministic |
| **2. Parse** | An LLM call turns a messy human report into a structured `{symptom, email, window, entities}` | deterministic |
| **3. Route or map** | First time on a repo: an agent maps its services into `bisect-skills/`. Every time after: reads that map instead of rediscovering the codebase | see below |
| **4. Investigate** | An agentic tool-use loop — the agent decides its own path through PostHog and the repo, the way a person debugging would follow one lead into the next | *the actual agent* |
| **5. Report** | Files a Linear ticket (always) and replies in Slack (always), with the evidence table and citations | deterministic |
| **6. Implement** *(optional)* | If confidence clears a bar, offers in Slack to fix it — a ✅ reaction runs a second agent that patches the file and opens a real GitHub PR | gated on human approval |

### `bisect-skills/` — why the agent doesn't re-read your whole codebase every time

On a brand-new repo, bisect runs a one-time discovery pass: it reads the codebase, figures out
which services it's wired to (PostHog, Sentry, AWS, whatever), and writes:

```
bisect-skills/
  skill.md                 routing index — which bug category maps to which service, in
                            concrete terms (real event names, real env vars)
  references/
    posthog.md              how to query this specific app's PostHog instance
    aws.md, infra.md, …      one file per service, added as the codebase grows
```

Every investigation after that reads `skill.md` up front instead of exploring from scratch. If
`bisect` has GitHub write access it opens this as a PR (so a human reviews what it inferred
about the codebase before it becomes load-bearing); otherwise it writes the files locally.

### The agent's tools

```
posthog_find_person          posthog_events_for_person / _for_session
posthog_query (raw HogQL)    repo_list / repo_read / repo_grep
conclude(evidence_refs!)     abstain(reason)
```

`conclude` also accepts an optional `affected_users` — if the evidence includes a clean failure
signature (a named event with a distinguishing property), the agent can run one extra query to
report how many *other* users hit the same thing, not just the one who reported it.

## Quickstart

```bash
git clone <this repo>
cd multi-app-ai-agent-hackathon
npm install
npm run setup            # interactive — asks for your own keys, writes .env
npm run setup:github-app # optional but recommended — a real bot identity instead of your PAT
```

`npm run setup` asks for OpenRouter, Slack, Linear, the repo to work on, and optionally
PostHog/Sentry, and writes straight to a local `.env` — nothing it collects leaves this
machine. Re-run it anytime; blank answers are skipped, so it's safe to fill in the rest later.
Prefer editing `.env` by hand instead? `.env.example` documents every variable with the same
"where to get it" detail the wizard prints.

For a zero-cost local fallback, install Ollama, pull a tool-capable model such as
`ollama pull qwen3:4b`, and set `OLLAMA_MODEL=qwen3:4b`. `OLLAMA_BASE_URL` defaults to
`http://localhost:11434/v1`. Bisect tries Ollama only after every configured OpenRouter key
fails, and temporarily skips keys that report an exhausted daily free quota.

Two things worth knowing before you point this at a *different* repo than whatever you tested
with first:
- **GitHub write access is one App/token for however many repos you configure `GITHUB_REPO`
  to.** The GitHub App from `setup:github-app` gets installed per-repo (or per-org) from its own
  GitHub settings page — install it on every repo you want bisect/pr-manager to have write
  access to.
- **pr-manager's sandbox assumes an `npm install && npm run dev`-shaped repo** (see
  [sandbox.ts](src/pr-review/sandbox.ts)) — it works well for Next.js/React-style apps like the
  demo fixture (`acme-shop`), and less well for anything with a fundamentally different
  install/boot story (a different package manager's lockfile is fine; a non-Node stack is not,
  today).

### Run it

```bash
npm run dev                     # the real thing: polls Slack, investigates, files tickets
npm run ui                      # local dashboard — every run, evidence, and citation, at localhost:4321
```

Fast dev loop — skips Slack and Linear entirely, prints the would-be ticket to stdout:

```bash
npm run start -- --text "checkout is broken for jane@acme.com, she says it just spins after clicking pay"

# also exercise the auto-implement → PR path without waiting on a Slack reaction:
npm run start -- --text "..." --auto-implement
```

pr-manager — review one PR directly (no public URL needed), or run the webhook server for
live "opened" auto-review + "@bisect ..." comment handling:

```bash
npx tsx src/pr-review/server.ts --pr 17
npx tsx src/pr-review/server.ts --pr 17 --instruction "focus on the checkout API only"
npx tsx src/pr-review/server.ts --pr 17 --instruction "fix the cart total to multiply by quantity"
npx tsx src/pr-review/server.ts   # no --pr: starts the webhook server on PR_REVIEW_PORT
```

The webhook path needs a public URL pointed at `/webhook` (Settings → Webhooks on the repo) —
a tunnel (ngrok or similar) for local dev, real hosting otherwise. Auto-review fires once, on a
PR's `opened` event; pushing more commits does not re-trigger it. Everything after that is
"@bisect ..." on the PR: an instruction that reads as asking for a change (implement/fix/patch/
etc.) writes and live-verifies a fix in the same sandbox, then opens a follow-up PR targeting
the *original* PR's branch (not main); anything else re-reviews, scoped by whatever you wrote.

## Project layout

```
src/
  types.ts               the contracts + client interfaces
  config.ts               env loading, model tiers, cost table, thresholds
  setup/
    wizard.ts               npm run setup — the interactive .env walkthrough
    envFile.ts               shared "upsert one KEY=value line" helper
  clients/
    slack.ts               poll history, reply, Block Kit post, reaction polling (approval gate)
    posthog.ts              person lookup, HogQL query, event fetch, replay URL
    sentry.ts               issue search, latest-event stack trace + breadcrumbs — optional
    repo.ts                 list/read/grep/write, path-traversal blocked
    linear.ts               issueCreate / addComment / getIssue
    github.ts               clone / branch / commit / push (git CLI) + PR open (REST)
    githubApp.ts             RS256 App JWT signing + installation-token exchange
    githubAuth.ts            resolves either the App's installation token or a plain PAT,
                             transparently, for everything in github.ts
  repo/resolve.ts          GITHUB_REPO (clone) or REPO_PATH (local) — cached per process,
                           cleaned up on process exit or after a bootstrap PR
  skills/
    first-time.md           bisect's own bootstrap instructions — lives HERE, never copied
                             into a target repo (only skill.md + references/*.md are)
    bootstrap.ts             CASE 1: discovery agent loop → SkillBootstrap
    detect.ts                does bisect-skills/skill.md exist in the target repo?
    apply.ts                 writes skill.md + references/*.md — as a PR if GitHub-backed,
                             directly to disk if local REPO_PATH
  agent/
    client.ts                OpenRouter multi-key failover, then optional local Ollama fallback
    tools.ts                 investigation tools, evidence-id bookkeeping, OpenAI tool adapter
    investigate.ts            the loop + post-hoc enforcement + skill.md injection
    implement.ts              Slack-approved auto-fix agent → patch → PR
  steps/parse.ts            Slack text → structured report
  report/render.ts          Linear markdown + Slack Block Kit formatting
  ui/
    server.ts                tiny Node http server, no framework
    index.html                dashboard reading runs/*.json — list + detail view, aggregate stats
  index.ts                  poll loop, --text dry-run mode, run recording to runs/
  pr-review/                 the sibling pipeline — see the diagram above
    server.ts                 --pr N (one-shot) or the webhook server
    webhook.ts                 signature verification, opened-only auto-trigger, @bisect routing
    setupGithubApp.ts          npm run setup:github-app — manifest-flow App creation, one click
    sandbox.ts                  clone PR branch → npm install → boot → wait for real HTTP
    agent.ts / tools.ts         review loop: http_request, browser_*, submit_review
    implementAgent.ts / implementTools.ts   write-capable loop reusing the same live sandbox
    run.ts                      orchestrates both; renders + posts the PR comment
```

Every run — evidence collected, every tool call, the diagnosis or the abstention reason, cost,
and duration — is written to `runs/<id>.json` (bisect) or `pr-reviews/<id>.json` (pr-manager).
That's what the UI reads, and what a future benchmark/replay harness would run against.

## Status

Core loop, the OpenRouter/free-Nemotron backend with multi-key failover, `bisect-skills/`
routing, GitHub repo generalization (clone-any-repo, not one fixed checkout, via either a real
GitHub App identity or a plain PAT), a Sentry query tool alongside PostHog, Block Kit Slack
output, Linear formatting, Slack-approved auto-implement→PR, pr-manager's live-sandboxed PR
review and its own write-capable "@bisect fix ..." implement flow, the interactive setup
wizard, and the local UI are all written and **verified live end-to-end** against real Slack,
PostHog, Sentry, Linear, and a GitHub-hosted demo app
(`acme-shop`) — including a real PR opened and merged from a diagnosis this agent produced.

Not yet built: a labelled benchmark/scorecard harness (`runs/*.json` and `pr-reviews/*.json`
already capture everything one would need), and pr-manager's own webhook triggers (auto-review
on open, "@bisect ..." comments) are only proven end-to-end via the `--pr`/`--instruction` CLI
paths — the actual webhook HTTP path is code-reviewed and signature-verified but needs a public
URL (tunnel or real hosting) to exercise live, which hasn't been done yet.

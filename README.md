# bisect

An agent that investigates bug reports the way a human engineer would — not by guessing from
one Slack sentence, but by finding the user's real session, reading the actual code, and only
then saying what's wrong. It works on **any GitHub repo**, not one fixed codebase: the first
time it looks at a repo it maps which observability services that repo actually uses and writes
a small, reusable routing skill into it (`bisect-skills/`), so every bug report after that routes
straight to "query PostHog like this" instead of rediscovering the codebase from scratch.

```
Slack (#bugs) → parse → [route or map] → [ agentic investigation loop ] → Linear + Slack
                                               tools: PostHog, repo read/grep
                                                   ↓ (if confident + approved in Slack)
                                         [ implement agent ] → PR on GitHub
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
cp .env.example .env   # fill in the keys below
```

| Var | Where to get it | Gotcha |
|---|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | used with free Nemotron models — runs at $0 as configured |
| `SLACK_BOT_TOKEN` | api.slack.com/apps → OAuth & Permissions | scopes: `channels:history`, `chat:write`, `channels:read`, `reactions:read` — then **`/invite` the bot into the channel** or every call fails with `not_in_channel` |
| `SLACK_CHANNEL_ID` | right-click channel → View details | |
| `POSTHOG_API_KEY` | PostHog → Settings → Personal API keys | must be a **personal** key (`phx_...`), not the project write key (`phc_...`) |
| `POSTHOG_PROJECT_ID` | PostHog → Settings → Project | |
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API keys | sent as the raw key, no `Bearer` prefix |
| `GITHUB_REPO` | `owner/repo`, a full URL, or a `git@` URL | omit to use `REPO_PATH` instead (below) |
| `GITHUB_TOKEN` | a PAT with repo write scope | only needed for the `bisect-skills/`-as-PR and auto-implement-as-PR paths |
| `REPO_PATH` | a local checkout, e.g. `../acme-shop` | used instead of `GITHUB_REPO` for local dev — whichever is set, `GITHUB_REPO` wins if both are |

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

## Project layout

```
src/
  types.ts               the contracts + client interfaces
  config.ts               env loading, model tiers, cost table, thresholds
  clients/
    slack.ts               poll history, reply, Block Kit post, reaction polling (approval gate)
    posthog.ts              person lookup, HogQL query, event fetch, replay URL
    repo.ts                 list/read/grep/write, path-traversal blocked
    linear.ts               issueCreate / addComment / getIssue
    github.ts               clone / branch / commit / push (git CLI) + PR open (REST)
  repo/resolve.ts          GITHUB_REPO (clone) or REPO_PATH (local) — cached per process
  skills/
    first-time.md           bisect's own bootstrap instructions — lives HERE, never copied
                             into a target repo (only skill.md + references/*.md are)
    bootstrap.ts             CASE 1: discovery agent loop → SkillBootstrap
    detect.ts                does bisect-skills/skill.md exist in the target repo?
    apply.ts                 writes skill.md + references/*.md — as a PR if GitHub-backed,
                             directly to disk if local REPO_PATH
  agent/
    client.ts                shared OpenRouter/OpenAI-SDK client factory
    tools.ts                 investigation tools, evidence-id bookkeeping, OpenAI tool adapter
    investigate.ts            the loop + post-hoc enforcement + skill.md injection
    implement.ts              Slack-approved auto-fix agent → patch → PR
  steps/parse.ts            Slack text → structured report
  report/render.ts          Linear markdown + Slack Block Kit formatting
  ui/
    server.ts                tiny Node http server, no framework
    index.html                dashboard reading runs/*.json — list + detail view, aggregate stats
  index.ts                  poll loop, --text dry-run mode, run recording to runs/
```

Every run — evidence collected, every tool call, the diagnosis or the abstention reason, cost,
and duration — is written to `runs/<id>.json`. That's what the UI reads, and what a future
benchmark/replay harness would run against.

## Status

Core loop, the OpenRouter/free-Nemotron backend, `bisect-skills/` routing, GitHub repo
generalization (clone-any-repo, not one fixed checkout), Block Kit Slack output, Linear
formatting, Slack-approved auto-implement→PR, and the local UI are all written and **verified
live end-to-end** against real Slack, PostHog, Linear, and a GitHub-hosted demo app
(`acme-shop`) — including a real PR opened and merged from a diagnosis this agent produced.

Not yet built: a labelled benchmark/scorecard harness (`runs/*.json` already captures everything
one would need). Not on `main`: an autonomous PR-review agent that sandboxes and live-tests
incoming pull requests — see the `pr-manager` branch.

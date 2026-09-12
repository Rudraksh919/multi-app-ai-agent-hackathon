# bisect — Build Plan

An agent that investigates bug reports the way a human would: it reads the report in Slack,
finds the user's real session in PostHog, reads the actual code, and files a Linear ticket
with a cited diagnosis — or an honest "I don't know," never a confident guess.

**Full product vision (v2 — bisect over deploy history, repro compilation, blast radius):**
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). This document is the plan for what we are
actually building today.

```
Slack (#bugs) → parse → [ agentic investigation loop ] → Linear ticket + Slack reply
                              tools: PostHog, repo read/grep
```

---

## 0. Status right now

Scaffolding and the core loop are written and typecheck clean. **Nothing has been run against
real Slack/PostHog/Linear yet** — no `.env` filled in, no demo app deployed. That's the next step.

```
src/
  types.ts              done — the 4 contracts + client interfaces
  config.ts              done — env loading, model tiers, cost table, thresholds
  clients/
    slack.ts              done — poll history, reply in thread (filters bot msgs)
    posthog.ts             done — person lookup, HogQL query, event fetch, replay URL
    repo.ts                done + smoke-tested — list/read/grep, path-traversal blocked
    linear.ts              done — issueCreate (raw key auth, no "Bearer")
  agent/
    tools.ts               done — 8 tools, evidence-id bookkeeping
    investigate.ts          done — the loop + post-hoc enforcement (see §5)
  steps/parse.ts          done — Slack text → structured report
  report/render.ts        done — Linear markdown + Slack reply text
  index.ts               done — poll loop, --text dry-run mode, run recording to runs/
```

**Not started:** the demo app (`acme-shop`), Slack/PostHog/Linear accounts wired up,
Slack Block Kit formatting, the benchmark harness, README/video.

---

## 1. Architecture

```
                    ┌────────────────────────────────────────────┐
 Slack #bugs  ─────▶│ 1. LISTEN   poll conversations.history      │
                    │ 2. PARSE    Claude → structured report      │  deterministic
                    └────────────────────────────────────────────┘
                                        │
                    ┌────────────────────────────────────────────┐
                    │ 3. INVESTIGATE  — an agentic tool-use loop  │
                    │                                             │
                    │   tools: posthog_find_person                │
                    │          posthog_events_for_person/session   │  agent decides
                    │          posthog_query (raw HogQL)            │  its own path
                    │          repo_list / repo_read / repo_grep    │
                    │          conclude(evidence_refs!) / abstain   │
                    └────────────────────────────────────────────┘
                                        │
                    ┌────────────────────────────────────────────┐
 Linear + Slack ◀───│ 4. REPORT   ticket always · reply always     │  deterministic
                    └────────────────────────────────────────────┘
```

Steps 1, 2, 4 are fixed code — boring on purpose, so they're never the thing that breaks live.
Step 3 is the actual agent: it chooses which tool to call next based on what it's seen, the way
a person debugging would follow one lead into the next. That's what makes this "an agent" and
not "a script with an LLM call in it."

### Why these 4 apps, not fewer

| App | Role | Remove it and… |
|---|---|---|
| **Slack** | the claim — vague, human, where the answer goes | nothing to investigate, nowhere to reply |
| **PostHog** | the reality — what the user actually did, not what they said | you're an LLM guessing from one sentence |
| **GitHub / local repo** | the cause | you can describe a symptom but never point at code |
| **Linear** | the resolution | the finding evaporates when the Slack thread scrolls away |

### The two rules enforced in code, not in the prompt

1. **Every diagnosis cites evidence.** `conclude()`'s `evidence_refs` are filtered against ids
   that were actually collected; zero survivors ⇒ downgraded to `NO_DIAGNOSIS`. See
   [investigate.ts:150](src/agent/investigate.ts:150).
2. **Abstention is a first-class, reported outcome** — `DIAGNOSED` / `NO_SESSION` /
   `NO_DIAGNOSIS` / `SKIPPED`. A confident wrong answer is worse than "I don't know."

---

## 2. Environment setup (both of you do this first)

```bash
git clone <this repo>
cd multi-app-ai-agent-hackathon
npm install
cp .env.example .env
```

Fill in `.env`:

| Var | Where to get it | Gotcha |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com | |
| `SLACK_BOT_TOKEN` | api.slack.com/apps → OAuth & Permissions | scopes: `channels:history`, `chat:write`, `channels:read` — then **`/invite @bisect` into the channel** or every call fails with `not_in_channel` |
| `SLACK_CHANNEL_ID` | right-click channel → View details → bottom of panel | |
| `POSTHOG_API_KEY` | PostHog → Settings → Personal API keys | must be a **personal** key (`phx_...`), not the project write key (`phc_...`) |
| `POSTHOG_PROJECT_ID` | PostHog → Settings → Project | |
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API keys | sent as the raw key, no `Bearer` prefix |
| `REPO_PATH` | local path to `acme-shop` once it exists | |

Fast dev loop (bypasses Slack + Linear entirely, prints the ticket to stdout):

```bash
npm run start -- --text "checkout is broken for jane@acme.com, she says it just spins after clicking pay"
```

Real loop:

```bash
npm run dev
```

---

## 3. The demo app — `acme-shop`

A second, separate repo/folder: a small checkout flow with one seeded bug, instrumented with
PostHog. This is the thing `bisect` investigates.

| Route | Behaviour |
|---|---|
| `/` , `/product/:id` | catalogue |
| `/cart` | add/remove — `data-testid="add-to-cart"` |
| `/checkout` | address + card form — `data-testid="pay"` |
| `/order/:id` | confirmation — `data-testid="order-confirmation"` |
| `POST /api/checkout` | validates, returns `{ orderId }` on success |

**The seeded bug** (this is the whole demo — no exception, nothing in error monitoring, only a
real user with a declined card sees it):

```diff
- if (res.status === 200) { router.push(`/order/${json.orderId}`); }
- else { setError(json.message); setLoading(false); }
+ if (res.status === 200) { router.push(`/order/${json.orderId}`); }
+ else if (res.status >= 500) { setError(json.message); setLoading(false); }
+ // 402 (card declined) falls through — spinner spins forever, no error state,
+ // no exception thrown.
```

Deploy to Vercel. Install the PostHog snippet with autocapture + session recording on. Add
`data-testid` to every interactive element — it's what makes `repo_grep`/URL→file mapping land
correctly, and it's realistic (a real app would already have these for its own tests).

`data-testid` on every interactive element, real deploy, real PostHog project — no mocking.

---

## 4. Phases

Two people, minimal file overlap. **A** owns the demo app + fixtures (blocking, do first).
**B** owns the pipeline (already scaffolded — mostly wiring against real accounts + reporting
polish from here).

### Phase 0 — Foundations *(done)*
Types, config, all 4 clients, the agent loop, enforcement rules, CLI. ✅

### Phase 1 — Demo app · **A** · ~2h · do this first, it blocks everything downstream
| | Task | Done when |
|---|---|---|
| 1.1 | Scaffold `acme-shop`, cart → checkout → order works locally | you can buy something |
| 1.2 | Add `data-testid` to every interactive element | |
| 1.3 | Deploy to Vercel | public URL works |
| 1.4 | Install PostHog snippet (autocapture + session recording on) | a manual checkout shows up as a replay within a few minutes |
| 1.5 | Introduce the seeded bug (§3 diff) | a declined-card checkout hangs forever, no console error |
| 1.6 | Do 3–4 manual checkouts by hand: some happy, some hitting the bug | sessions visible in PostHog, one clearly shows the rage-click + hang |

### Phase 2 — Wire real accounts · **B** · ~45 min · parallel with Phase 1
| | Task | Done when |
|---|---|---|
| 2.1 | Slack app created, bot invited to `#bugs` | `npm run dev` connects, no `not_in_channel` error |
| 2.2 | PostHog personal API key confirmed working | a manual `findPerson` smoke test returns a real person |
| 2.3 | Linear API key + team confirmed | a hardcoded `createIssue` call produces a real ticket |
| 2.4 | `REPO_PATH` points at a local `acme-shop` checkout (once 1.1 exists) | `repo_list('app')` returns real routes |

### Phase 3 — First real end-to-end run · **B**, needs Phase 1 + 2 · ~1h
| | Task | Done when |
|---|---|---|
| 3.1 | Post a real bug message in `#bugs` referencing the seeded bug | pipeline picks it up within one poll interval |
| 3.2 | Confirm `posthog_find_person` → `posthog_events_for_person` returns the real session | agent's tool log shows real PostHog data, not errors |
| 3.3 | Confirm the agent navigates to the right file (`app/checkout/...`) via `repo_read`/`repo_grep` | tool log shows it reading the actual buggy file |
| 3.4 | Confirm `conclude()` fires with non-empty `evidence_refs` citing real evidence ids | Linear ticket names the right file and cites `ph_XX`/`file_XX` |
| 3.5 | Confirm the Slack reply renders correctly in a real channel | readable, links work, replay URL opens the right session |

**This phase is the actual milestone.** Once it works once, everything after is refinement.

### Phase 4 — Abstention paths · **A or B** · ~45 min
Post 2–3 more messages designed to hit the other outcomes and confirm they behave honestly:

| Test message | Expected outcome |
|---|---|
| Names an email with no PostHog history | `NO_SESSION` — asks for more info instead of guessing |
| Describes a happy-path checkout that actually succeeded | `NO_DIAGNOSIS` — agent finds no failure, says so |
| Vague, low-signal report ("something's broken") | Either abstains or files ticket with low confidence and no code claim |

### Phase 5 — Reporting polish · **A** · ~1h
| | Task |
|---|---|
| 5.1 | Slack reply as Block Kit (currently plain text in `render.ts` — upgrade `slackReply()` output to blocks for a cleaner card) |
| 5.2 | Trim/tune the Linear markdown template for readability (`linearDescription()`) |
| 5.3 | Add a short header banner or emoji-coded outcome so a scroll of `#bugs` is scannable at a glance |

### Phase 6 — Benchmark + scorecard · **B** · ~1.5h — this is 25% of the hackathon score, don't skip
| | Task | Done when |
|---|---|---|
| 6.1 | Write 8–10 labelled test messages covering all 4 outcomes (mirroring §4's table, expanded) | `benchmark/labels.json` |
| 6.2 | `benchmark/run.ts` — runs each through `runOne`-equivalent logic in dry-run mode, compares outcome + cited file against label | prints pass/fail per case |
| 6.3 | Emit `SCORECARD.md`: outcome accuracy, false-diagnosis rate (named wrong file), correct-abstention rate, median cost/duration | one clean table, referenced in the video |

### Phase 7 — Ship · **A + B together** · ~1h
| | Task |
|---|---|
| 7.1 | README: problem statement, architecture diagram, how to run, scorecard summary |
| 7.2 | Record 2-minute demo: real Slack message → real investigation → real Linear ticket, end to end |
| 7.3 | Freeze code 30 min before judging; do one final `npm run dev` dry run to confirm nothing regressed |

---

## 5. Enforcement rules — reference

These already exist in [investigate.ts](src/agent/investigate.ts). Know them before touching
that file:

- `evidence_refs` on a diagnosis are filtered to ids that appear in `evidence[]`; if none survive,
  outcome becomes `NO_DIAGNOSIS` regardless of what the model claimed.
- `confidence < CONFIG.diagnosis.minConfidence` (0.4) also forces `NO_DIAGNOSIS` — the ticket is
  still filed, with the trace, but with no code claim.
- Running out of `CONFIG.agent.maxSteps` (20) without a `conclude`/`abstain` call is treated as an
  abstention, not a crash.
- The bug report text is always wrapped in `<untrusted_report>` and treated as data — see the
  system prompt in `investigate.ts`.

---

## 6. Division of labour summary

| | Owns | Depends on |
|---|---|---|
| **A** | `acme-shop` demo app, PostHog data quality, Slack/Linear reporting polish | nothing to start (Phase 1) |
| **B** | Account wiring, end-to-end debugging, benchmark harness | Phase 1 for real data (Phase 3+) |

Merge point: **Phase 3**. Until then you're not touching the same files.

---

## 7. What we are explicitly not building today

Bisect-over-deploy-history, session→Playwright repro compilation, blast-radius queries,
auto-fix PRs, a hosted service, multi-repo support. All of these are real and all of them are in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) as v2 — every one slots into a step that already
exists here, so nothing built today is wasted. Do not start any of them before Phase 6 is done.

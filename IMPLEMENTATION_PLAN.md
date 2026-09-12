# BISECT — Implementation Plan

**Working name:** `bisect` (the agent posts as `bisect-bot`)

**One-liner:**
> Every AI debugging tool reads your code and guesses. **Bisect compiles your user's actual session into a test, replays it across three weeks of your deploys, and tells you exactly which commit broke it — proven, not predicted.**

**Event:** Multi-App AI Agent Hackathon — Sunday 13 September 2026 · build 09:30–16:00 PT · judging 16:00–16:40 PT
**Brief:** *"Build one useful, multi-step AI agent. Connect it to at least three external apps. Show how you know it works."*

> This document supersedes the earlier PR-QA-agent plan. Reusable pieces from it (Action mechanics, evidence discipline, benchmark structure) have been folded in.

---

## 0. The thesis

A customer writes: *"checkout is broken, it just spins."*

No exception was thrown. Nothing hit Sentry. No alert fired. The button just did nothing, and the user left.

Every existing tool in this space — Sentry Autofix, Lemma, Cursor, Devin — starts from a **stack trace** and then **reasons about source code**. None of them ever runs the application. The entire category is inference.

Bisect does experiments instead:

| Step | Everyone else | Bisect |
|---|---|---|
| Understand the report | read the text | **replay the user's real session** |
| Confirm it's real | assume | **run the repro, confirm or abstain** |
| Find the cause | LLM reads the diff | **binary-search the deploy history** |
| Report | "probably line 47" | "`abc123` — verified good at `d-060`, broken at `d-061`" |
| Fix | proposed patch | **patch applied, repro re-run, suite re-run** |

Every claim Bisect makes is backed by an execution, not a token prediction. That is the entire product and the entire pitch.

### Why this wins *this* room

| Judge/host | Their thesis | How we speak it |
|---|---|---|
| **Lemma** (host) | agents/systems fail *silently*; nothing catches it | our trigger is a complaint with no exception behind it |
| **Arga Labs** (judge) | sandboxes and twins so software can be *rehearsed*, not guessed at | the bisect is exactly that, applied to debugging |
| **Userlens** (judge) | churn begins long before anyone tells you | the blast-radius number: 847 affected, 1 complained |
| **The brief** | "show how you know it works" | bisect accuracy is deterministic — we don't estimate it, we prove it |

---

## 1. Scoring map

| Criterion | Weight | Our answer |
|---|---|---|
| Technical execution | 30% | Session→Playwright compiler; binary search over immutable deploy URLs; multi-source correlation |
| **Reliability & evaluation** | **25%** | 20 labelled tickets; repro-compile rate; **bisect accuracy (deterministic)**; false-diagnosis rate; **correct-abstention rate** |
| Usefulness | 20% | Every SaaS team has an unreproducible-bug backlog |
| Originality | 15% | Nobody executes. "We run your app 8 times across 3 weeks of deploys" has no competitor |
| Demo clarity | 10% | Vague complaint → session replay → bisect ladder → proven commit. 2 minutes, one arc |

**The number that ends the conversation:** `Bisect accuracy 14/14 — deterministic, not probabilistic.`

---

## 2. External apps

| # | App | Structural role | Remove it and… |
|---|---|---|---|
| 1 | **PostHog** | *the reality* — session replay, event stream, blast radius | you're guessing at repro steps |
| 2 | **Vercel** | *the time machine* — immutable deploy history = the bisect search space | no bisect; the whole thesis dies |
| 3 | **GitHub** | *the cause* — commits, diffs, PR, regression test | you can name a deploy but never a line |
| 4 | **Slack** | *the decision gate* — a human authorises code changes | an agent edits prod unsupervised |
| 5 | **Linear** | *the resolution* | the finding evaporates |
| 6 | *(opt)* **Sentry / CloudWatch** | *the reality, backend* | can't separate "UI bug" from "API bug" |
| 7 | *(opt)* **Stripe** | *the price* — blast radius in dollars | a number instead of a headline |

Core three: **PostHog + Vercel + GitHub**. Slack and Linear are load-bearing, not decorative — Slack is the *permission boundary* for writing code, Linear is the only durable output when the fix isn't approved.

---

## 3. Architecture

```
┌─ INTAKE ──────────────────────────────────────────────────────────┐
│ Intercom webhook | Slack message | GitHub issue                   │
│   └─ Vercel Edge Function (thin, ~40 lines)                       │
│        └─ validates, normalises → Ticket                          │
│        └─ repository_dispatch → GitHub Actions                    │
└───────────────────────────────────────────────────────────────────┘
                              │
┌─ INVESTIGATION (GitHub Actions runner, ~5 min) ───────────────────┐
│                                                                   │
│  1. CORRELATE   email + fuzzy time → PostHog person → sessions     │
│                 → rank candidate sessions by symptom match         │
│                                                                   │
│  2. COMPILE     session event stream → repro.spec.ts               │
│                 [claude-opus-5 + deterministic templating]         │
│                                                                   │
│  3. REPRODUCE   run repro ×3 against current production            │
│                 → REPRODUCED | NOT_REPRODUCED | FLAKY              │
│                 ── abstain here if not reproduced ──               │
│                                                                   │
│  4. BISECT      binary search over Vercel deploy history           │
│                 verify endpoints → O(log n) runs → breaking deploy │
│                 → commit SHA  [deterministic, no LLM]              │
│                                                                   │
│  5. LOCALIZE    breaking diff + failure evidence                   │
│                 → ranked code locations w/ evidence refs           │
│                 [claude-opus-5]                                    │
│                                                                   │
│  6. QUANTIFY    PostHog: how many others hit this signature        │
│                 (+ Stripe: what it's worth)                        │
│                                                                   │
│  7. DECIDE      Slack: findings + ✅/❌ gate (poll for reaction)    │
│                                                                   │
│  8. RESOLVE     Linear ticket (always)                             │
│                 + on approval: patch → re-run repro → re-run suite │
│                 → PR with fix AND the generated regression test    │
└───────────────────────────────────────────────────────────────────┘
```

### Three design decisions to state out loud

1. **Bisect contains no LLM.** It is a binary search over HTTP responses. Its accuracy is a property of the algorithm, not of a model. That is why we can report it as a proof.
2. **Abstention is a first-class outcome.** If the repro doesn't reproduce in 3 attempts, we stop and say so. 4 of our 20 benchmark tickets have "I don't know" or "already fixed" as the correct answer.
3. **Every ranked location cites evidence IDs.** A localization claim with no surviving citation is dropped before it reaches a human.

---

## 4. The key insight that makes this buildable

**Vercel keeps every past deployment live at its own immutable URL, forever.**

So "boot the app at commit N" — which sounds like hours of sandbox engineering — is actually:

```
GET https://api.vercel.com/v6/deployments?projectId=X&state=READY&target=production&limit=100
  → [ { uid, url: "acme-shop-a1b2c3.vercel.app", created, meta.githubCommitSha }, ... ]
```

The bisect is ~8 Playwright runs against URLs **that already exist**. No rebuilds, no Docker, no E2B. A problem that looks like infrastructure hell collapses into a binary search over an array.

⚠️ **The one thing that will break this: Deployment Protection.** If the Vercel project has authentication on non-production deployments, every historical URL returns 401. Two fixes:
- Disable Deployment Protection on the demo project (simplest), **or**
- Set `VERCEL_AUTOMATION_BYPASS_SECRET` and send `x-vercel-protection-bypass: <secret>` on every request.

**Verify this works on deploy #2 tonight.** If historical URLs aren't reachable, the entire project is dead and you need to know at 8pm, not 2am.

---

## 5. Honest limitations — put these on a slide

Judges who sell reliability infrastructure will respect stated limits far more than overclaiming.

| Limitation | What we do about it |
|---|---|
| **We bisect code, not data.** Old deploys hit the *current* database. A bug caused by a migration or bad data shows as "broken everywhere" | Endpoint check catches it → report `NO_CLEAN_BOUNDARY`, do not fabricate a commit |
| **The bug must be reachable from a user session.** Backend-only failures invisible to the UI | Optional log source (Sentry/CloudWatch) covers these; otherwise we abstain |
| **Non-deterministic bugs** (races, timing) | Each bisect step runs 2×; disagreement → `INDETERMINATE`, step to neighbour, flag reduced confidence |
| **Bug predates the deploy window** | Oldest deploy also fails → report `PREDATES_WINDOW` with the window we searched |
| **Third-party-caused failures** | Bisect finds no boundary; localization reports the failing external call instead |

---

## 6. Data contracts

Write `src/types.ts` **first**. Every module talks through these; once committed, work parallelises cleanly.

```ts
// ─── 1. INTAKE ────────────────────────────────────────────────────
export interface Ticket {
  id: string;
  source: 'intercom' | 'slack' | 'github' | 'manual';
  reporter_email: string;
  body: string;                       // raw, messy, human
  reported_at: string;                // ISO
  parsed: {
    symptom: string;                  // "checkout spinner never resolves"
    surface: 'ui' | 'api' | 'unknown';
    time_window: { from: string; to: string };   // fuzzy → concrete
    entities: string[];               // "checkout", "payment", "order"
  };
}

// ─── 2. CORRELATION ───────────────────────────────────────────────
export interface CandidateSession {
  session_id: string;
  person_id: string;
  started_at: string;
  duration_ms: number;
  match_score: number;                // 0..1 symptom alignment
  match_reasons: string[];            // "rageclick on [data-testid=pay]", "reached /checkout, never /order/*"
  replay_url: string;                 // PostHog deep link — goes in the Slack message
  event_count: number;
}

export interface SessionEvent {
  ts: number;                         // ms since session start
  kind: 'pageview' | 'click' | 'input' | 'submit' | 'rageclick' | 'network' | 'console' | 'custom';
  url?: string;
  selector?: string;                  // derived from elements_chain
  text?: string;                      // $el_text
  value_shape?: 'email' | 'number' | 'text' | 'card';   // NEVER the raw value — see §11
  status?: number;
  detail?: Record<string, unknown>;
}

// ─── 3. REPRO ─────────────────────────────────────────────────────
export interface ReproScript {
  ticket_id: string;
  session_id: string;
  code: string;                       // Playwright TS source
  steps: { idx: number; action: string; selector: string; note: string }[];
  assertion: string;                  // the observable failure condition
  fixtures: Record<string, string>;   // synthetic test data replacing real PII
  compile_confidence: number;
}

export type ReproVerdict = 'REPRODUCED' | 'NOT_REPRODUCED' | 'FLAKY' | 'COMPILE_FAILED';

export interface ReproResult {
  verdict: ReproVerdict;
  runs: { idx: number; failed: boolean; duration_ms: number; artifacts: Artifact[] }[];
  consistency: number;                // failed_runs / total_runs
  observed: string;                   // what actually happened
}

// ─── 4. BISECT ────────────────────────────────────────────────────
export interface Deploy {
  uid: string;
  url: string;                        // immutable, directly runnable
  created_at: string;
  sha: string;
  message: string;
}

export type BisectStatus =
  | 'FOUND'              // clean good→bad boundary
  | 'PREDATES_WINDOW'    // oldest deploy already broken
  | 'NO_CLEAN_BOUNDARY'  // non-monotonic → likely data/env, not code
  | 'INDETERMINATE';     // repro too flaky to bisect

export interface BisectResult {
  status: BisectStatus;
  last_good?: Deploy;
  first_bad?: Deploy;
  probes: { deploy: Deploy; runs: boolean[]; verdict: 'good' | 'bad' | 'indeterminate' }[];
  window: { oldest: string; newest: string; count: number };
  total_runs: number;
  duration_ms: number;
}

// ─── 5. LOCALIZATION ──────────────────────────────────────────────
export interface CodeLocation {
  file: string;
  line_start: number;
  line_end: number;
  confidence: number;
  reasoning: string;
  evidence_refs: string[];            // REQUIRED non-empty
}

// ─── 6. BLAST RADIUS ──────────────────────────────────────────────
export interface BlastRadius {
  signature: string;                  // the HogQL behavioural pattern
  affected_users: number;
  affected_sessions: number;
  complained: number;                 // almost always 1
  since: string;                      // = first_bad.created_at
  churn_signal?: { returned: number; did_not_return: number };
  mrr_at_risk_usd?: number;           // Stripe join
}

// ─── 7. EVIDENCE + REPORT ─────────────────────────────────────────
export interface Artifact {
  id: string;                         // "shot_03", "net_07", "con_01", "probe_d061_run2"
  kind: 'screenshot' | 'video' | 'gif' | 'network' | 'console' | 'dom' | 'trace' | 'probe_log';
  uri: string;
  meta: Record<string, unknown>;
}

export interface Investigation {
  ticket: Ticket;
  session?: CandidateSession;
  repro?: ReproScript;
  repro_result?: ReproResult;
  bisect?: BisectResult;
  locations: CodeLocation[];
  blast?: BlastRadius;
  artifacts: Artifact[];
  outcome:
    | 'DIAGNOSED'          // reproduced + bisected + localised
    | 'REPRODUCED_ONLY'    // reproduced, no clean commit boundary
    | 'CANNOT_REPRODUCE'   // honest abstention
    | 'ALREADY_FIXED'      // repro fails on prod, succeeds on an older deploy
    | 'INSUFFICIENT_DATA'; // no matching session
  confidence: number;
  stats: { duration_ms: number; cost_usd: number; browser_runs: number };
}
```

---

## 7. Component specifications

### 7.1 Intake — `intake/` (Vercel Edge Function)

~40 lines. Verifies the webhook signature, normalises to a `Ticket`, fires `repository_dispatch`:

```
POST /repos/{owner}/bisect/dispatches
{ "event_type": "investigate", "client_payload": <Ticket> }
```

Thin intake + heavy worker on Actions gives you a real "deployed product" surface with zero ops. For the demo, also support `workflow_dispatch` with a pasted ticket body — **webhooks fail live; always have a button.**

### 7.2 Correlate — `correlate/`

1. **Person lookup.** `GET /api/projects/:id/persons/?search=<email>` → `person_uuid`.
2. **Session candidates.** Recordings for that person inside `parsed.time_window`.
3. **Symptom matching.** For each session pull events via the Query API (HogQL):

```sql
SELECT timestamp, event, properties.$current_url, properties.$el_text,
       properties.$event_type, elements_chain
FROM events
WHERE properties.$session_id = {session_id}
ORDER BY timestamp ASC
```

Score by: `$rageclick` present · `$exception` present · entity keywords in URL/`$el_text` · **entered a funnel and never exited it** (the classic silent-failure shape).

4. Return top-3 `CandidateSession`s. The winner's `replay_url` goes into Slack so a human can watch the same thing the agent watched.

> **Build note:** compile from **autocapture events** (`$autocapture`, `$pageview`, `$rageclick`, with `elements_chain` and `$el_text`), *not* from raw rrweb snapshots. Autocapture is already semantic; rrweb is a DOM mutation log and will eat your night. Keep rrweb as a tier-3 fallback.

### 7.3 Compile — `compile/`

**Hybrid, not pure LLM.** Deterministic templating does the mechanical work; the model does judgement only.

- *Deterministic:* map each `SessionEvent` to a Playwright call. `elements_chain` → a stable selector, preferring `data-testid` → `getByRole` → `getByText` → CSS path (last resort).
- *Model (`claude-opus-5`):* drop noise steps, infer the **assertion** (what observable condition constitutes the failure), substitute synthetic fixtures for PII, name the test.

```ts
// generated: ticket t-1181 · session 0198f2c1 · confidence 0.86
test('checkout spinner never resolves after Pay', async ({ page }) => {
  await page.goto('/cart');
  await page.getByTestId('add-to-cart').click();
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByLabel('Card number').fill(FIXTURES.card);
  await page.getByTestId('pay').click();
  // ASSERTION — the observable failure
  await expect(page.getByTestId('order-confirmation')).toBeVisible({ timeout: 15_000 });
});
```

This file is the product artefact: it ships in the PR as a permanent regression test.

### 7.4 Reproduce — `reproduce/`

Run ×3 against current production.

| Outcome | Meaning | Next |
|---|---|---|
| 3/3 fail | `REPRODUCED` | → bisect |
| 0/3 fail | `NOT_REPRODUCED` | → check `ALREADY_FIXED` (run against a pre-window deploy); else abstain |
| 1–2/3 fail | `FLAKY` | → bisect with 2× probes and reduced confidence |

**Abstention is a feature.** `CANNOT_REPRODUCE` with an honest account of what *did* happen is a valid, scored outcome.

### 7.5 Bisect — `bisect/` ⭐

**No LLM anywhere in this module.**

```
deploys = vercel.list({ target: 'production', state: 'READY', limit: 100 })
          .filter(inWindow).sort(byCreatedAt)      // oldest → newest

// 1. endpoint verification (parallel)
if (!fails(newest))  → ALREADY_FIXED
if ( fails(oldest))  → PREDATES_WINDOW

// 2. binary search
lo = 0, hi = n-1
while (hi - lo > 1) {
  mid = (lo + hi) >> 1
  v = probe(deploys[mid])              // run repro 2×
  if (v === 'indeterminate') { mid±1; if still indeterminate → INDETERMINATE }
  v === 'bad' ? hi = mid : lo = mid
}
→ last_good = deploys[lo], first_bad = deploys[hi]

// 3. sanity: re-probe both boundary deploys once more.
//    Non-monotonic result → NO_CLEAN_BOUNDARY (likely data/env, not code)
```

Every probe emits a `probe_log` artifact. The probe ladder is the demo's centrepiece — render it.

Budget: 20 deploys → 2 endpoint + ~5 steps × 2 runs ≈ 12 runs × ~20 s, parallelism 3 → **~90 seconds**.

Then: `GET /repos/{o}/{r}/compare/{last_good.sha}...{first_bad.sha}` → the diff.

### 7.6 Localize — `localize/` (`claude-opus-5`)

**Input:** the breaking diff, the repro assertion, failure artifacts (console, failed requests, final URL, screenshot).
**Output:** ranked `CodeLocation[]` with required `evidence_refs`.

Enforced in code after the model responds:
- empty `evidence_refs` → drop the location
- a ref not present in `artifacts` → strip it; if none remain, drop
- no locations survive → downgrade to `REPRODUCED_ONLY` and report the diff without a line claim

Prior: files in the diff that appear in the failing request path or the failing component's import chain rank higher.

### 7.7 Quantify — `quantify/`

Derive a behavioural signature from the repro (entered funnel step A, never reached step B within 5 min), then:

```sql
SELECT count(DISTINCT person_id) AS affected
FROM events
WHERE timestamp > {first_bad.created_at}
  AND person_id IN (reached step A)
  AND person_id NOT IN (reached step B)
```

Optional Stripe join by email → `mrr_at_risk_usd`.

Output line: **"1 person complained. 847 hit it. 196 never came back. $4.2k MRR."**

Cheapest high-impact module in the codebase. Do not skip it — it's the most quotable sentence in the demo and it speaks directly to Userlens.

### 7.8 Decide — `decide/`

⚠️ **Slack interactive buttons require a public request URL.** You are on Actions. Do not build a Slack interactivity endpoint.

**Instead:** post the findings with `chat.postMessage`, then poll `reactions.get` every 5 s for up to 5 minutes:

- ✅ → approve: implement the fix
- 🎫 → ticket only
- ❌ → discard, log the human's disagreement (**this is eval data — record it**)
- timeout → default to ticket-only

Zero infrastructure, and reacting to a message demos better than clicking a button anyway.

### 7.9 Resolve — `resolve/`

**Always:** Linear issue via GraphQL `issueCreate` — title, repro steps, evidence links, PostHog replay link, bisect ladder, blast radius, severity.

**On ✅ approval:** patch the localized site (`claude-opus-5`) → **re-run the repro (must now pass)** → **re-run all stored repros from previous investigations (must all still pass)** → open the PR containing the fix *and* `tests/repro/t-1181.spec.ts`.

```
🔧 Fix verified
   repro t-1181  FAIL → PASS
   14 stored repros  still green
   bisect confirmed: abc123 introduced, this reverts the behaviour
```

**"Proposed fix" vs "verified fix" is a one-word difference that is actually a category difference.** Never open a PR whose repro hasn't flipped.

---

## 8. Repository layout

```
bisect/
  action.yml
  package.json  tsconfig.json
  src/
    index.ts                 # orchestrator
    types.ts                 # ← WRITE FIRST
    config.ts
    intake/{normalize,dispatch}.ts
    correlate/{posthog,persons,sessions,score}.ts
    compile/{events,selectors,template,llm}.ts
    reproduce/{runner,consistency}.ts
    bisect/{vercel,search,probe}.ts        # no LLM
    localize/{diff,rank,enforce}.ts
    quantify/{signature,hogql,stripe}.ts
    decide/slack.ts
    resolve/{linear,patch,pr}.ts
    evidence/{store,gif}.ts
    report/{slack,linear,markdown}.ts
  intake-fn/api/webhook.ts   # Vercel Edge Function
  fixtures/ tickets.json sessions/ dispatch.json
  benchmark/ cases/ labels.json run.ts SCORECARD.md

acme-shop/                   # the app under test
  app/ (cart, checkout, order, api/*)
  scripts/seed-deploys.ts    # ships N real deploys
  scripts/simulate-users.ts  # generates real PostHog sessions
```

---

## 9. The demo app — `acme-shop`

A checkout flow. *"I can't complete my order"* is the most emotionally legible bug on earth, and checkout is a funnel, which gives blast radius for free.

| Route | Behaviour |
|---|---|
| `/` `/product/:id` | catalogue |
| `/cart` | add/remove, `data-testid="add-to-cart"` |
| `/checkout` | address + card form, `data-testid="pay"` |
| `/order/:id` | confirmation, `data-testid="order-confirmation"` |
| `POST /api/checkout` | validates, creates order, returns `{ orderId }` |

Next.js 15 on Vercel, PostHog snippet with autocapture + session recording, `data-testid` on every interactive element (it makes the compiler's job tractable — and it's what a real customer would already have).

### The hero bug — introduced at deploy #13

```diff
- if (res.status === 200) { router.push(`/order/${json.orderId}`); }
- else { setError(json.message); setLoading(false); }
+ if (res.status === 200) { router.push(`/order/${json.orderId}`); }
+ else if (res.status >= 500) { setError(json.message); setLoading(false); }
+ // 402 (card declined) falls through: spinner spins forever, no error, no exception
```

Perfect properties: **no exception**, **nothing in Sentry**, **200-level monitoring stays green**, unit tests pass, types check. Only a real user hitting a declined card sees it. This is the silent failure, and it is the entire pitch in nine lines of diff.

---

## 10. Fixtures — the critical path

**This is the biggest risk in the project. Start here tonight, before any agent code.**

### Phase F1 — deploy history (~60 min)

`scripts/seed-deploys.ts` ships **18–22 real production deploys**: small, plausible commits (copy tweaks, a component extraction, a dependency bump, styling). **The hero bug lands at deploy #13.** Space them so timestamps look like three weeks.

✅ **Immediately verify old deploy URLs load without auth.** If Deployment Protection blocks them, fix it now — everything depends on it.

### Phase F2 — real sessions (~60 min)

`scripts/simulate-users.ts` drives Playwright against production with the PostHog snippet live, producing **genuine** recordings and events:

| Persona | n | Path |
|---|---|---|
| happy buyer | 12 | completes checkout |
| declined card | 9 | **hits the bug** — rage-clicks Pay, abandons |
| browser | 15 | never reaches checkout |
| cart abandoner | 8 | leaves at cart |
| slow/flaky | 4 | throttled network |

Same script writes `benchmark/labels.json`. Real browsers ⇒ real replays ⇒ your compiler is tested against genuine data, not mocks.

⚠️ PostHog ingestion lag: events ~30–60 s, recordings can take several minutes. Seed early, verify late.

### Phase F3 — tickets (~30 min)

20 complaints in realistically bad English, mapped to ground truth:

| Ticket | Truth |
|---|---|
| "checkout broken just spins" | `DIAGNOSED` → `abc123`, `useCheckout.ts` |
| "cant pay. tried 3 times. nothing" | `DIAGNOSED` → same |
| "payment page stuck" *(different user, different day)* | `DIAGNOSED` → same |
| "site is slow" | `CANNOT_REPRODUCE` |
| "button doesnt work" *(no session found)* | `INSUFFICIENT_DATA` |
| "cart empties randomly" *(fixed at deploy #7)* | `ALREADY_FIXED` |
| "order total wrong" *(bad seed data, not code)* | `NO_CLEAN_BOUNDARY` |
| …14 more across the classes | |

**Class distribution:** 8 diagnosable · 4 not reproducible · 3 already fixed · 2 no clean boundary · 3 insufficient data.

Twelve of twenty have "the correct answer is not a commit." That's deliberate — the abstention metric is your differentiator.

---

## 11. Privacy, safety, security

| Concern | Handling |
|---|---|
| Session replays contain **real user PII** | The compiler emits `value_shape`, never raw values. All inputs replaced with `FIXTURES.*` before the script is written or logged |
| Repro runs against **production** | Read-only paths where possible; a `X-Bisect-Synthetic: 1` header lets the app route to test payment rails and exclude from analytics |
| Ticket text is **attacker-controlled** | Fenced as `<untrusted_ticket>` with an explicit never-follow-instructions rule. One benchmark ticket is a prompt injection and passing it is a scored result |
| Agent can **write code** | Only behind the Slack ✅ gate; opens a PR, never pushes to main, never merges |
| Secrets | GitHub Actions secrets; `GITHUB_TOKEN` for PR creation, scoped to `contents: write, pull-requests: write` |

---

## 12. Evaluation — the 25%

### Metrics

```
Session correlation (correct session in top-1)     17/20
Repro compilation succeeded                        17/20
Reproduction verdict correct                       18/20
  └─ correctly NOT reproduced                        4/4      ← abstention
BISECT ACCURACY (commit == ground truth)           8/8   100%  ← deterministic
Root-cause file @1                                 6/8
Root-cause file @3                                 8/8
FALSE DIAGNOSES (named a commit, was wrong)        0/20        ← the trust metric
ALREADY_FIXED detected                             3/3
NO_CLEAN_BOUNDARY detected                         2/2
Prompt injection resisted                          1/1
Median time to diagnosis                           4m 12s
Median cost per investigation                      $0.21
Median browser runs per investigation              14
```

### Why these specifically

- **Bisect accuracy is a proof, not a score.** No LLM in the loop → given a deterministic repro, it is correct by construction. Say that sentence.
- **False diagnoses is the trust metric.** A debugging agent that confidently names the wrong commit is worse than none. Target zero, and design abstentions to protect it.
- **Correct-abstention rate** is the one nobody else will have. *"On 12 of 20 tickets the right answer was not a commit. We got 11."*

### Harness

`benchmark/run.ts` runs all 20 with `--replay` artefacts cached, emits `SCORECARD.md` and a single PNG for the video. Budget 90 minutes; it is worth more than any feature you could build in the same time.

---

## 13. Build phases — 0 to hero

> **Hard rule: the skeleton runs end-to-end before any module gets depth.** Phases 0–2 contain almost no AI.

### PHASE 0 — Foundations · ~90 min · *tonight, first*

| | Task | Done when |
|---|---|---|
| 0.1 | `acme-shop` scaffolded, cart→checkout→order works | you can buy something locally |
| 0.2 | Deployed to Vercel, production live | public URL works |
| 0.3 | **Verify Deployment Protection is off / bypass token works** | an old deploy URL loads in an incognito window |
| 0.4 | PostHog installed: autocapture + session recording | a manual checkout shows up as a replay |
| 0.5 | All accounts + tokens: PostHog, Vercel, GitHub, Slack, Linear, Anthropic | every key in a `.env` |

**0.3 is a go/no-go gate. Do it before anything else.**

### PHASE 1 — Fixtures · ~2.5 h · *tonight*

| | Task | Done when |
|---|---|---|
| 1.1 | `seed-deploys.ts` → 18–22 production deploys, bug at #13 | `vercel ls` shows the history |
| 1.2 | Manually confirm deploy #12 works and #13 hangs | you've seen the bug with your own eyes |
| 1.3 | `simulate-users.ts` → 48 real sessions | PostHog shows replays across all personas |
| 1.4 | `tickets.json` — 20 labelled complaints | `labels.json` complete |

### PHASE 2 — Walking skeleton · ~1.5 h

| | Task | Done when |
|---|---|---|
| 2.1 | `types.ts` committed | compiles; teammates unblocked |
| 2.2 | Action on `repository_dispatch` posting "investigating…" to Slack | a dispatch produces a Slack message |
| 2.3 | `--ticket fixtures/tickets.json#t-1181 --dry-run` local loop | iteration takes 5 s, not 3 min |
| 2.4 | Hardcoded repro → run against prod → post PASS/FAIL + screenshot | **demoable product exists here** |

### PHASE 3 — Correlate · ~1.5 h
PostHog person lookup → sessions → event fetch → symptom scoring. **Done when** ticket `t-1181` resolves to the correct session and the Slack message carries a working replay link.

### PHASE 4 — Compile · ~2.5 h
Selector derivation, deterministic templating, LLM assertion inference, PII fixtures. **Done when** ≥ 12 of 20 sessions compile to scripts that run.

### PHASE 5 — Bisect · ~2 h ⭐
Vercel list, endpoint verification, binary search, probe logging, all four statuses. **Done when** `t-1181` returns deploy #13 / the correct SHA, with a printable probe ladder.

### PHASE 6 — Localize · ~1.5 h
Diff fetch, ranking, evidence enforcement. **Done when** a fabricated evidence ref is stripped and the location dropped — *demo this*.

### PHASE 7 — Quantify · ~45 min
Signature query, affected count, return rate. **Done when** the number appears in Slack.

### PHASE 8 — Decide + Resolve · ~2 h
Slack post + reaction polling; Linear `issueCreate`; on ✅ patch → repro flips → suite green → PR with the regression test.

### PHASE 9 — Evaluate · ~1.5 h
Benchmark runner, `SCORECARD.md`, one chart PNG. **Do not skip — this is 25%.**

### PHASE 10 — Ship · ~1.5 h
README + architecture diagram + reliability brief + 2-minute video. **Freeze code 30 minutes before judging.**

### Tier 3 — only if ahead
`--replay` mode (renders a cached investigation with zero API calls — your insurance policy) · Sentry/CloudWatch backend source · Stripe MRR join · proactive scan for unreported bugs · rrweb fallback compiler.

### Explicitly NOT building
Multi-repo support · a web dashboard · self-healing selectors · multi-browser/mobile · real-time streaming UI · auth/billing/multi-tenancy · E2B *(Vercel's deploy history replaces it entirely)*.

---

## 14. Config

```ts
export const CONFIG = {
  models: {
    compile:  'claude-opus-5',      // assertion inference — judgement
    localize: 'claude-opus-5',      // reasoning over the diff
    triage:   'claude-sonnet-5',    // ticket parsing, session scoring
  },
  repro:  { runs: 3, timeoutMs: 30_000 },
  bisect: { maxDeploys: 40, probeRuns: 2, parallel: 3, windowDays: 21 },
  slack:  { pollIntervalMs: 5_000, timeoutMs: 300_000 },
  localize: { maxLocations: 3, minConfidence: 0.25 },
};
```

Secrets: `ANTHROPIC_API_KEY` · `POSTHOG_API_KEY` + `POSTHOG_PROJECT_ID` · `VERCEL_TOKEN` (+ `VERCEL_AUTOMATION_BYPASS_SECRET`) · `GITHUB_TOKEN` · `SLACK_BOT_TOKEN` · `LINEAR_API_KEY` · *(opt)* `STRIPE_SECRET_KEY`

---

## 15. Demo — 2 minutes

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:15 | **The problem.** "No exception. No alert. Sentry is empty. The user just left." | the ticket: *"checkout broken it just spins"* |
| 0:15–0:35 | **It finds the user's actual session.** 4 s of the real PostHog replay — rage-clicking Pay | replay + "compiled to a test" |
| 0:35–0:50 | **It reproduces.** 3/3 runs fail on production | the generated `repro.spec.ts` |
| 0:50–1:15 | **The bisect ladder.** ⭐ the centrepiece | `d-041 ✅ d-052 ✅ d-058 ✅ d-061 ❌ d-060 ✅ → abc123` |
| 1:15–1:30 | **The diff + blast radius** | "1 complained. 847 hit it. 196 never returned. $4.2k MRR" |
| 1:30–1:45 | **Human approves in Slack → verified fix** | repro FAIL→PASS, 14 repros still green, PR with the regression test |
| 1:45–1:57 | **The scorecard** | **bisect accuracy 8/8 · false diagnoses 0/20 · correct abstentions 11/12** |
| 1:57–2:00 | **Close** | *"Every other tool reads your code and guesses. We ran your app fourteen times."* |

**Record the run in advance.** A live agent run during judging is four minutes of dead air. Show the recording; keep `--replay` ready if they ask.

---

## 16. Risks

| Risk | P | Mitigation |
|---|---|---|
| **Deployment Protection blocks old URLs** | med | **Gate 0.3 tonight.** Bypass header or disable protection. Project-ending if unchecked |
| PostHog ingestion lag during the demo | med | Seed fixtures hours early; `--replay` mode for judging |
| Repro compiler fails on messy sessions | **high** | `data-testid` everywhere; accept 60% compile rate and *report it* — a stated limit beats a hidden one |
| Old deploys share the current DB | med | Documented as a known limit; `NO_CLEAN_BOUNDARY` handles it honestly |
| Investigation too slow for a live demo | med | Parallel probes; pre-recorded video is the primary artefact |
| Anthropic rate limits at 4pm | low | `--replay` renders a cached investigation with zero API calls |
| Slack interactivity needs an endpoint | **certain** | Poll reactions — decided, §7.8. Do not attempt buttons |

---

## 17. Team split

Once `types.ts` lands:

- **A — Fixtures & app:** `acme-shop`, deploy seeding, user simulation, ticket labels, benchmark data
- **B — Data plane:** PostHog correlation, HogQL, blast radius, Vercel client, Slack/Linear
- **C — Agent plane:** repro compiler, reproduce runner, bisect search, localization, evidence

Three tracks, one interface file, minimal conflicts. If solo: Phases 0–2 tonight, 3–6 in the morning, 7–10 in the window, drop Phase 7 and tier 3 first.

---

## 18. Submission checklist

- [ ] Public repo + README + architecture diagram
- [ ] `SCORECARD.md` with all 20 benchmark results
- [ ] Reliability brief — system design, the four abstention modes, stated limitations (§5)
- [ ] 2-minute video
- [ ] A Linear ticket and a PR that the agent actually created, linked
- [ ] All five app integrations demonstrably firing
- [ ] `--replay` mode working (judging insurance)

---

## 19. Start here — tonight, in order

1. `npx create-next-app@latest acme-shop` — cart → checkout → order, `data-testid` on everything
2. Deploy to Vercel. **Open an old deployment URL in an incognito window.** If it 401s, fix it now — nothing else matters until this works
3. Install PostHog, do one manual checkout, confirm the replay appears
4. `seed-deploys.ts` — 18–22 deploys, hero bug at #13
5. `simulate-users.ts` — 48 sessions
6. Commit `types.ts`
7. Make the Action post "investigating…" to Slack

Step 2 is the go/no-go for the entire project. Step 7 is the moment it becomes real.

# BISECT v1 — The Basic Pipeline

**Goal:** one script that takes a bug report from Slack, finds what actually happened in PostHog, figures out which code is responsible, and files a Linear ticket about it.

No bisect. No repro compiler. No Vercel. Those are v2 — see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

**Build this first and get it working end to end. Everything else is an upgrade to a step that already exists.**

---

## 1. What v1 does

```
Someone types in #bugs:
   "checkout is broken for jane@acme.com, she says it just spins after clicking pay"
                              │
   1. LISTEN     poll Slack → new message in #bugs
   2. PARSE      Claude → { email, symptom, surface, time window }
   3. TRACE      PostHog → find her session → what she actually did
   4. LOCATE     URL + failed request → candidate files → read them
   5. DIAGNOSE   Claude → what's wrong, which file, what to change
   6. REPORT     Linear ticket + Slack reply with the link
```

One process. No server, no webhooks, no deploy. It polls Slack, does the work, posts back.

---

## 2. The apps

| App | What it gives you | Why it's essential |
|---|---|---|
| **Slack** | the report (vague, human) + where the answer goes | the claim |
| **PostHog** | what the user *actually did* — events, URLs, failed requests, rage clicks | the reality |
| **GitHub** | the code | the cause |
| **Linear** | the ticket | the resolution |

Remove PostHog and you're an LLM guessing from a sentence. That's the whole difference.

---

## 3. The pipeline, step by step

| # | Step | Input | Output | How |
|---|---|---|---|---|
| 1 | **Listen** | — | raw Slack message | `conversations.history`, poll every 5s, track last seen `ts` |
| 2 | **Parse** | message text | `{ email, symptom, entities[], window }` | one `claude-sonnet-5` call, tool-use for clean JSON |
| 3 | **Trace** | email + window | session event list | PostHog: person lookup → session → events |
| 4 | **Locate** | URL + failed API path | 3–6 candidate files with contents | route→file convention, then read |
| 5 | **Diagnose** | events + file contents | `{ cause, file, lines, suggested_change, confidence }` | one `claude-opus-5` call |
| 6 | **Report** | everything | Linear issue + Slack reply | `issueCreate` mutation, `chat.postMessage` |

---

## 4. The one data shape

```ts
export interface Investigation {
  // 1 listen
  slack: { channel: string; ts: string; text: string; user: string };

  // 2 parse
  report: {
    email: string | null;
    symptom: string;              // "checkout spinner never resolves after Pay"
    entities: string[];           // ["checkout", "payment"]
    window: { from: string; to: string };
  };

  // 3 trace
  session: {
    id: string;
    replay_url: string;
    events: {
      ts: string;
      kind: 'pageview' | 'click' | 'rageclick' | 'error' | 'custom';
      url?: string;
      text?: string;              // button label
    }[];
    failed_requests: { method: string; path: string; status: number }[];
    last_url: string;
    rage_clicks: number;
  } | null;                       // null = no session found, abstain

  // 4 locate
  candidates: { path: string; reason: string; content: string }[];

  // 5 diagnose
  diagnosis: {
    cause: string;
    file: string;
    lines: [number, number];
    suggested_change: string;
    confidence: number;
    evidence: string[];           // which events/requests support this
  } | null;

  // 6 report
  linear_url?: string;
  outcome: 'DIAGNOSED' | 'NO_SESSION' | 'NO_DIAGNOSIS';
}
```

That's it. One object flows through six functions.

---

## 5. Files

```
bisect/
  src/
    index.ts          # the loop: poll → run pipeline → post
    types.ts          # the Investigation interface above
    steps/
      1-listen.ts
      2-parse.ts
      3-trace.ts
      4-locate.ts
      5-diagnose.ts
      6-report.ts
    clients/
      slack.ts posthog.ts github.ts linear.ts anthropic.ts
  fixtures/
    messages.json     # canned Slack messages for offline dev
  .env
```

Run it with `npm run dev`. Add `--message fixtures/messages.json#m1` to skip Slack and iterate in 5 seconds instead of 30.

---

## 6. API cheat sheet

### Slack — `SLACK_BOT_TOKEN` (`xoxb-`)

Scopes: `channels:history`, `chat:write`, `channels:read`.

```
Read:   POST https://slack.com/api/conversations.history
        { channel, oldest: <last_seen_ts>, limit: 20 }

Write:  POST https://slack.com/api/chat.postMessage
        { channel, thread_ts: <original ts>, text | blocks }
```

Poll every 5s, keep `last_seen_ts` in memory. Ignore messages from bots (`subtype === 'bot_message'`) or you'll reply to yourself forever.

### PostHog — `POSTHOG_API_KEY` (personal API key) + `POSTHOG_PROJECT_ID`

**Find the person:**
```
GET /api/projects/{project_id}/persons/?search={email}
→ results[0].id / distinct_ids
```

**Find their events** (Query API, HogQL):
```
POST /api/projects/{project_id}/query/
{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT timestamp, event, properties.$current_url,
                     properties.$el_text, properties.$session_id
              FROM events
              WHERE distinct_id = {id}
                AND timestamp > {from} AND timestamp < {to}
              ORDER BY timestamp ASC
              LIMIT 300"
  }
}
```

Events you care about: `$pageview`, `$autocapture` (clicks — read `$el_text`), `$rageclick`, `$exception`.

**Replay link:** `https://app.posthog.com/project/{project_id}/replay/{session_id}` — put it in the Linear ticket and the Slack reply. A human watching the same thing the agent watched is very convincing.

> Verify endpoint shapes against current PostHog docs — their API moves. If the Query API fights you, the older `/api/projects/:id/events/?distinct_id=` endpoint is a fine fallback for v1.

### GitHub — `GITHUB_TOKEN`

For v1 just clone the repo once at startup and read from disk. Simpler and faster than the API.

```bash
git clone --depth 50 https://github.com/you/acme-shop /tmp/repo
```

### Linear — `LINEAR_API_KEY`

```
POST https://api.linear.app/graphql
Authorization: <LINEAR_API_KEY>          # no "Bearer"

mutation {
  issueCreate(input: {
    teamId: "...", title: "...", description: "...markdown..."
  }) { success issue { id identifier url } }
}
```

Get `teamId` once via `query { teams { nodes { id name } } }`.

---

## 7. Step 4 — how to find the code without building RAG

Don't build embeddings. Use the framework's own conventions — in Next.js the URL *is* the file path:

```
PostHog says the user was last at  /checkout
  → app/checkout/page.tsx

PostHog says POST /api/checkout returned 402
  → app/api/checkout/route.ts

Then add the imports of those two files (one level deep)
  → components/CheckoutForm.tsx, lib/payment.ts
```

That's 4–6 files, deterministic, no guessing, and it lands directly on the right code almost every time. Fall back to `ripgrep` on the symptom keywords only if the convention map produces nothing.

**This is the step that makes v1 feel smart.** The failed network call is the highest-signal piece of data you have — a 402 on `/api/checkout` plus a spinner that never resolves tells you almost exactly what's wrong before Claude reads a single line.

---

## 8. Step 5 — the diagnosis prompt

Give Claude four things:

1. The symptom (from the Slack message)
2. **The event timeline** — what the user actually did, in order
3. **The failed requests** — method, path, status
4. The candidate file contents, with line numbers

Ask for structured output via tool-use:

```
cause              one sentence: what is broken and why
file, lines        where
suggested_change   what to change (description, not a patch)
confidence         0..1
evidence           which timeline events / requests support this
```

**Two rules to enforce in code after the response:**

- Empty `evidence` → force `outcome: 'NO_DIAGNOSIS'`. No unsupported claims reach a human.
- `confidence < 0.4` → file the Linear ticket with the trace attached but **no** code claim. A ticket that says "here's the session, here's the failed request, I'm not sure why" is still genuinely useful.

---

## 9. Abstention — build this in v1, not later

Three outcomes, all valid:

| Outcome | When | What you post |
|---|---|---|
| `DIAGNOSED` | session found + confident diagnosis | full ticket: cause, file, suggested change, replay link |
| `NO_SESSION` | no PostHog session matches | *"No session found for jane@acme.com in that window — can you confirm the email or time?"* |
| `NO_DIAGNOSIS` | session found, cause unclear | ticket with the timeline + failed requests, no code claim |

Being honest about what you don't know is the thing this room scores. It's five lines of code and it becomes a metric on your scorecard.

---

## 10. Build order — ~5 hours

| # | Block | Est | Done when |
|---|---|---|---|
| 0 | `.env` with all 4 tokens; `acme-shop` deployed with PostHog + the checkout bug | 60m | one manual broken checkout shows up as a PostHog session |
| 1 | `types.ts` + Slack poll loop that echoes messages to console | 30m | typing in `#bugs` prints to your terminal |
| 2 | Step 6 first (backwards!) — post a hardcoded Linear ticket + Slack reply | 30m | **a message in Slack produces a Linear ticket. Skeleton complete.** |
| 3 | Step 2 parse + Step 3 trace | 75m | the Slack reply contains the real PostHog replay link and the event timeline |
| 4 | Step 4 locate | 45m | logs show the right 4–6 files for `/checkout` |
| 5 | Step 5 diagnose + evidence enforcement | 60m | ticket names the right file and cites the 402 |
| 6 | Abstention paths + polish the ticket markdown | 45m | all three outcomes work on three different test messages |

**Build step 6 before steps 2–5.** Get a message in Slack to produce a ticket in Linear on day one, even with fake content. Then replace the fake parts one at a time. A shallow pipeline that runs beats a deep one that doesn't.

---

## 11. Demo for v1

```
[#bugs]  jane from support: "checkout is broken for jane@acme.com,
         she says it just spins after clicking pay"

[bisect] 🔍 investigating…

[bisect] Found Jane's session from 14:02 — 6 min, 3 rage clicks on "Pay"
         ▶ watch replay

         What actually happened:
           14:02:11  /checkout
           14:02:44  click "Pay"
           14:02:45  POST /api/checkout → 402
           14:02:51  rage click "Pay" ×3
           14:04:20  left the page — never reached /order/*

         Diagnosis (confidence 0.87)
           app/checkout/CheckoutForm.tsx:47
           The 402 branch is never handled — only >= 500 sets an error
           state, so a declined card leaves the spinner running forever.
           No exception is thrown, which is why nothing reached Sentry.

         📋 ACME-214 created
```

That's the entire product and it's genuinely impressive on its own.

---

## 12. What v1 deliberately skips → v2

| v2 upgrade | Which step it plugs into | Why it's worth it later |
|---|---|---|
| Compile the session into a Playwright repro | after 3 | proves the bug is real instead of asserting it |
| **Bisect over Vercel deploy history** | after repro | names the exact breaking commit, deterministically |
| Blast radius ("847 users hit this") | after 3 | the most quotable line in the demo |
| Slack ✅ approval → auto-fix PR | after 6 | closes the loop |
| Benchmark + scorecard | around all | the 25% reliability score |

Every one of these slots into a step that already exists in v1. That's why you build v1 first.

---

## 13. Tonight/this morning, in order

1. `acme-shop` deployed on Vercel with PostHog installed and the checkout bug live
2. Do one broken checkout by hand — confirm the session appears in PostHog with the 402
3. Slack app: bot token, `channels:history` + `chat:write`, invite it to `#bugs`
4. Linear: API key + team ID
5. `types.ts`, then the poll loop, then **the hardcoded Linear ticket**
6. Replace the hardcoded parts, one step at a time, in reverse order

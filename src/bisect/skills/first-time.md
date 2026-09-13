# bisect — first-time codebase mapping

This runs once, the first time bisect investigates a bug in a codebase that has no
`bisect-skills/` folder yet. Its job is to figure out which external services this
codebase actually uses for observability (PostHog, Sentry, AWS CloudWatch, etc.) and turn
that into a small, reusable routing skill — so every future bug report can go straight to
"query PostHog like this" instead of rediscovering the codebase from scratch.

This file lives in bisect's own repo, not the target codebase's. It is never written into
`bisect-skills/` — only its output (`skill.md` and `references/*.md`) is.

## What to look for

- **Dependencies** — package.json / requirements.txt / pyproject.toml for known SDKs:
  posthog-js / posthog, @sentry/*, sentry-sdk, @aws-sdk/*, boto3, stripe, datadog, etc.
- **Environment variables** — .env.example or similar for POSTHOG_*, SENTRY_DSN, AWS_*,
  DATADOG_*, and so on. These tell you which services are actually configured, not just
  installed.
- **Actual usage** — grep the source for how each SDK is really called: exact custom event
  names passed to `capture()`, what gets attached via `identify()`, which log groups or
  namespaces are written to, which Sentry tags/contexts are set. Generic library knowledge
  is not enough — the goal is instructions specific to *this* codebase.
- **Infra config** — serverless.yml, terraform, docker-compose.yml, vercel.json, and
  similar files for deployment/runtime signals (Lambda function names, ECS services, log
  groups) relevant to runtime/infra-category bugs.

## What to produce

**One reference file per detected service**, written to
`bisect-skills/references/<service>.md`. Each should be concrete and directly actionable:
what the service is used for here, the relevant env vars, and example queries or lookups
that actually work against this codebase (real event names, real property keys, real log
group names) — not generic documentation about the service in the abstract.

**One routing skill**, written to `bisect-skills/skill.md`. This is read on *every* future
bug report, so keep it short — a few hundred words. It should map bug categories to which
reference file(s) apply, e.g.:

  - UI / product behaviour bugs (button doesn't work, page shows wrong data) -> posthog.md
  - Runtime / server errors, 500s, timeouts -> aws.md / infrastructure.md
  - Payment / billing discrepancies -> stripe.md (if present)

If a category has no matching service, say so — better to route to "no signal available,
rely on the report + code" than to send the investigator down a dead end.

## Constraints

- Only document services you found real evidence of (a dependency + matching env var, or
  actual call sites). Do not invent services this codebase doesn't use.
- Keep `skill.md` short. Put the detail in `references/*.md`, which are only read when
  a bug actually routes to them.
- If nothing is detected at all (no observability service configured), still write a
  minimal `skill.md` saying so — that is itself a useful, honest finding.
- Do not write a copy of these instructions into the target repo. Only `skill.md` and
  `references/*.md` belong there.

# Roadmap

This document tracks shipped versus planned work for `@modelence/benchmark` by release.

For per-scorer mechanics see [METRICS.md](METRICS.md).

---

## Status legend

- ✅ **Shipped** — landed in the named release
- 🚧 **In progress** — committed for the named release, partial or full implementation underway
- 📋 **Planned** — committed for the named release, not yet started
- 💤 **Deferred** — no release commitment yet; tracked here so it doesn't get re-debated

---

## v0.1 — Scoring foundation (shipped)

The initial release. Established the scoring harness, the prompt corpus format, the artifact contract, and the leaderboard. All scorers in this section landed at version `0.1.0`.

### Scoring harness

- ✅ Per-submission orchestration: navigate, capture screenshots, run scorers in dependency order
- ✅ Conditional execution: F1 is a gate; downstream scorers skip when render fails
- ✅ Prompt corpus loader with Zod validation
- ✅ Submission YAML schema and `score-all` batch runner
- ✅ Static HTML leaderboard (`leaderboard.html`)
- ✅ Per-scorer artifact JSON written to `artifacts/<tool>/<prompt>/<run>/`
- ✅ Self-reported cost block (TTFR / TTWB / USD) — informational only, not in composite

### Functional scorers (5)

- ✅ **F1** render — HTTP 2xx + non-empty body within 30s
- ✅ **F2** acceptance — per-prompt `must_have` / `should_have` Playwright assertions
- ✅ **F4** intent judge (initial 4-criteria fixed rubric — extended in v0.2)
- ✅ **F5** errors — console + 4xx/5xx network responses
- ✅ **F6** verbatim — exact strings, hex values, structural identifiers from prompt

### Code quality scorers (9)

- ✅ **C1** lint — ESLint typescript-eslint recommended, normalized per 1k LOC
- ✅ **C2** types — `tsc --noEmit --strict` errors per 1k LOC
- ✅ **C3** a11y — axe-core WCAG 2.1/2.2 AA violations per 1k DOM nodes
- ✅ **C4** Lighthouse — performance score, mobile-throttled 3-run median (initial single-timeout version — replaced in v0.2)
- ✅ **C5** bundle size — uncompressed source bytes (replaced in v0.2 with gzipped network measurement)
- ✅ **C6** complexity — cognitive complexity via eslint-plugin-sonarjs
- ✅ **C7** maintainability judge — LLM judge over sampled source excerpt
- ✅ **C8** install — `npm ci` (or pnpm/yarn) succeeds from a clean checkout
- ✅ **C9** SEO — title / meta / canonical / OG / JSON-LD / lang / heading hierarchy

### Visual scorers (3)

- ✅ **V1** visual judge — LLM judge over 3 screenshots (initial fixed 8-criteria rubric — extended in v0.2)
- ✅ **V2** design heuristics — initial 4 layout checks (whitespace, contrast, font size, line length)
- ✅ **V4** responsive — viewport tests at 360×800, 768×1024, 1440×900 + mobile touch targets

### Security scorers (3)

- ✅ **S1** secrets — initial 8-pattern regex scan (extended in v0.2 with header audit + Semgrep + trufflehog)
- ✅ **S2** auth patterns — 13 deterministic anti-pattern checks (Supabase service-role keys in client code, Firebase test mode, JWT decode without verify, Stripe/OpenAI keys in client bundle, hardcoded admin emails/passwords, password reset without token)
- ✅ **S3** vulnerabilities — `npm audit` weighted by severity

### Composite

- ✅ Unweighted mean across non-null scorers (replaced in v0.2 with dimension-weighted composite)

### Tooling

- ✅ Single CLI entrypoint (`commander`-based)
- ✅ Live console progress with per-scorer pass/score lines
- ✅ Subcommands: `tools`, `prompts`, `submit`, `score`, `score-all`, `report`

---

## v0.2 — Signal quality and shippability (in progress)

Focus: improve the signal quality of each scorer, make C4 robust against hangs, fold per-prompt criteria into the judge scorers, and reshape the corpus to test something more interesting than landing pages alone. Most of this section has shipped; the remaining items are the corpus reshape and two small scoring additions.

### Composite weighting

- ✅ Dimension-weighted composite (Functional 47% / Code Quality 18% / Visual 24% / Security 11%)
- ✅ Within-dimension scorer weights (e.g. F2 = 45% of Functional, V1 = 55% of Visual)
- ✅ Null-scorer renormalization within dimension; empty-dimension renormalization across dimensions
- ✅ Per-dimension breakdown printed alongside composite in console output
- ✅ Per-dimension columns in the leaderboard, between composite and per-scorer columns
- ✅ Weight badges on per-scorer column headers + glossary cards in the report

### Scorer extensions

- ✅ **C4** robustness rewrite (`0.2.0`): per-run 90s + overall 240s timeouts, Chrome restarted between runs, tolerates ≥1 successful run, explicit Lighthouse `maxWaitForLoad`/`maxWaitForFcp`. Resolved batch stalls.
- ✅ **C5** gzipped network measurement (`0.2.0`): primary signal is `Content-Length` from `page.on('response')` for JS/CSS; falls back to uncompressed source bytes when no network capture is available. Lighthouse-aligned thresholds.
- ✅ **C8** clean-install scorer (new in v0.2): runs `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` in a clean temp dir. Catches committed `package.json` files that don't actually install.
- ✅ **V1** per-prompt visual checklist (`0.2.0`): 8 visual defaults + 3 copy-quality defaults (no SaaS-speak, no fabricated trust signals, CTA verb specificity) + per-prompt `visual_checklist.extra`; copy-quality skipped when `placeholder_copy: true`.
- ✅ **V2** CSS convention signals (`0.2.0`): 4 → 8 checks. Added `box-sizing: border-box` rate, `@media (prefers-reduced-motion)` presence, ≥5 distinct CSS custom properties, `:focus-visible` rule presence. Graceful null-handling when stylesheets are CORS-blocked.
- ✅ **F4** per-prompt functional checklist (`0.2.0`): 4 default criteria + per-prompt `functional_checklist.extra`.
- ✅ **F2** setup actions (`0.2.0`): each acceptance criterion may carry an optional `setup: []` array of state-mutating actions (`evaluate` / `fill` / `click` / `press` / `reload` / `waitFor`) that run before the locator is evaluated. Unlocks stateful testing — empty-state checks, persistence-across-reload, CRUD-after-action — without which Tier 2+ apps can only verify shape, not behavior.
- ✅ **S1** secrets + headers + external scanners (`0.3.0`): added deployed HTTP header audit (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy). Added optional Semgrep (`p/secrets` + `p/owasp-top-ten`) and trufflehog filesystem scanners; findings unioned across regex + Semgrep + trufflehog. Each external scanner is independently optional.

### Corpus reshape

- ✅ Dropped landing-page-heavy v0.1 corpus (6 landing prompts) in favor of a tier-stratified corpus
- ✅ Tier 1: one landing page (`nimbus-notes-landing`, kept from v0.1)
- ✅ Tier 2: single-user todo app with localStorage (`todo-localstorage`) — exercises state, persistence, CRUD, empty-state
- ✅ Moved other v0.1 landing prompts to `prompts/landing-extra/` for ad-hoc use
- ✅ Default empty-state acceptance criterion documented in the README's "Adding a prompt" section, demonstrated on the Tier 2 app

> **Tier 3 (backend-bearing CRM) is not part of v0.2.** It requires submission-flow and scorer changes that exceed v0.2's scope. See v0.3 below.

### Documentation

- ✅ [METRICS.md](METRICS.md) — full per-scorer spec including weights, rationale, and gap analysis
- ✅ [README.md](README.md) — repo overview, all 19 scorers with their composite weights, install + usage
- ✅ [ROADMAP.md](ROADMAP.md) — this file
- ✅ README caveat: backend correctness, auth correctness, and server-side security are out of scope for v0.2 and land in v0.3

---

## v0.3 — Backend-bearing app track and judge reliability (planned)

Focus: extend the corpus to a backend-bearing Tier 3 CRM (real auth, real persistence, real cross-session checks), close the remaining judge-reliability gaps (cross-family dual-judge protocol), and add a calibration pipeline. This is the biggest scope-expanding release on the roadmap.

### Backend-bearing app track

The driving change: **a Tier 3 CRM prompt that ships with a real backend** (Supabase, Firebase, or whatever the tool uses natively). This requires submission-flow changes and new scorers. Tools that don't ship a backend (Claude Artifacts, frontend-only v0 deploys) will score N/A on Tier 3 — that's an honest answer to "does this tool ship a real CRM?"

- ✅ **Tier 3 prompt authored** (`prompts/corpus/crm-contacts.yaml`): multi-user "Rolodex" CRM — email/password auth, per-user contact lists, server-side data isolation. Declares `backend_probes` (unauth GET + cross-user GET) for the planned S4 scorer. F2 must_have covers the logged-out auth screen (testable today); authenticated-view criteria are should_have until the F7 login driver lands. Not yet referenced in `submissions.yaml`, so it does not score until a CRM submission is added.

#### Submission contract

- ✅ Optional `backend_url` field in `submissions.yaml` (often same as frontend, sometimes a separate API host) — Phase 0 contract (`core/backend.ts`)
- ✅ Optional `signup_credentials` block — two test accounts (A/B) + auth mode (supabase / bearer_login / cookie_session)
- ✅ `seed_strategy: signup_each_run | pre_seeded` — controls how F7/F8 reset state between runs; plus `seed_records` (known B-owned record + synthetic marker) for the S4 cross-user probe
- ✅ `backend_probes` field on the prompt schema — read-only `unauth_get` / `cross_user_get` declarations (consumed by S4)
- 📋 Per-tool backend documentation in README — what each tool ships, what users have to wire up

> **Phase 0 shipped (schema-only):** the submission + prompt contract above is implemented and validated; no scorer consumes it yet. F7/F8/S4 (Phase 2) build on it. See [docs/s4-backend-security-plan.md](docs/s4-backend-security-plan.md).

#### New scorers

- ✅ **F7** auth round-trip (`0.1.0`, Phase 2) — login → create a marked record → log out → log in again → record persists. Drives the deployed login form via Playwright; N/A without `backend.signup_credentials`. `src/scorers/functional/f7-auth-roundtrip.ts`.
- ✅ **F8** backend persistence across sessions (`0.1.0`, Phase 2) — record created in browser context A must appear in a fresh incognito context B after login. Distinguishes localStorage tools from real-backend tools. `src/scorers/functional/f8-cross-session.ts`.
- 📋 **F9** scheduled-job execution — verifies cron / scheduled work both *exists* (config file present and parseable: `vercel.json` cron section, Supabase `pg_cron` enabled, Inngest / Trigger.dev registration) and *runs correctly* (harness POSTs to a force-trigger endpoint declared in the prompt's acceptance YAML, then verifies the side effect with timestamped fixture data). Currently unscored anywhere; AI tools handle scheduled work very inconsistently — broken cron config, stubs, hallucinated services.
- ✅ **S4** backend security (`0.1.0`, Phase 2) — read-only runtime probes: unauthenticated GET (must be rejected) + cross-user GET (user A must not read user B's data). Supabase + bearer_login auth; `cross_tenant_leak` headline. Catches the canonical "Supabase RLS off" failure that S2 only catches via *client-side* hints. `src/scorers/security/s4-backend.ts`.

S4 is the single biggest *security* signal-quality win in v0.3 — S2 catches code patterns that suggest auth is broken; S4 catches the actual server-side failure. F9 (still 📋) closes the previously-unscored cron / scheduled-work gap.

#### Within-dim weight model: backend scorers are additive (shipped)

F7/F8/S4 ship **additive** rather than narrowing F2/S1/S2/S3 for everyone. Each non-backend dimension still sums to 100; the backend scorers (F7 8, F8 7, S4 15) sit on top. Because they return null on non-backend submissions, null-renormalization divides only by the present scorers' weight-sum — so Tier 1/2 submissions score *exactly* as before (Functional /100, Security /100), while Tier 3 backend submissions reflow over the larger denominator (Functional /115, Security /115). This supersedes the earlier "narrow F2 to 30%" plan, which would have silently rescored every existing non-backend submission. F9 will follow the same additive model when it lands.

#### Discipline

- 📋 No automated signup for tools that prohibit it (confirmed banned on Lovable). Sign-up is a documented manual step that produces credentials in `submissions.yaml`.
- 📋 Test accounts use a recognizable domain (e.g. `bench-<run-id>@<your-domain>.test`)
- 📋 Random-email-per-run reset strategy documented; users can opt into pre-seeded accounts if they care about not littering the tool's database

### Judge reliability

- 📋 Cross-family dual-judge protocol for V1, F4, and C7. One rollout serves all three. Mitigates self-preference bias when a tool's backing LLM matches the judge's model family (Lovable uses Claude Sonnet — a Claude-only judge inflates Lovable scores by 5–10pp per the bias literature).
- 📋 Disagreement flagging logic: when two judges disagree by >1 point on any criterion, flag for manual review or call a third judge.
- 📋 Krippendorff's α calibration pipeline. Standalone CLI subcommand that takes a JSON file of human ratings + the corresponding judge outputs and computes α. Validates whether the judges actually correlate with human judgment. Requires a one-time pass to gather ~50 human-rated examples per dimension.

### Architecture & schema deterministic checks

Promoted from 💡 design-only to 📋 v0.3 because they address classes of failure that C7's LLM rubric was previously asked to cover by judgment alone — moving them to deterministic backbones is exactly the kind of vague-signal-replacement that LLM-judge work should yield to.

- 📋 **C10** project structure — ~6 framework anti-pattern checks: file-layout sanity, client/server boundary correctness in Next.js (no server-only imports in `'use client'` files or descendants), db / data-access not called from inside React component render paths, pages directory free of business logic. Framework-specific patterns declared per adapter.
- 📋 **C12** schema-design quality (app track only) — ~12 deterministic patterns over emitted schema files (Prisma, Drizzle, raw SQL, Supabase): foreign-key constraints present, NOT NULL on identity columns, indexes on FK columns, `created_at` / `updated_at` timestamps, unique constraints on natural keys, RLS policies on user-scoped tables for Supabase, absence of JSON blobs where joins would be appropriate, consistent on-delete behavior. Catches schema rot — the most expensive AI-tool failure mode, invisible to F7/F8/S4 which only test the backend *works*, not whether the schema is *reasonable*.

#### C7 within-dim weight narrows when C10/C12 ship

C7's LLM rubric currently spans naming, separation of concerns, component reuse, prop typing, secret handling, *and* implicit architecture/schema judgments. When C10 + C12 land, C7 contracts to its core "abstraction boundaries / prop-typing / pattern consistency" scope and a portion of its within-dim weight transfers to C10 (~5–8%) and C12 (~6–8%, app-track only). Documented as a v0.3 weighting change.

### Scorer additions and refinements

- 📋 **F1** dynamic per-prompt timeout from `baselineBuildSeconds` in prompt YAML — prevents false-positive timeouts on heavier prompts
- 📋 **C5** route-split count + license-hygiene scan (the two C5 sub-checks not covered by gzipped payload alone)
- 📋 **C6** duplication detection via `jscpd` — completes AST complexity sub-checks
- 📋 **V2** typographic hierarchy depth + color count/harmony — remaining V2 gaps after the v0.2 CSS-signal additions
- 📋 **V3** reference-design fidelity (CLIP + Block-Match + Sørensen-Dice + position + CIEDE2000) — enables prompts with reference images ("make it look like Linear"). Requires both V3-aware prompts and the Design2Code metric stack.
- 📋 **S3** `osv.dev` cross-check — catches CVEs not yet in the npm advisory feed
- ✅ **S2** secure-by-default patterns (`0.2.0`): added `xss_unsanitized_html` (high — `dangerouslySetInnerHTML`/`innerHTML`/`v-html` with no in-file sanitizer), `insecure_transport` (medium — disabled TLS verify or plaintext `http://` request target), `sensitive_data_logged` (medium — `req.body`/auth headers/secret-named bindings logged). Closes P2 "secure code-generation defaults" gaps from the Lovable × AIUC-1 whitepaper analysis ([docs/whitepaper-gap.md](docs/whitepaper-gap.md) §3). 13 → 16 patterns.
- 📋 **S2** quarterly pattern refresh process — keeps auth anti-patterns current as Supabase/Firebase/Clerk evolve

### Cost instrumentation

- 📋 Harness-instrumented timing layer replacing self-reported cost. Replaces user-entered TTFR / TTWB with measured wall-clock from the (forthcoming) automated-mode adapters for tools with public APIs (v0 Platform API, bolt.diy Docker, Anthropic Messages API).

---

## v0.4 — Deep backend correctness, RBAC, and API security

Focus: extend backend testing from "does it work?" (v0.3) to "does it work *correctly and securely* under adversarial conditions?". Three themes: (1) request-interception layer that enables token replay and cross-user API probes without UI heuristics; (2) a role-bearing corpus prompt that unlocks RBAC testing; (3) data-integrity and contract-validation scorers that close the silent-failure gap. This is the largest security-depth expansion on the roadmap.

### Request interception layer (prerequisite for most v0.4 scorers)

All v0.3 scorers drive the app exclusively through the UI and infer backend behavior from DOM changes. v0.4 adds a thin interception layer to `auth.ts` / `orchestrate.ts` that captures session tokens and raw request/response bodies during a Playwright run, then replays modified requests directly against the API. This is the architectural step v0.3 deliberately deferred.

- 📋 Session-token capture: extract the live auth credential (cookie, `Authorization` header, or localStorage `access_token`) at the moment the dashboard first loads, after a successful login
- 📋 Raw request body capture for write endpoints: record the exact body format (JSON, form-encoded, GraphQL mutation) of create/update/delete operations as the harness drives them, so replay probes use the real shape
- 📋 Replay helper: `replayAs(token, method, url, body)` — issues a fetch with the supplied token, returns `{ status, body }`; used by S4-extension scorers and the new F9/F10 scorers below

### New corpus prompt: role-bearing app (prerequisite for RBAC scorers)

The `crm-contacts` prompt has only one role (authenticated user). RBAC testing requires a prompt with at least two roles.

- 📋 **Tier 3 role-bearing prompt** — e.g. "Team Notes" or "Project Board": org owner + member roles. Owner can invite members, delete any item in the org; members can create and edit their own items only. Declares `roles` block in the submission YAML (`owner_a`, `member_b`). Acceptance criteria cover: member cannot delete owner's items, member cannot access admin/settings routes, owner can see all members' items.

### Backend functional scorers (new)

- 📋 **F9** delete correctness — drive the UI delete control on a known marker record; reload as the same user; assert the record is gone. Then attempt to replay the delete request as a *different* user (using the replay helper) and assert rejection (403/404) + record still present for the original owner. Closes the "cross-user delete" gap: the prompt requires server-side enforcement but nothing in v0.3 tests it at runtime.
- 📋 **F10** write-operation error handling — POST a contact with a missing required field (blank name), oversized field (>10k chars), and duplicate-natural-key where applicable; assert each returns a structured 4xx (not 200, not 500) and no record is created. Tests that the backend validates inputs rather than silently accepting or crashing. N/A for prompts that do not declare `error_cases` in their acceptance YAML.
- 📋 **F11** list ordering — create two records with known markers in sequence; reload; assert the DOM order matches newest-first (or the order declared in the prompt). Catches tools that return records in insertion order from the DB but reverse them client-side, breaking on reload.

### Server-side logout validation (F7 extension)

- 📋 **F7 v0.2**: after logout, replay the pre-logout session token against the data endpoint using the replay helper; assert the response is 401/403. Catches tools that only clear client state (localStorage/cookie) without invalidating the session server-side. Stored in F7's step list as `server_side_logout_invalidation`; scored as a 7th step.

### API security scorers (S4 extensions + new)

- 📋 **S4 v0.2 — IDOR detail probe**: S4 already discovers user B's record ID via `extractIdentifier`. Add a second probe: replay `GET /contacts/<B_id>` and `DELETE /contacts/<B_id>` as user A (using the replay helper); assert both return 4xx and the record survives. Closes S4's own documented scope gap (list-only vs. per-record endpoints).
- 📋 **S4 v0.2 — Mass-assignment probe**: replay the captured create-contact request body with injected fields (`"userId": B_id`, `"role": "admin"`, `"id": "<forced>"`) as user A; assert the response does not reflect the injected ownership, and B's account is unaffected. Uses the captured request body format so the probe matches the real API shape.
- 📋 **S5** RBAC enforcement (role-bearing prompt only) — using the role-bearing corpus prompt and the two credential pairs (`owner_a`, `member_b`): (1) member attempts to hit owner-only routes/mutations declared in the prompt's `rbac_boundaries`; assert 403. (2) Vertical escalation: member replays owner-level request body; assert rejection. (3) Field-level: assert member's list response does not contain other members' private fields. N/A on non-role-bearing prompts.
- 📋 **S6** rate-limiting probe — fire N rapid identical requests (default: 20 in 5s) at the login endpoint and at the primary write endpoint; assert at least one 429 (or equivalent backoff signal) appears within the burst. Not a pass/fail gate — scores 1.0 if any 429 observed, 0.5 if requests slow down detectably but no 429, 0.0 if all succeed at full speed. N/A on static/frontend-only submissions.

### Data integrity (new)

- 📋 **F12** unique-constraint enforcement — create a contact with a natural key (e.g. email address); attempt to create a second with the identical key; assert the second request returns 4xx and only one record exists in the list. Requires the prompt to declare `unique_fields`. Tests that the backend enforces uniqueness server-side, not just client-side form validation.
- 📋 **C12** schema-design quality (promoted from v0.3 📋, same spec) — ~12 deterministic patterns over emitted schema files (Prisma, Drizzle, raw SQL, Supabase migrations): FK constraints, NOT NULL on identity columns, FK-column indexes, `created_at`/`updated_at` timestamps, unique constraints on natural keys, RLS policies on user-scoped tables (Supabase), absence of JSON blobs where joins are appropriate, consistent `ON DELETE` behavior. Source-only; N/A without source ZIP.

### Frontend↔backend contract (new)

- 📋 **F13** API response contract — using the replay helper, fetch the authenticated data endpoint and Zod-validate the response against a per-prompt `response_schema` declared in the prompt YAML (field names, types, required fields). Assert that every field the UI is expected to render (from the prompt's acceptance criteria) is present in the response with the correct type. Catches tools that hardcode/mock data the backend doesn't actually serve, and detects silent field-name mismatches.

### Composite weight additions

F9–F13 and S5–S6 follow the same additive model as F7/F8/S4: non-backend submissions score null and null-renormalization preserves existing proportions exactly. Role-bearing-prompt scorers (S5) are additionally null on non-role submissions.

Provisional additive weights (within-dimension): F9 6, F10 4, F11 3, F12 3, F13 4 (Functional total +20); S5 12, S6 8 (Security total +20). Final weights set at ship time after calibration against ≥3 submissions.

---

## Deferred indefinitely

Items the research design explicitly de-prioritizes or that don't pay back the implementation cost. Not committed to any release.

- 💤 **V5** animation/interaction polish — research rates this as "noise below the top quintile"
- 💤 **Multi-turn iterative track (T4, T5)** — would require session-state management across turns and significant adapter complexity
- 💤 **Private prompt split + contamination rotation** — only needed once public scores stabilize and contamination becomes a real risk
- 💤 **Live tool-drift time series** — operational concern; needs weekly runner infrastructure that doesn't exist yet

---

## Design proposals not yet on the roadmap

Research positions tracked here so they don't get re-debated. None are committed to a release.

### Scorer-level proposals

- 💡 **C11 readability (deterministic anchors)** — would replace the vague-LLM portion of C7's rubric (naming, function/file-length distributions, comment density and quality) with anchor-based deterministic scoring. Held until v0.3's dual-judge upgrade for C7 ships, since the dual-judge protocol may close enough of the readability variance gap to make C11 redundant. Decision lands after C7 dual-judge measures the residual variance.

### Corpus-level proposals (anti-saturation defenses)

These are harness-level rules — not scorers — that protect the leaderboard's discriminative signal as the corpus saturates. Relevant only after sustained leaderboard runs reveal saturation; no urgency until v0.3 has 2+ quarterly refreshes on record.

- 💡 **Auto-retirement of saturated prompts** — any prompt where median tool composite ≥90 across three consecutive quarterly runs auto-retires and replaces with a freshly-authored prompt from the harder end of the difficulty distribution. Saturated prompts produce no ranking signal but still consume credits.
- 💡 **Hard Mode subset** — permanent 10–20 prompt subset deliberately authored such that the best current tool scores ≤50% on composite. Anti-saturation safety valve borrowed from GPQA's "designed-at-the-ceiling" approach and SWE-bench's Verified/Pro splits. When the main corpus saturates, Hard Mode is where the ranking actually happens.
- 💡 **Pairwise Bradley–Terry fallback when scores cluster** — when composite spread across the leaderboard falls below 5 points for two consecutive quarterly runs on a given track, a pairwise dual-MLLM judging layer activates as the primary ranking; absolute 0–100 scores remain published as the diagnostic view. Third line of defense after auto-retirement and Hard Mode; only fires when those two stop being enough.

### Other research positions

- 💡 **Prompt-robustness track** — tests how tools handle ambiguous / self-contradictory prompts; novel dimension.
- 💡 **Structured self-repair sub-track** (LiveCodeBench pattern) — deterministic test-trace injection as the next turn, instead of free-form follow-ups. Refines the iterative track that's currently deferred.

---

## Release process

When a release ships:

1. Update the version constants on every scorer that changed in this release
2. Move the relevant items in this file from 📋/🚧 to ✅
3. Update the per-scorer notes in [METRICS.md](METRICS.md)'s scorer version history table
4. Update the metric tables in [README.md](README.md) if any scorer changed semantics
5. Bump `package.json`'s `version` field to match the release tag
6. Add a dated entry to [CHANGELOG.md](CHANGELOG.md) summarizing what shipped (Added / Changed / Fixed / Removed groupings)
7. Tag the commit `v0.X.Y`

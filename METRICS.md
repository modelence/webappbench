# Benchmark Metrics Reference

This document describes every scorer in the benchmark harness, the rationale behind each metric, gaps versus the research design, and recommended changes for future versions.

---

## Scoring architecture

### Composite score

The composite is a **weighted mean of dimension scores**. Each dimension is itself a weighted mean of its scorers. When a scorer's score is null (skipped, N/A, or missing source), its weight redistributes proportionally across the other scorers in its dimension. When a whole dimension has no contributing scorers, that dimension drops out and its weight redistributes across the remaining dimensions.

#### Dimension weights

| Dimension | Research weight | Implemented weight |
|---|---|---|
| Functional correctness | 40% | 47% |
| Code / output quality | 15% | 18% |
| Visual design quality | 20% | 24% |
| Security | 10% | 11% |
| Cost / speed | 15% | 0% (informational only) |

Cost is **informational by design, not folded into the composite.** This is a deliberate choice rather than a temporary measurement gap: (a) tools' credit-system heterogeneity (Lovable messages, Bolt tokens, Replit credits per Lite/Economy/Power mode) makes USD-equivalent normalization a contestable judgment call rather than a measurement, (b) folding cost into the composite invites Goodhart-style optimization where a tool wins the leaderboard by dropping price rather than improving output, (c) the per-dimension leaderboard already exposes cost as a column for cost-conscious readers without polluting the headline. Cost values appear on the leaderboard as a separate column block — readers optimizing for cost-efficiency see TTFR / TTWB / USD-equivalent directly, but those values are never weighted into the composite. The research's 15% Cost weight is redistributed proportionally across the four scoring dimensions; the implemented dimension weights normalize to 100%.

#### Within-dimension scorer weights

**Functional (47% of composite)** — sum to 100% within the dimension:

| Scorer | Weight | Composite contribution |
|---|---|---|
| F1 render | 15% | 7.05% |
| F2 acceptance | 45% | 21.15% |
| F4 intent judge | 10% | 4.7% |
| F5 errors | 5% | 2.35% |
| F6 verbatim | 25% | 11.75% |

Research has F3 (spec-based e2e tests) at 25% within Functional. F3 isn't implemented (app-track only), so its weight redistributes to F2 (+15%) and F6 (+10%) — the deterministic siblings.

**Backend-track Functional scorers (additive, v0.3).** F7 (auth round-trip, weight 8) and F8 (cross-session persistence, weight 7) sit *on top of* the 100 above rather than carving into it. They return null on any submission without a `backend` block, so null-renormalization (below) divides only by the present scorers' weight-sum: Tier 1/2 submissions divide by 100 and score exactly as before, while Tier 3 backend submissions divide by 115 and reflow F7→7% / F8→6% with the others compressing proportionally. This is deliberately *not* the "narrow F2 for everyone" framing — only backend-bearing submissions see the expanded denominator.

**Code Quality (18% of composite)** — sum to 100% within the dimension:

| Scorer | Weight | Composite contribution |
|---|---|---|
| C1 lint | 20% | 3.6% |
| C2 types | 5% | 0.9% |
| C3 a11y | 20% | 3.6% |
| C4 perf | 20% | 3.6% |
| C5 bundle | 5% | 0.9% |
| C6 complexity | 5% | 0.9% |
| C7 maintainability | 15% | 2.7% |
| C8 install | 5% | 0.9% |
| C9 SEO | 5% | 0.9% |

C5's research weight of 10% is split into C5 (5%) + C8 (5%) since the `env_setup_clean` sub-check ships as a top-level scorer.

**Visual (24% of composite)** — sum to 100% within the dimension:

| Scorer | Weight | Composite contribution |
|---|---|---|
| V1 visual judge | 55% | 13.2% |
| V2 design heuristics | 30% | 7.2% |
| V4 responsive | 15% | 3.6% |

Research has V3 (reference fidelity) at 10% and V5 (animation polish) at 5%. Neither is implemented; their combined 15% redistributes proportionally across V1/V2/V4.

**Security (11% of composite)** — sum to 100% within the dimension:

| Scorer | Weight | Composite contribution |
|---|---|---|
| S1 secrets + headers | 40% | 4.4% |
| S2 auth patterns | 35% | 3.85% |
| S3 vuln audit | 25% | 2.75% |

**Backend-track Security scorer (additive, v0.3).** S4 (backend security probes, weight 15) is additive on top of the 100 above, identical in mechanism to F7/F8: null on non-backend submissions (S1/S2/S3 keep their exact 40/35/25), and reflowing in at 15/115 ≈ 13% on backend submissions. S4's runtime probes complement rather than replace S1/S2/S3's code-pattern and dependency signals, so the dimension expands rather than reweighting.

#### Renormalization on null scorers

When a scorer returns `score: null` (skipped, N/A, missing source), its weight is removed from the dimension and the remaining scorers' weights are renormalized to sum to 100% within the dimension. Example: a submission without a source ZIP loses F6, C1, C2, C5, C6, C7, C8, S2, S3 — Functional then becomes a weighted mean of just F1/F2/F4/F5 with weights renormalized from {15, 45, 10, 5} to {21.4%, 64.3%, 14.3%, 7.1%}. If a whole dimension has no contributors (e.g., Security with no source ZIP and unfetchable URL), the dimension drops and its 11% redistributes across the remaining three.

### Conditional execution

F1 is a gate: if the site does not render, all browser-dependent scorers (F2, F4, F5, C3, C4, C9, V1, V2, V4) are skipped and scored as null. Source-dependent scorers (F6, C1, C2, C5, C6, C7, C8, S2, S3) require a source ZIP. S1 has two sub-checks (secrets + deployed headers) and runs whichever inputs are available.

---

## Functional correctness scorers

### F1 — Render success

**What it measures:** Whether the URL responds with HTTP 2xx and paints non-empty content within the timeout.

**How:** Playwright navigates to the URL, waits for network idle (capped at 8s to avoid polling/WebSocket sites), then checks status code and minimum text content (≥10 chars).

**Timeout:** Fixed 30s. The research design recommends a **dynamic timeout** computed as `max(30s, 5 × baseline_build_seconds)` per prompt, sourced from BigCodeBench. This prevents false-positive timeouts on heavier prompts (dashboards, multi-route apps) without giving infinite leeway.

**Score:** Binary — 1 (pass) or 0 (fail).

**Gap vs research:** Research specifies a per-prompt baseline measured from a known-good reference implementation, re-measured quarterly. Not implemented in v0.1.

**Recommended change (v0.2):** Add a `baselineBuildSeconds` field to prompt YAML and use it to compute per-prompt timeouts.

---

### F2 — Acceptance criteria

**What it measures:** How many of the prompt's stated requirements the generated site satisfies, executed as Playwright assertions.

**How:** Each prompt ships a YAML `mustHave` and `shouldHave` list. Each criterion is a Playwright locator expression plus an assertion type (`toBeVisible`, `toHaveCount`, `toHaveCountAtLeast`, or a `boundingBox` comparison). Score formula:

```
score = (mustPassed + 0.5 × shouldPassed) / (mustTotal + 0.5 × shouldTotal)
```

`passed` is true only if all `mustHave` criteria pass.

**Setup actions (v0.2.0):** Each criterion may carry an optional `setup: []` array of state-mutating actions that run **before** the locator is evaluated. This unlocks stateful testing — empty-state checks (clear localStorage + reload), persistence checks (fill + reload + assert), CRUD-after-action checks. Without setup, F2 could only express assertions against a freshly-loaded page; setup makes it possible to verify that the app actually *works*, not just that it has the right shape.

Supported action kinds: `evaluate` (run JS via `page.evaluate`), `fill` (type into a textbox), `click`, `press` (keyboard key), `reload` (`page.reload()`), `waitFor` (wait for a locator to be visible). Steps run sequentially; any failure aborts the criterion with a `setup failed: step N (<kind>): <error>` note. Per-step timeouts: 5s for locator-based actions, 10s for `evaluate`. The Tier 2 corpus prompt [`todo-localstorage.yaml`](../prompts/corpus/todo-localstorage.yaml) is the worked example.

**Within-dimension weight (research):** 30% of the Functional dimension.

**Gap vs research:** The research recommends role/label-based locators only (`getByRole`, `getByLabel`) to survive DOM changes across builds. The current implementation allows arbitrary Playwright expressions — prompt authors should be disciplined about locator choice.

**Recommended change:** Add a lint step on prompt YAML that warns when locators use CSS selectors instead of role/label/text-based ones.

---

### F3 — Absorbed into F2 setup actions (no separate scorer)

The original v0.1 design carved out F3 as a separate spec-based-tests scorer for the app track — synthesized Playwright tests exercising CRUD paths, auth flows, and persistence across reload. **In v0.2, F2's setup-actions extension absorbed this scope.** Each F2 acceptance criterion can now carry a `setup: []` array of state-mutating actions (`evaluate` / `fill` / `click` / `press` / `reload` / `waitFor`) that run before the locator is evaluated, which delivers the same outcome with simpler harness mechanics: stateful tests live in the same YAML alongside static-content tests, and authors don't have to choose between two scorer namespaces.

F3 is therefore retired as a separate scorer. The `f3` ID will not be used. F2's within-dim weight (45%) reflects the absorbed F3 scope; the research design's earlier "F2=30% + F3=25%" framing is superseded.

---

### F4 — LLM-as-judge functional match

**File:** `src/scorers/functional/f4-judge.ts`

**What it measures:** LLM judge scoring whether the page satisfies the functional intent of the prompt — the right features, the right content, the right purpose. Distinct from V1, which scores visual quality only.

**How:** Three screenshots (initial, viewport-mobile, mid-scroll) plus the original prompt and the list of acceptance-criterion IDs are sent to a vision model via OpenRouter. The model scores the criteria on a 1–5 scale; defaults are 4 criteria (`intent_match`, `feature_completeness`, `content_relevance`, `flow_coherence`), plus any prompt-specific extras from the prompt YAML's `functional_checklist.extra` block. It also returns a `missing_features` array listing prompt-named features absent from the screenshots. Score = (mean raw – 1) / 4 normalized to 0–1.

**Per-prompt extras (v0.2.0):** prompt YAML may add additional criteria under `functional_checklist.extra`, each with `id` (snake_case), `label`, and `description`. Extras run alongside the defaults — duplicate ids replace the default with that id (so prompts can override a default's description if needed). See `prompts/corpus/saas-pricing-page.yaml` for an example.

**Calibration:** 1 = wrong page entirely; 3 = satisfies basic intent with some gaps (normal for AI-generated); 5 = fully satisfies all stated requirements.

**Within-dimension weight (research):** 10% of Functional. Paired with F2 so the judge cannot override deterministic checks.

**Why this complements F2:** F2 confirms specific elements exist via locators. F4 catches the broader class of failure where each individual element is present but the page as a whole has drifted from the prompt's intent — generic placeholder copy, missing or stubbed features, sections that don't match the described product.

**Gap vs research:** Single judge only; cross-family dual-judge protocol deferred to v0.4 along with V1's.

**Recommended change (v0.4):** Promote to dual cross-family judges, sharing the V1 second-judge rollout.

---

### F5 — Runtime errors

**What it measures:** Console errors and network 4xx/5xx responses collected during the F1+F2 sweep.

**How:** `page.on('console')` and `page.on('response')` listeners. Third-party analytics domains are whitelisted. Each error is capped at 200 chars; up to 10 of each type collected.

**Score:** `max(0, 1 - totalErrors / 10)` — linear decay, 0 at 10+ errors.

**Within-dimension weight (research):** 5% of Functional.

**Gap vs research:** The research also specifies tracking uncaught promise rejections explicitly. The current implementation captures console errors which include promise rejection stack traces, but does not distinguish them as a separate category.

---

### F6 — Verbatim constraints

**What it measures:** Whether source code honors explicit literal constraints from the prompt: exact copy strings, hex color values, structural attributes (CSS classes, named sections).

**How:** Source ZIP is extracted and scanned (`.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.html`, `.svg`, `.json`). Each constraint uses regex (exact_copy), case-insensitive match (hex_value), or a broader context scan (structural). Score = passed / total.

**Within-dimension weight (research):** 15% of Functional.

**Research rationale:** F6 closes the gap that F2 misses — LLMs routinely substitute "similar" values that satisfy intent but violate literal instructions (`#003366` → "a navy blue", `"Get started free"` → `"Get started for free"`, `React + Vite` → `Next.js`). F2 passes on all three; F6 fails.

**Research anchor:** F6 score 5 = 100% constraints honored, 4 = ≥80%, 3 = ≥60%, 2 = ≥40%, 1 = <40%.

**Passed:** true only if 100% of constraints are found.

**Gap vs research:** The research recommends capping verbatim constraints at 3–8 per prompt to avoid over-specification that games the metric. No enforcement in v0.1 — prompt authors should follow this guideline manually.

---

### F7 — Auth round-trip (v0.3, backend track)

**File:** `src/scorers/functional/f7-auth-roundtrip.ts`

**What it measures:** Whether the deployed backend correctly handles a complete auth lifecycle: log in → create a record with a unique per-run marker → log out → log in again → confirm the record persists. Catches broken sessions, broken signup forms, and writes that don't actually persist server-side — failures that F2's single-session checks miss because they never re-authenticate.

**How:** Runs only when the submission carries a `backend` block with `signup_credentials`. The harness drives the deployed login form via Playwright (resilient email/password/submit heuristics — see `src/scorers/backend/login.ts`), creates a contact named after a unique marker (`F7_CONTACT_<run>_<rand>`), logs out via a log-out/sign-out control, re-navigates and logs in again, and asserts the marker is still visible. The unique marker means the persistence check can't pass on seed data. No automated signup for tools that prohibit it (Lovable bans it; see [[lovable-anti-automation]]) — accounts are supplied via `signup_credentials`, created manually.

**Scoring:** `passed` requires both record creation and post-relogin persistence. Partial credit = fraction of lifecycle steps that succeeded (so a tool that logs in but can't persist scores above zero but below pass).

**Within-dimension weight:** 8, additive on top of the non-backend Functional scorers (which sum to 100). On non-backend submissions F7 is null and the others keep their exact prior proportions; on backend submissions F7 reflows in at 8/115 ≈ 7%.

**N/A handling:** Frontend-only tools (Claude Artifacts, v0 deploys without a backend) and any submission without `signup_credentials` score N/A on F7 — weight redistributes within Functional per §"Renormalization on null scorers".

---

### F8 — Backend persistence across sessions (v0.3, backend track)

**File:** `src/scorers/functional/f8-cross-session.ts`

**What it measures:** Whether state persists to a real backend, not just to localStorage. Create a record in browser context A → open the same URL in a fresh incognito context B → log in → confirm the record is there.

**How:** Two browser contexts via Playwright. Context A (the main page) logs in and creates a contact with a unique marker. Context B — a fresh `browser.newContext()` with clean storage — reopens the deployed URL, logs in with the same credentials, and asserts the marker is visible. Because context B shares no cookies or localStorage with A, a localStorage-only app fails (B's storage is empty) while a real-backend app passes. This is the discriminator F2 alone can't make even with `setup` reload actions, because reload preserves localStorage.

**Scoring:** `passed` requires the record created in A to be visible in the fresh context B (`details.crossedSessions`). Partial credit = fraction of steps succeeded.

**Within-dimension weight:** 7, additive (reflows in at 7/115 ≈ 6% on backend submissions; null otherwise).

**Why this complements F7:** F7 confirms auth round-trip works within one browser session. F8 confirms persistence is server-side, not client-side. Together they verify the backend is real and stateful, not a localStorage-backed simulation.

**N/A handling:** Frontend-only tools score N/A. Tools shipping localStorage-only persistence (the `todo-localstorage` prompt is one) would fail F8 by design — that's the correct signal.

---

### F9 — Scheduled-job execution (planned v0.4, backend track)

**What it measures:** For prompts whose acceptance YAML requires a working scheduled job (e.g., "expense tracker with weekly summary email," "task app with overdue-task auto-reminder"), whether the tool wired up working cron / scheduled-work and whether that work actually runs and produces the expected side effect.

**How (planned):** Two halves. First, **job exists** — config file present and parseable: Vercel `vercel.json` cron section, Supabase `pg_cron` extension enabled with a scheduled query, Inngest / Trigger.dev function registration, etc. Second, **job executes correctly** — the harness POSTs to a force-trigger endpoint exposed by the prompt's acceptance contract, then verifies the side effect with timestamped fixture data (email-send fixture invoked, status field flipped, retention cleanup ran).

The force-trigger endpoint is mandatory in F9-bearing prompts so the harness doesn't wait real time for verification — prompts must declare a mock-driven trigger path in their acceptance YAML.

**Within-dimension weight (planned):** ~5–10% within Functional on prompts that exercise scheduled work; redistributes within Functional per §"Renormalization on null scorers" on prompts that don't.

**Why this matters:** AI tools handle scheduled work very inconsistently. Some emit cron config they can't actually run (Vercel cron without `vercel.json`, Supabase pg_cron without enabling the extension), some stub it, some hallucinate a service entirely. Currently unscored anywhere in the corpus, and the failure modes are invisible to F2 (which doesn't wait for a cron tick) and F4 (which judges screenshots, not background work).

**N/A handling:** Prompts that don't require scheduled work score N/A — F9 only applies when the prompt's acceptance YAML explicitly declares scheduled-work requirements with a force-trigger endpoint.

---

## Code / output quality scorers

### C1 — ESLint (lint density)

**What it measures:** ESLint error and warning density, normalized per 1,000 lines of code.

**How:** Runs `eslint` with `typescript-eslint` recommended + `no-console: warn` + `no-debugger: error`. Issues per 1k LOC = `(errors + 0.1 × warnings) / LOC × 1000`. Score = `max(0, 1 - issuePer1k / 20)`.

**Within-dimension weight (research):** 20% of Code Quality.

**Gap vs research:** The research adds `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks`, and `eslint-plugin-sonarjs` to a pinned `eslint-config-benchmark`. The current config only covers typescript-eslint recommended + two custom rules. Also missing: AST node count normalization for tools that bundle large design-system boilerplate (shadcn/ui inflates LOC without faults).

**Recommended change:** Adopt the full research ruleset. Add AST node count as a secondary normalization denominator alongside LOC.

---

### C2 — TypeScript type safety

**What it measures:** Type errors from `tsc --noEmit --strict`, normalized per 1,000 lines.

**How:** Finds `tsconfig.json` or `tsconfig.app.json`; falls back to a permissive inline config. Ignores missing-module errors (common in AI-generated code without dependencies installed). Score = `max(0, 1 - errorsPer1k / 20)`.

**Within-dimension weight (research):** 5% (halved from prior 10% because strict TypeScript is now the default scaffold in nearly every AI sitebuilder, making type-error counts cluster near zero).

**Gap vs research:** The research recommends a parallel rubric for JS-only outputs (Claude Artifacts in-chat may emit JS). Current implementation handles this via the fallback inline config, but `any`-count proxy via ts-migrate is not implemented.

---

### C3 — Accessibility (axe-core)

**What it measures:** WCAG 2.1/2.2 AA violations from axe-core, normalized per 1,000 DOM nodes.

**How:** `@axe-core/playwright` with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`. Violation count is measured as violating nodes / total nodes × 1000. Score decay: `max(0, 1 - violationsPer1k / 50)`.

**Within-dimension weight (research):** 20% of Code Quality.

**Research note:** Axe + Lighthouse catch only ~30–40% of true accessibility violations. The research recommends complementing with a manual spot rubric on 10% of runs, and running in both light/dark modes with `:focus-visible` forced. These are not automated in v0.1.

**Gap vs research:** Single-state scan only. (CSS signals — `:focus-visible`, `@media (prefers-reduced-motion)` — are now covered in V2 as modern-scaffolding proxies; C3 itself remains a single-state axe scan.)

---

### C4 — Lighthouse performance

**File:** `src/scorers/code-quality/c4-lighthouse.ts`

**What it measures:** Lighthouse mobile-throttled performance score (0–1), plus raw CWV metrics (LCP, FCP, CLS, TBT, Speed Index).

**How (v0.2.0):** Runs Lighthouse up to 3 times in mobile emulation (360×640, 2 dpi) and reports the median of whichever runs succeed. Each invocation owns its own Chrome instance, torn down between runs, so a hung Chromium doesn't poison the next run.

**Robustness budget:**
- **Per-run timeout:** 90 s wall-clock. On timeout the run's Chrome is killed explicitly (the launcher's port may still be held by a hung renderer otherwise) and the next run starts fresh.
- **Overall scorer timeout:** 240 s. If the budget is exhausted before all 3 runs complete, C4 scores whatever succeeded and records the rest as `timeout` outcomes.
- **Lighthouse internal timeouts:** explicit `maxWaitForLoad: 45000`, `maxWaitForFcp: 30000` (Lighthouse defaults have shifted between major versions; pinning these makes results reproducible).
- **Partial-success tolerance:** the scorer returns a score with as few as 1 successful run. If 0 runs succeed (timeout, runtime error, or missing result), `score: null` and `details.note` summarizes what failed.

**Score:** Lighthouse performance category, median of successful runs.

**Within-dimension weight (research):** 20% of Code Quality. Research uses Lighthouse 10 weights: LCP 25%, TBT 30%, CLS 25%, FCP 10%, Speed Index 10%.

**Research anchor for judge rubric:** LCP 5 = <2.0s, 4 = 2.0–2.5s, 3 = 2.5–3.5s, 2 = 3.5–5.0s, 1 = >5.0s. INP: 5 = ≤200ms, 3 = 200–500ms, 1 = >500ms.

**Why the v0.2 robustness rewrite:** v0.1 had no per-run timeout, no overall cap, and required all 3 runs to succeed. Slow networks or sites with hung requests could stall the entire batch for 5+ minutes. The new model bounds total time at 4 minutes worst-case while still producing a score from any run that completes.

**Gap vs research:** Current scorer uses whatever Lighthouse version is installed. The research requires pinning to Lighthouse 12.x with a committed lockfile. Lighthouse uses lab data, not field data — acceptable for leaderboards since we want reproducible conditions, but should be documented in results metadata.

---

### C5 — Bundle payload (gzipped)

**File:** `src/scorers/code-quality/c5-bundle-size.ts`

**What it measures:** The gzipped JS + CSS payload transferred over the wire during page load — the metric that actually maps to time-to-interactive.

**How (v0.2.0):** A passive `page.on('response')` listener attached before navigation captures every `script` and `stylesheet` response during F1 + F2. For each response, transferred bytes come from the `Content-Length` header (gzipped when the server compressed the response, which is the realistic user case). When `Content-Length` is missing — usually chunked transfer-encoding — the listener falls back to reading the response body length. The scorer flags `compressedMeasurement: true` only when every response had a `Content-Length`, so users can tell whether the number is purely gzipped or mixed.

**Score:** Lighthouse-aligned thresholds — 1.0 at ≤170 KB transferred, linear decay to 0 at ≥1 MB. Passed if ≤350 KB.

**Source ZIP fallback:** When no network capture is available (page didn't render or wasn't fetched), C5 falls back to summing uncompressed source bytes from the ZIP using the prior v0.1 thresholds (1.0 at ≤150 KB, decay to 1 MB). The result clearly labels `scoringSource: 'source-fallback'`. If neither network nor source is available, score is null.

**Side-stat:** When source ZIP is present, uncompressed source totals (JS bytes, CSS bytes, file counts) are included in `details.source*` for diagnostics — useful to compare against the gzipped network number.

**Within-dimension weight:** 5% of Code Quality (the research has 10% for the full bundle-and-dependency-hygiene block; C5 carries the bundle half, with `env_setup_clean` split off into C8 and `npm audit` in S3).

**Why it's better than the v0.1 source-byte heuristic:** raw source bytes penalize design-system inclusions (shadcn, Radix, Tailwind utility classes) heavily even when tree-shaking and minification eliminate most of them at build time. A site that imports shadcn and ships 60 KB gzipped is fundamentally different from a site that hand-rolls components and ships the same 60 KB; the v0.1 measurement couldn't distinguish them.

**Gap vs research:** Route-split count not yet measured. License hygiene scan (originally bundled into the research's C5) remains unimplemented.

---

### C6 — AST complexity

**What it measures:** Cognitive complexity violations (SonarJS rule), normalized per 1,000 LOC.

**How:** ESLint with `eslint-plugin-sonarjs/cognitive-complexity` threshold 15. Score = `max(0, 1 - violationsPer1k / 10)`.

**Within-dimension weight (research):** 5% (halved from 10% because sharded-but-functional code is the norm in AI output, making complexity a weak discriminator). Also calls for nesting depth, file-length distribution, and duplication via `jscpd`. Only cognitive complexity is implemented in v0.1.

**Gap vs research:** Duplication detection (`jscpd`) not implemented. File-length distribution not implemented.

---

### C7 — Maintainability judge

**File:** `src/scorers/code-quality/c7-maintainability.ts`

**What it measures:** LLM-assessed maintainability across 5 criteria on a 1–5 scale: `naming`, `separation_of_concerns`, `component_reuse`, `prop_typing`, `secret_handling`.

**How:** Samples up to 12 source files (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`) from the source ZIP, prioritizing entry points (`index.tsx`, `main.tsx`, `app.tsx`), then files in `components/`, `hooks/`, `features/`, `pages/`, then everything else. Within each tier, smaller files come first to fit more variety into the budget. Files >50KB are excluded. The selected excerpt is capped at 12,000 characters (~3k tokens) and sent to a chat model via OpenRouter with a maintainability rubric. Score = (mean raw – 1) / 4 normalized to 0–1.

**Calibration anchor:** 5 = component <150 LOC, single responsibility, fully typed props, no secrets in source; 3 = 150–400 LOC, mixed concerns acceptable (normal for AI-generated code); 1 = >400 LOC components, untyped, mixed concerns, hardcoded secrets.

**Within-dimension weight (research):** 15% of Code Quality.

**Gap vs research:** Single judge only; cross-family dual-judge protocol deferred to v0.4 along with V1's. Sampling is heuristic (path-tier sort by file size) rather than diversity-weighted; could miss representative files in unusual project structures.

**Recommended change (v0.4):** Promote to dual cross-family judges, sharing the V1 second-judge rollout. Consider AST-based file scoring (component count, prop interfaces detected) to drive sampling instead of path heuristics.

---

### C8 — Clean install (env setup)

**File:** `src/scorers/code-quality/c8-install.ts`

**What it measures:** Whether the committed `package.json` + lockfile actually installs cleanly from a fresh checkout — no workarounds, no patched `node_modules`, no `--legacy-peer-deps`.

**How:** Detects EVERY package manager with a committed lockfile (`pnpm-lock.yaml`/`pnpm-workspace.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, `bun.lock`/`bun.lockb` → bun) — a project may ship more than one. Copies the source tree to a fresh temp directory (per attempt, excluding `node_modules`/`.git`/build artifacts) and runs the strict frozen install for each: `npm ci --ignore-scripts` / `pnpm install --frozen-lockfile --ignore-scripts` / `yarn install --frozen-lockfile --ignore-scripts` / `bun install --frozen-lockfile --ignore-scripts`. 240s timeout per attempt. Every failed attempt is classified — `private_registry` (lockfile pins an unreachable `*.pkg.dev`/GitHub Packages/JFrog/CodeArtifact host behind a 401/403), `damaged` (unparseable/corrupt lockfile), `out_of_sync` (stale lockfile vs `package.json`), or `other` — and the classification is recorded in `details.attempts[]` and `details.lockfileIssues[]`.

**Score:** Graded. **0** if no committed lockfile installs cleanly (the install itself is the floor signal); when every failed attempt is `private_registry`, `details.failureCause = "private_registry"` with the offending hosts. If at least one lockfile installs, the score starts at **1.0** and deducts for lock-file hygiene defects: duplicate lockfiles −0.15, each out-of-sync lockfile −0.20, each damaged lockfile −0.20, each broken private-registry sibling −0.20, floored at **0.5** (a working install never scores below half). All deducting issues are enumerated in `details.lockfileIssues[]`. Missing `package.json` returns null (not applicable); no manager found on PATH returns null (harness gap). Try-all-managers means an extra stale lockfile next to a working one no longer fails the project outright — it installs (via the good lockfile) and is docked for the hygiene defect instead.

**Within-dimension weight (research):** Sub-check 1 of C5 in the research design (10% of Code Quality, split across three sub-checks). Promoted to a top-level scorer here because the failure mode it catches is qualitatively different from bundle-size measurement.

**Why this matters:** AI sitebuilders' hosted environments hide install failures — Lovable/Bolt's runtime has stale `node_modules` from when the tool worked. The committed `package.json` often doesn't actually install on a clean checkout. Nothing else in the harness catches this; C5 measures bundle size on whatever files exist regardless of whether deps would install.

**Gap vs research:** No detection of explicit workarounds (e.g., flagging `--legacy-peer-deps` if a tool's CI script uses it). The `out_of_sync`/`damaged` classification is heuristic (matched against each manager's frozen-install error text), so an unusual error phrasing falls back to `other`.

---

### C9 — SEO hygiene

**File:** `src/scorers/code-quality/c9-seo.ts`

**What it measures:** Whether the generated site includes standard SEO metadata.

**How:** Runs in the browser after F1. Checks that are applicable to the prompt (configured via `seoApplicable` in prompt YAML):
- `title`: 10–70 chars, not generic
- `meta_description`: 50–300 chars
- `canonical`: present, valid URL
- `og_tags`: og:title, og:description, og:type
- `twitter_card`: present
- `json_ld`: ≥1 block
- `lang`: ≥2 chars
- `heading_hierarchy`: exactly 1 H1, no skipped levels
- `robots_txt`: HEAD request returns 200
- `sitemap_xml`: HEAD request returns 200

Score = passed / total applicable checks.

**Within-dimension weight (research):** 5% of Code Quality. The research adds this because AI sitebuilders routinely ship React SPAs with zero SEO metadata — a strong discriminator. Penalty only applies when the item is applicable to the prompt/page type.

**Gap vs research:** The research also specifies hreflang tags for multi-language prompts. Not implemented in v0.1.

---

### C10 — Project structure (planned v0.4)

**What it measures:** Deterministic AST + filesystem inspection for framework anti-patterns that catch concrete failure modes the LLM judge (C7) catches inconsistently and ESLint (C1) doesn't catch at all.

**How (planned):** ~6 framework-specific patterns, declared per detected adapter:

- **File-layout sanity** — presence of conventional directories for the detected framework (`app/` or `pages/` for Next.js; `src/components/`, `src/lib/`, `src/hooks/` patterns)
- **Client/server boundary correctness** in Next.js — no server-only imports (`fs`, `node:*`, server-only env vars) in files marked `'use client'` or descending from one
- **Db / data-access not called from inside React component render paths** — anti-pattern: `prisma.user.findMany()` directly in a component body
- **Pages directory free of business logic** — logic lives in `lib/` or route handlers, not page modules

**Within-dimension weight (planned):** ~5–8% within Code Quality, sourced from C7 narrowing. C7's LLM rubric was previously asked to cover architecture by judgment alone; moving project-structure checks to a deterministic backbone lets C7 contract to its core "appropriateness of abstraction boundaries / prop-typing quality / pattern consistency" scope.

**Promotion rationale:** Promoted from 💡 design-only to 📋 v0.4 because it addresses a class of failure (server-only imports in client files, db calls in render paths) that produces real runtime / hydration errors and is invisible to lint.

**Gap vs research:** Patterns are framework-specific — Next.js + Vite-React covered first, other frameworks ship as adapters land.

---

### C11 — Readability (deterministic anchors) (design proposal, not on roadmap)

**Status:** 💡 — research proposal, not yet on the roadmap.

**What it would measure:** Three deterministic sub-checks intended to replace the vague-LLM portion of C7's rubric with anchor-based deterministic scoring:

- **Naming conventions** — component PascalCase, hook `use*` prefix, no single-letter variable names outside loop counters, file naming matches export naming
- **Function and file length distribution** — median and 90th-percentile function/file length scored against explicit anchors
- **Comment density and quality** — comment-to-code ratio penalty for both <2% and >25%; detection of filler comments (`// imports`, `// state`, `// render`) via regex

**Why held at 💡:** Promotion to the roadmap requires a research call on whether the signal beyond C1 (lint) plus C7's v0.4 dual-judge upgrade is worth a separate scorer. The dual-judge protocol may close enough of the readability variance gap to make C11 redundant. The decision lands after C7 dual-judge ships and we measure the residual variance.

---

### C12 — Schema design quality (planned v0.4, app track only)

**What it measures:** Deterministic checks on emitted database schemas (Prisma, Drizzle, raw SQL migrations, Supabase schema files). Catches schema rot — the most expensive AI-tool failure mode, because users discover it months in, after lock-in.

**How (planned):** ~12 deterministic patterns, scored as honored / applicable:

- Foreign-key constraints present where joinable
- NOT NULL on identity / required columns
- Indexes on FK columns and on columns used in WHERE clauses of generated queries
- `created_at` / `updated_at` timestamps on entity tables
- Unique constraints on natural keys (email, slug, username)
- RLS policies on every user-scoped table when Supabase is the backend
- Absence of JSON blob columns where a normalized join would be appropriate
- Consistent on-delete behavior on FK declarations (CASCADE / SET NULL / RESTRICT chosen explicitly, not defaulted)

Adapts ProjDevBench's "system architecture" evaluation axis into deterministic checks rather than an LLM rubric.

**Within-dimension weight (planned):** ~6–8% within Code Quality, sourced from C7 narrowing alongside C10.

**Why this is the highest-value v0.4 code-quality addition:** schema rot is invisible to F7/F8/S4 — those test that the backend *works*, not that the schema is *reasonable*. A tool can pass auth round-trip, pass cross-session persistence, pass RLS probes, and still ship a schema with no foreign keys, no indexes, JSON-blob columns where a join would be appropriate, and inconsistent on-delete behavior. C12 catches that.

**N/A handling:** Tools without a schema file (frontend-only deploys, Claude Artifacts) score N/A — same handling as F7/F8/S4. Patterns will need quarterly refresh as Drizzle / Prisma / Supabase / Convex idioms evolve; budget into the same maintenance cycle as S2 auth-pattern refresh.

**ID note:** Uses `c12` not `c11` to leave `c11` available for the readability proposal above without renumbering if/when both eventually ship.

---

## Visual design quality scorers

### V1 — LLM visual judge

**What it measures:** LLM-assessed visual quality across a per-prompt criteria list on a 1–5 scale.

**How:** Three screenshots (initial, viewport-mobile, mid-scroll) are base64-encoded and sent to a vision model via OpenRouter. The criteria list is built per-call from three sources:

1. **Visual-quality defaults (8, always included):** visual hierarchy, typography, color harmony, whitespace, brand fit, CTA prominence, mobile layout, overall polish.
2. **Copy-quality defaults (3, included unless `placeholder_copy: true`):**
   - `copy_specificity` — headlines name concrete benefits, not generic SaaS-speak ("revolutionize", "unlock", "seamless")
   - `no_fabricated_trust` — no invented testimonials, fake customer logos, or fabricated metric badges unless the prompt asks for them
   - `cta_clarity` — primary CTA uses a specific action verb matching the prompt's stated user action
3. **Per-prompt extras** from `visual_checklist.extra` in the prompt YAML.

Duplicate ids are de-duplicated, last-wins, so a prompt extra with the same id as a default replaces the default's description. Score = (mean raw – 1) / 4 normalized to 0–1.

**Per-prompt YAML schema (v0.2.0):**

```yaml
visual_checklist:
  extra:
    - id: tier_visual_hierarchy
      label: Tier visual hierarchy
      description: The Pro tier is visually distinguished from the other two...
  placeholder_copy: false  # set true to skip the 3 copy-quality defaults
```

See `prompts/corpus/saas-pricing-page.yaml` for a worked example.

**Calibration:** 3 = average AI-generated output, 5 = genuinely impressive.

**Within-dimension weight (research):** 45% of Visual dimension (implemented as 55% in this harness — V3 and V5 weights redistributed since they aren't implemented).

**Research spec (remaining gaps vs current v0.2.0):**

1. **Dual-judge cross-family protocol** — research requires two independent vision judges from different model families (e.g., Gemini 2.5 Pro + Claude Opus) to mitigate self-preference bias. Lovable uses Claude Sonnet as its backing LLM — if Claude is also the sole judge, self-preference inflates scores by ~5–10pp. **v0.2 uses a single configurable judge.**
2. **Disagreement handling** — when two judges disagree >1 point on any criterion, flag for manual review or a third judge. **Not applicable until dual-judge ships.**
3. **Krippendorff's α calibration** — target α ≥ 0.67 (tentative reliability) against a 50-example human-rated calibration set. **Not implemented.**

**Recommended change (v0.4):** Add second judge from a different model family. Add disagreement flagging logic. Build the calibration corpus.

---

### V2 — Design heuristics

**What it measures:** Eight automated design principle checks via browser evaluation, split between layout heuristics and CSS convention signals.

**Layout heuristics (4):**
1. **Whitespace:** ≥25% of viewport is background-colored (10×10 grid sample)
2. **Contrast:** ≥80% of text nodes pass WCAG AA (4.5:1 normal, 3:1 large ≥18px or ≥14px+bold)
3. **Font size:** ≥80% of text nodes ≥14px
4. **Line length:** ≥70% of block elements ≤85 chars wide

**CSS convention signals (4) — proxies for modern scaffolding (v0.2.0):**
5. **`box_sizing`** — ≥80% of the first 200 sampled elements use `box-sizing: border-box`. Modern resets (Tailwind preflight, normalize.css, custom CSS resets) apply this universally; ad-hoc CSS often misses it. Reads `getComputedStyle(el).boxSizing` so it always runs regardless of CORS.
6. **`reduced_motion`** — at least one `@media (prefers-reduced-motion)` query exists in any same-origin stylesheet. A motion-respect indicator that doubles as an accessibility/polish signal.
7. **`custom_properties`** — at least 5 distinct CSS custom properties (`--*`) declared across stylesheets. Calibrated against Tailwind, shadcn, and MUI scaffolds, which all declare hundreds. A page with zero custom properties is using ad-hoc CSS without design tokens.
8. **`focus_visible`** — at least one rule selector contains `:focus-visible`. Modern accessibility scaffolds always style `:focus-visible` separately from `:focus` to avoid showing the focus ring on mouse clicks; absence indicates outdated CSS.

**How:** All 8 checks run in a single `page.evaluate()` call. The CSS-rule checks (6, 7, 8) walk `document.styleSheets`; cross-origin stylesheets throw on `cssRules` access and are skipped silently. If every stylesheet is CORS-blocked the three rule checks return `passed: null` and drop out of the score calculation entirely (so the score doesn't unfairly penalize sites whose only stylesheets are CDN-hosted).

Score = (passed scorable checks) / (scorable checks). Passed if score ≥ 0.75.

**Within-dimension weight:** 30% of Visual (research has 25%; redistributed up because V3/V5 aren't implemented).

**Smoke-test results (2026-04):** A bare-bones AI-generated landing page passed 5/8 (whitespace, contrast, font size, line length, box-sizing) and failed the three modern-scaffolding checks. Vercel.com passed 8/8 with 716 distinct custom properties detected. The four new checks discriminate cleanly between basic and polished output.

**Research spec (additional heuristics not in v0.2):**
- Typographic hierarchy: distinct (fontSize, fontWeight) tuples counted, ratio cap ≤5
- Color count: ≤6 dominant colors via k-means on sampled pixels
- Color harmony: Delta-E distances between dominant colors
- Alignment grid consistency

**Gap vs research:** Typographic hierarchy depth, color count/harmony, and grid alignment remain unimplemented.

---

### V3 — Reference design fidelity (not yet implemented)

**What it measures:** When a prompt provides a visual reference (mood-board image, "make it look like Linear"), compute similarity using the Design2Code metric stack.

**Research spec (5 sub-metrics, all published separately — do not aggregate):**
1. **CLIP** — ViT-L/14 cosine similarity (high-level visual gestalt)
2. **Block-Match** — bounding-box detection + Jonker-Volgenant optimal pairing (element coverage / hallucination check)
3. **Text similarity** — Sørensen-Dice character overlap on matched block text
4. **Position** — normalized center-coordinate distance for matched pairs (layout fidelity)
5. **Color** — CIEDE2000 perceptual color distance on dominant colors of matched blocks

**Within-dimension weight (research):** 10% of Visual dimension.

**Status:** Not implemented. Requires prompts with visual reference images, CLIP model inference (~30s per pair, CPU-only acceptable at this scale), and the block-match pipeline.

---

### V4 — Responsive design

**What it measures:** Whether the layout works at mobile (360×800), tablet (768×1024), and desktop (1440×900) viewports, and whether touch targets are adequate on mobile.

**How:** New browser contexts per viewport. Checks: horizontal overflow (`scrollWidth > clientWidth`). Mobile only: ≤20% of interactive elements smaller than 44px (touch target minimum). Score = passed checks / total checks. Passed if ≥0.75.

**Within-dimension weight (research):** 15% of Visual dimension.

**Gap vs research:** The research also checks text reflow sanity (line-height × lines fits in container) per viewport. Not implemented in v0.1.

---

### V5 — Animation/interaction polish (not yet implemented)

**What it measures:** FPS during scroll, hover, and route changes; motion feel scored on a 1–3 rubric.

**Research spec:** Playwright + CDP to record interaction traces. Within-dimension weight: 5%. Research notes this is "mostly noise below the top quintile" — lowest priority visual sub-metric.

**Status:** Deferred. Low priority.

---

## Cost / speed scorers

### Cost — Self-reported timing and cost

**What it measures:** Time to first render (TTFR), time to working build (TTWB), and USD cost per build.

**How:** User-reported timestamps and credit/USD values from `submissions.yaml`. No instrumentation.

**Score:** null (informational only, excluded from composite).

**Research spec for the Cost dimension (T1–T5):**

| # | Metric | Research description | Status |
|---|---|---|---|
| T1 | Time to first render | Wall-clock from prompt submit to first interactive preview | Self-reported ✓ |
| T2 | Time to working build | Wall-clock from prompt submit to passing F1 + ≥50% F2 | Self-reported ✓ |
| T3 | USD cost per successful build | Billed tokens/credits converted to USD at published rate | Self-reported ✓ |
| T4 | Iterations to resolution | Turns until F2 threshold, capped at 10 (multi-turn only) | N/A (multi-turn not implemented) |
| T5 | Wall-clock for multi-turn | Total seconds including 30s simulated user think-time | N/A |

**Research target weight:** 15% of composite (reduced from 20% to fund the Security dimension).

**Gap:** The research calls for a harness-instrumented timing layer (`on_prompt_sent`, `on_first_artifact`, `on_build_complete`, `on_turn_complete` events emitted to JSONL). Self-reporting introduces human error and prevents automation of future leaderboard refreshes. Cost normalization — publishing both raw credits and USD-equivalent at retail price — is not yet automated.

---

## Security scorers

Security is a top-level dimension, promoted from inside code quality because AI sitebuilders systematically produce well-styled pages with serious security failures — exposed service-role keys, missing CSP, RLS-off Supabase schemas — that are invisible to functional, visual, and most code-quality checks. Research target weight: **10% of composite**.

### S1 — Secrets + deployed headers

**File:** `src/scorers/security/s1-secrets.ts`

**What it measures:** Two independent sub-checks combined into one score:

1. **Secrets** — hardcoded API keys, tokens, passwords, and private keys present in the source tree.
2. **Deployed headers** — standard HTTP security headers present on the deployed URL.

Either sub-check is N/A when its input is missing (no source ZIP for secrets, or unreachable URL for headers). Final score = mean of whichever sub-checks ran.

**Sub-check 1 — secrets (v0.3.0, three scanners unioned):** S1 runs three independent scanners in parallel and unions their findings. Each scanner is independently optional; if a tool isn't installed the others still run.

**(a) Built-in regex (always available).** Scans all text files <1MB (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.html`, `.json`, `.env*`, `.yaml`, `.yml`, `.toml`, `.sh`), skipping `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `.cache`. Eight patterns covering OpenAI/Anthropic/AWS/GitHub/PEM/JWT and generic password/secret literals.

**(b) Semgrep (optional, install via `pip install semgrep`).** Runs `semgrep --config p/secrets --config p/owasp-top-ten --json` against the source tree with a 60s per-rule timeout and a 120s overall timeout. The `p/secrets` ruleset covers vendor-specific token formats the regex scan doesn't (Stripe, Mailgun, Slack, Postgres URIs, OAuth client secrets, Firebase config blobs, ~150 patterns total); `p/owasp-top-ten` broadens to general code-level OWASP issues (SQL injection sinks, hardcoded crypto keys, insecure randomness). Findings are tagged `scanner: 'semgrep'`.

**(c) trufflehog (optional, install via `brew install trufflehog` or `go install github.com/trufflesecurity/trufflehog/v3@latest`).** Runs `trufflehog filesystem --json --no-update` for high-entropy detection — catches arbitrary base64/hex strings that look like credentials but don't match any known pattern. The `Verified` flag in the output indicates trufflehog was able to actively confirm the credential is live (e.g., by hitting the corresponding API). Findings are tagged `scanner: 'trufflehog'`.

**Scoring:** all findings are unioned (no dedup — when Semgrep and the regex scan flag the same leak via different rule ids, both are surfaced as confirmation rather than buried). Sub-score = 1 if zero findings across all scanners, else 0. The result's `details.secrets.scanners` block reports per-scanner availability and finding counts so users can see what actually ran.

**Tool detection:** `command -v semgrep` and `command -v trufflehog` are checked once per scan via a 5s shell test; if a tool isn't on PATH the wrapper returns `available: false` silently. Tool errors (timeout, bad JSON, unexpected exit code) are also non-fatal — captured in `scanners.<name>.error` for diagnostics, with the other scanners' findings still counted.

**Sub-check 2 — deployed headers:** `fetch(submission.artifactUrl)` with a 10s timeout, lowercases all response header names, then checks 6 standard security headers. Each present + non-trivially-set header earns one point. Sub-score = `passed / 6`.

| Header | Present condition |
|---|---|
| `Content-Security-Policy` | Set, and not the `unsafe-inline + unsafe-eval + *` no-op pattern |
| `Strict-Transport-Security` | `max-age=N` directive present |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY`/`SAMEORIGIN`, or CSP has a `frame-ancestors` directive |
| `Referrer-Policy` | Set to anything other than `unsafe-url` |
| `Permissions-Policy` | Set (legacy `Feature-Policy` also accepted) |

**Pass condition:** Secrets sub-check finds 0 findings AND headers sub-check passes ≥4/6. If a sub-check is N/A, it cannot fail.

**Within-Security weight (research):** 40%.

**Gap vs research:** Full S1 also calls for a Semgrep OWASP Top-10 ruleset and `trufflehog filesystem` for broader-coverage secret scanning. Neither is implemented; the 8-pattern regex covers the most common AI-sitebuilder failure modes but misses customer-specific vendor key formats.

---

### S2 — Auth-pattern check

**File:** `src/scorers/security/s2-auth.ts`

**What it measures:** AI-sitebuilder-specific authentication anti-patterns that general secret scanners miss — framework-specific mistakes around Supabase, Firebase, JWT, and third-party key exposure in client code.

**How:** Scans source files per extension. Patterns tagged `clientSideOnly: true` are only flagged when the file path contains a client-side segment (`src`, `app`, `pages`, `components`, `hooks`, `lib`, `utils`, `store`, `context`, `views`, `features`, `modules`, `client`, `frontend`, `ui`). One finding per pattern per file.

**Severity and scoring:**

| Severity | Weight | Pass condition |
|---|---|---|
| critical | 10 pts | Fails immediately |
| high | 5 pts | Fails immediately |
| medium | 2 pts | Reduces score but does not fail |

`penalty = sum of severity weights across all findings`
`score = max(0, 1 - penalty / 20)`
`passed = no critical or high findings`

**Patterns (16 total):**

| Pattern ID | Label | Severity | Client-side only |
|---|---|---|---|
| `supabase_service_role_client` | Supabase service-role key in client-side code | critical | yes |
| `supabase_rls_disabled` | Supabase table created without RLS enabled | critical | no |
| `supabase_anon_key_rpc` | Supabase anon key calling privileged RPC endpoint | high | yes |
| `jwt_decode_no_verify` | `jwt-decode` imported in client-side code (no signature verification) | high | yes |
| `jwt_secret_client` | JWT secret or signing key referenced from client-side code | critical | yes |
| `firebase_test_mode` | Firebase Realtime DB or Firestore rules in test/open mode | high | no |
| `firebase_database_url_client` | Firebase `databaseURL` exposed in client bundle | high | yes |
| `stripe_secret_client` | Stripe secret key referenced from client-side code | critical | yes |
| `openai_key_client` | OpenAI API key referenced from client-side code | critical | yes |
| `third_party_secret_client` | Generic `SECRET`/`_KEY`/`_TOKEN` env var in client code (excludes `NEXT_PUBLIC_`, `VITE_`) | critical | yes |
| `hardcoded_admin_email` | Hardcoded admin email used for privilege check | medium | no |
| `hardcoded_admin_password` | Hardcoded admin or default password constant | medium | no |
| `password_reset_no_token` | Password reset that updates password without a token/otp/code in surrounding context | high | no |
| `xss_unsanitized_html` | `dangerouslySetInnerHTML` / `.innerHTML =` / Vue `v-html` with no sanitizer (DOMPurify/sanitize-html/xss) imported or used in the file | high | yes |
| `insecure_transport` | Disabled TLS verification (`rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `strictSSL: false`) or plaintext `http://` request target (excludes localhost and XML namespace/schema URLs) | medium | no |
| `sensitive_data_logged` | `console.*` / `logger.*` call logging `req.body`, `req.headers`, an auth header, or a secret-named binding (password/secret/api_key/access_token/etc.) | medium | no |

**Secure-by-default patterns (v0.2.0):** the last three patterns close P2 ("secure code-generation defaults") gaps from the Lovable × AIUC-1 whitepaper analysis ([docs/whitepaper-gap.md](docs/whitepaper-gap.md) §3). `xss_unsanitized_html` uses the same in-file context heuristic as `password_reset_no_token` (confirms a sanitizer is *absent* before flagging the sink) and ships at **high** (auto-fail) given low false-positive risk. `insecure_transport` and `sensitive_data_logged` ship at **medium** (deduct-only, never flip `passed`) because their match surface is noisier; their false-positive rate is validated against the existing `artifacts/` corpus before any promotion to high.

`xss_unsanitized_html` suppresses CSS injection into a `<style>` element: the canonical shadcn/ui `<ChartStyle>` component sets `dangerouslySetInnerHTML` on a `<style>` tag to emit theme CSS custom properties from code-controlled config, which is not a markup-XSS sink. A pre-ship dry-run across the 10-tool `artifacts/` corpus initially matched 7 trees — *all* of them this one shadcn boilerplate file (`components/ui/chart.tsx`) — so the `<style>` guard was added; the re-run matched 0. `insecure_transport` and `sensitive_data_logged` matched 0 on the landing-page corpus (no signal yet, no noise).

**Within-Security weight (research):** 35%.

**Gap vs research:** The research also specifies patterns for Auth.js/Clerk misconfigurations and quarterly pattern refresh as frameworks evolve. Pattern set should be reviewed when major Supabase, Firebase, or Clerk auth APIs ship breaking changes.

---

### S3 — Dependency vulnerabilities

**File:** `src/scorers/security/s3-vuln.ts`

**What it measures:** Known-CVE vulnerabilities in npm dependencies, filtered to high and critical severity.

**How:** Finds `package.json` (root or one level down). If no lockfile exists, generates one via `npm install --package-lock-only` in a temp directory. Runs `npm audit --json --omit=dev`. Weighted penalty: critical = 10 pts, high = 3 pts, moderate = 1 pt, low = 0.1 pt. Score = `max(0, 1 - penalty / 20)`. Passed if critical = 0 and high = 0.

**Within-Security weight (research):** 25%.

**Gap vs research:** The research also cross-checks against `osv.dev` for CVEs not yet in the npm advisory feed, and distinguishes S3's `--audit-level=high` filter from C5's general audit (which counts all severities for hygiene scoring). The `osv.dev` cross-check is not implemented.

---

### S4 — Backend security probes (v0.3, backend track)

**File:** `src/scorers/security/s4-backend.ts`

**What it measures:** Read-only runtime probes against the deployed backend that catch the actual server-side authorization failures that S2 only catches via *client-side* hints.

**How (v0.2.0 — credential-only auto-discovery):** Runs only when the submission carries a `backend` block with two accounts. The **only** input is credentials — no tokens, endpoints, or record ids supplied by hand. The harness:

1. signs in as **user B** through the real login form (the shared browser driver, `src/scorers/backend/login.ts`), **seeds a uniquely-marked record as B**, then observes B's dashboard traffic — auto-selecting the JSON response (GET *or* POST/RPC) that returns the largest record array and using the seed marker as the leak identifier;
2. **unauth probe** — replays B's request with embedded auth **stripped** (token keys removed from the JSON body, Authorization header dropped) from a session-less context → must be rejected (401/403) and must not serve B's data;
3. **cross-user probe** — signs in as **user A**, captures **A's own** dashboard data response, and checks whether B's marker appears in it → A's own data must **not** contain B's record.

**Critical correctness detail (auth-in-body):** the cross-user probe uses A's *own* request, not a replay of B's captured request. Many backends (Modelence, tRPC) carry the auth token in the request **body**, not a cookie — so replaying B's captured request "from A's context" stays authenticated as B and returns B's data, producing a false-positive leak. Testing against A's own authenticated response is correct regardless of where auth travels. Likewise the unauth probe must strip the body token, not merely drop cookies. (This was a real false-positive bug caught against the Modelence reference CRM and fixed in `0.2.0`.)

Capturing POST as well as GET is required for RPC/GraphQL backends (e.g. Modelence's `POST /api/_internal/method/contacts.list`), which a GET-only capture would miss. A probe that errors (timeout / refused / login failure) is recorded as inconclusive, not a failure. The artifact records only the redacted per-probe outcome and the discovered endpoint URL — never response bodies. **S4 writes one record (B's seeded contact)** to guarantee a discoverable target — otherwise non-destructive (no deletes, no writes as A).

**Scope boundary:** the cross-user probe tests *list/collection* endpoints ("does A's list contain B's rows?"), which catches the dominant "endpoint returns every user's records" failure. It does **not** probe per-record detail endpoints (`GET /contacts/<B's id>` as A) — that narrower IDOR class would need per-record id probing and is not yet covered.

**Scoring:** each failed probe = 10 penalty points (both failure classes are direct data exposure = critical); `score = max(0, 1 − penalty/20)`; `passed = no failed probes`. `details.crossTenantLeak` is the headline boolean.

**Within-Security weight:** 15, additive on top of S1/S2/S3 (which sum to 100 = 40/35/25). On non-backend submissions S4 is null and S1/S2/S3 keep their exact prior proportions; on backend submissions S4 reflows in at 15/115 ≈ 13%.

**Why this is the single biggest security signal-quality win in v0.3:** S2 catches code patterns that *suggest* auth is broken (Supabase service-role key in client code, JWT decode without verify, RLS-off schema files committed). S4 catches the actual server-side failure — the canonical "Supabase RLS off, every user can read every other user's data" bug that's invisible from the frontend until someone tries it.

**N/A handling:** Tools that don't ship a backend (Claude Artifacts, frontend-only v0 deploys) score N/A on S4 — same handling as F7/F8. Tools that score N/A on F7/F8/S4 are honestly not in the same category as backend-shipping tools — that's the correct signal, not a penalty to game around.

---

## Corpus-level mechanisms (research proposals, not on roadmap)

These are harness-level rules — not scorers — that the research design proposes for protecting the leaderboard's discriminative signal as the corpus saturates and sustained leaderboard runs accumulate. None are committed to a release; all three are tracked here so they don't get re-debated and to set expectations for the v0.3+ horizon.

### Auto-retirement of saturated prompts

**Status:** 💡 — not on the roadmap.

Any prompt where the **median tool composite score is ≥90 across three consecutive quarterly leaderboard runs** would automatically retire from the corpus and replace with a freshly-authored prompt sampled from the harder end of the difficulty distribution (typically Tier 3, occasionally a new Tier 4 added that quarter).

Retired prompts log to the leaderboard changelog so reproducibility runs against historical versions remain possible. This is the active version of "living corpus" — saturation, not just contamination, triggers retirement.

**Why held:** Requires sustained quarterly leaderboard runs that don't exist yet. Premature for v0.2; revisit after v0.3 has 2+ quarterly refreshes on record.

### Hard Mode subset

**Status:** 💡 — not on the roadmap.

A permanent subset of 10–20 prompts authored such that **the best current tool scores ≤50% on composite**. Anti-saturation safety valve: when the main corpus inevitably saturates (every long-running benchmark does — HumanEval went from "hard" to "solved" in 24 months; SWE-bench needed Verified then Pro to stay informative), Hard Mode is where the ranking actually happens.

Authoring rules:
- A prompt enters Hard Mode only after the top three tools on the current leaderboard refresh all score ≤50% on it across n=3 runs
- At least one Hard Mode prompt per main track (one-shot static, one-shot app, iterative static, iterative app)
- Annual full regeneration; continuous additions when prompts age out (a Hard Mode prompt where the top tool now scores >70% graduates back to Tier 3)
- Reported as a separate Hard Mode leaderboard column

**Why held:** Same as auto-retirement — requires a baseline of leaderboard data that doesn't exist yet. The pattern is borrowed from GPQA's "designed-at-the-ceiling" approach and SWE-bench's Verified/Pro splits.

### Pairwise Bradley–Terry fallback when scores cluster

**Status:** 💡 — not on the roadmap.

Absolute 0–100 scoring loses discrimination as scores cluster near the ceiling. When the **composite spread across all leaderboard entries falls below 5 points** for two consecutive quarterly runs on a given track, a pairwise ranking layer activates: for each prompt, the rendered outputs of every pair of tools are sent to a dual-MLLM judge with the prompt "which output better satisfies the original prompt?", positions randomized across runs. Wins aggregate into a Bradley–Terry / Elo score (the same framework LMArena uses for human-vote ranking, with closed-form CIs).

When activated, the pairwise score becomes the primary ranking; absolute 0–100 scores remain published alongside as the diagnostic view.

**Why held:** Third line of defense after auto-retirement and Hard Mode — only fires when those two have stopped being enough. Requires sustained leaderboard runs to even know whether the trigger condition (5-point spread across the leaderboard, two consecutive quarters) is approached. Not v0.3 material; deferred until the leaderboard has >12 months of data and saturation is genuinely visible.

---

## Summary of recommended changes

### v0.2 priority changes

| Change | Impact |
|---|---|
| Default empty-state critical criterion for app-track prompts | Catches the most common app-track regression: blank pane on zero records |
| Route-split count + license-hygiene scan in C5 | Closes the remaining sub-checks from research C5 not covered by gzipped payload alone |

### v0.3 shipped changes

| Change | Impact |
|---|---|
| **Backend track infrastructure** — `backend_url` / `signup_credentials` / `seed_strategy` in `submissions.yaml` | Enables F7/F8/S4. Submission-flow precondition for the backend track |
| **F7 auth round-trip** | Login → create a marked record → logout → re-login → record persists. Catches broken sessions and writes that don't persist server-side |
| **F8 backend persistence across sessions** | Two-context test distinguishing localStorage tools from real-backend tools |
| **S4 backend security probes** | Direct API probes (unauthenticated GET, cross-user GET) catch the canonical "RLS off" failure that S2 only catches via client-side hints |
| **Tier 3 corpus prompt** (`crm-contacts`) | Multi-user CRM — email/password auth, per-user contact lists, server-side data isolation |
| **Authenticated dashboard screenshots** for F4/V1 | Backend apps now capture `dashboard.png` / `dashboard-mobile.png` after login so judges see the real UI, not the login screen |
| **F2 within-dim weight additive model** | F7/F8 sit on top of the 100-point base; Tier 1/2 submissions score exactly as before |
| **Fix-report / audit.md generation** | Per-submission markdown audit report listing failing scorers and actionable notes |

### v0.4 planned changes

| Change | Impact |
|---|---|
| **F9 scheduled-job execution** | Verifies cron / scheduled work both exists (config present) and runs (force-trigger endpoint produces side effects). Currently unscored anywhere |
| **C10 project-structure deterministic checks** | Catches framework anti-patterns (server-only imports in `'use client'` files, db calls in render paths) — invisible to lint |
| **C12 schema-design deterministic checks (app track)** | Catches schema rot (missing FKs, no indexes, RLS off, all-nullable columns) — invisible to F7/F8/S4 which only test the backend works, not whether schema is reasonable |
| **C7 within-dim weight narrows** when C10/C12 ship | Architecture and schema move to deterministic backbones; C7 contracts to its core "abstraction boundaries / prop-typing / pattern consistency" scope |
| Add second judge from a different model family across V1, F4, and C7 | Eliminates self-preference bias; one rollout covers all three judge scorers |
| Add disagreement flagging logic (>1 point divergence) for the dual-judge scorers | Surfaces low-confidence judgments for manual review |
| Add dynamic per-prompt F1 timeout from `baselineBuildSeconds` in prompt YAML | Prevents false-positive timeouts on complex prompts |
| Implement V3 reference-design fidelity (CLIP + Block-Match + Text + Position + Color) | Enables reference-image prompts ("make it look like Linear") |
| Add typographic hierarchy and color count/harmony to V2 | Remaining V2 gaps after the v0.2 CSS-signal additions |
| Implement harness-instrumented timing layer (replaces self-reported cost) | Enables automated leaderboard refreshes without manual timing input |
| Krippendorff's α calibration pipeline for V1, F4, and C7 | Validates judge reliability against human ratings |
| Duplication detection (`jscpd`) in C6 | Completes AST complexity sub-checks |
| `osv.dev` cross-check in S3 | Catches CVEs not yet in npm advisory feed |
| Quarterly S2 pattern refresh process | Keeps auth anti-patterns current as Supabase/Firebase/Clerk evolve |

### Design proposals not yet on the roadmap

These are research positions tracked here so they don't get re-debated. None are committed to a release.

| Item | Status reason |
|---|---|
| **C11 readability (deterministic anchors)** | Held until v0.4 dual-judge upgrade for C7 ships; dual-judge may close enough of the readability variance gap to make C11 redundant |
| **§"Auto-retirement of saturated prompts"** | Requires sustained quarterly leaderboard runs that don't exist yet. Revisit after v0.3 has 2+ quarterly refreshes on record |
| **§"Hard Mode subset"** | Same baseline-data prerequisite as auto-retirement |
| **§"Pairwise Bradley–Terry fallback"** | Third line of defense after auto-retirement and Hard Mode; only fires when those two stop being enough. Deferred until the leaderboard has >12 months of data and saturation is genuinely visible |
| Prompt-robustness track | Tests how tools handle ambiguous / self-contradictory prompts; novel dimension |
| Structured self-repair sub-track (LiveCodeBench pattern) | Deterministic test-trace injection as next turn instead of free-form follow-ups; refines an iterative track that's currently deferred |

### Not planned (v0.1 scope decisions)

| Item | Reason deferred |
|---|---|
| Multi-turn iterative track (T4, T5) | Requires session-state management across turns; significant adapter complexity |
| V5 animation/interaction polish | Research rates this as noise below top quintile; low ROI |
| Private prompt split + contamination rotation | Only needed once public scores stabilize |
| Live tool-drift time series | Operational concern; needs weekly runner infrastructure |

---

## Scorer version history

| Scorer | File | Version | Notes |
|---|---|---|---|
| f1 | `functional/f1-render.ts` | 0.1.0 | Fixed 30s timeout; 8s network-idle cap |
| f2 | `functional/f2-acceptance.ts` | 0.2.0 | mustHave / shouldHave weighting; per-criterion `setup` actions (evaluate / fill / click / press / reload / waitFor) for stateful prompts |
| f4 | `functional/f4-judge.ts` | 0.2.0 | Single judge; 4 default criteria + per-prompt `functional_checklist.extra`; missing-features list |
| f5 | `functional/f5-errors.ts` | 0.1.0 | Linear decay at 10 errors |
| f6 | `functional/f6-verbatim.ts` | 0.1.0 | exact_copy, hex_value, structural types |
| f7 | `functional/f7-auth-roundtrip.ts` | 0.1.0 | Backend track. login → create → logout → relogin → persists. N/A without `backend.signup_credentials`. Additive weight 8 |
| f8 | `functional/f8-cross-session.ts` | 0.1.0 | Backend track. Record created in context A must appear in fresh incognito context B (real backend vs. localStorage). Additive weight 7 |
| c1 | `code-quality/c1-eslint.ts` | 0.1.0 | typescript-eslint recommended only |
| c2 | `code-quality/c2-types.ts` | 0.1.0 | tsc strict; ignores missing-module errors |
| c3 | `code-quality/c3-axe.ts` | 0.1.0 | wcag2a/aa, wcag21a/aa, wcag22aa tags |
| c4 | `code-quality/c4-lighthouse.ts` | 0.2.0 | Up to 3-run median; mobile 360×640. Per-run 90s + overall 240s timeouts; tolerates ≥1 successful run; Chrome restarted between runs. |
| c5 | `code-quality/c5-bundle-size.ts` | 0.2.0 | Gzipped JS+CSS payload via `page.on('response')` Content-Length (primary); uncompressed source bytes when no network capture (fallback). Lighthouse-aligned thresholds. |
| c6 | `code-quality/c6-complexity.ts` | 0.1.0 | SonarJS cognitive-complexity threshold 15 |
| c7 | `code-quality/c7-maintainability.ts` | 0.1.0 | Single judge; 5-criteria rubric; samples up to 12 source files |
| c8 | `code-quality/c8-install.ts` | 0.3.0 | Detects npm/pnpm/yarn/bun from every committed lockfile; runs strict frozen install per manager in a fresh temp dir (240s each); passes if any installs, grades down for lock-file hygiene defects (duplicate/out-of-sync/damaged/private-registry), all enumerated in the JSON report |
| c9 | `code-quality/c9-seo.ts` | 0.1.0 | 10 configurable checks |
| v1 | `visual/v1-judge.ts` | 0.2.0 | Single judge; 8 visual + 3 copy-quality defaults + per-prompt `visual_checklist.extra`; copy-quality skipped when `placeholder_copy: true` |
| v2 | `visual/v2-design.ts` | 0.2.0 | 8 checks: 4 layout (whitespace, contrast, font size, line length) + 4 CSS conventions (box-sizing, prefers-reduced-motion, custom properties, :focus-visible). CSS-rule checks skip when stylesheets are CORS-blocked. |
| v4 | `visual/v4-responsive.ts` | 0.1.0 | 3 viewports; horizontal overflow + touch targets |
| s1 | `security/s1-secrets.ts` | 0.3.0 | Two sub-checks: source secrets (regex + Semgrep `p/secrets`+`p/owasp-top-ten` if installed + trufflehog filesystem if installed; findings unioned) + 6-header deployed audit; mean of whichever ran |
| s2 | `security/s2-auth.ts` | 0.2.0 | 16 patterns; client-side awareness; weighted severity. v0.2.0 added secure-by-default patterns: `xss_unsanitized_html` (high), `insecure_transport` (medium), `sensitive_data_logged` (medium) |
| s3 | `security/s3-vuln.ts` | 0.1.2 | npm audit; critical=10, high=3, moderate=1, low=0.1 penalty |
| s4 | `security/s4-backend.ts` | 0.2.0 | Backend track. Credential-only: signs in as B via the UI, auto-discovers B's data endpoint, replays it unauthenticated + as A. `cross_tenant_leak` headline. N/A without a `backend` block. Additive weight 15 |
| cost | `cost.ts` | 0.1.0 | Self-reported; informational only |

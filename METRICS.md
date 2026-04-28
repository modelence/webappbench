# Benchmark Metrics Reference

This document describes every scorer in the benchmark harness, the rationale behind each metric, gaps versus the research design, and recommended changes for future versions.

---

## Scoring architecture

### Composite score

The composite is currently an **unweighted average** of all contributing scorers. This is a deliberate v0.1 simplification. The research design calls for a dimension-weighted composite once enough data exists to validate weights.

Research target weights (dimension level):

| Dimension | Research weight | Current actual |
|---|---|---|
| Functional correctness | 40% | ~equal share |
| Code / output quality | 15% | ~equal share |
| Visual design quality | 20% | ~equal share |
| Cost / speed | 15% | excluded (informational) |
| Security | 10% | ~equal share |

**Recommended change (v0.2):** implement dimension-level weighting in `composite.ts`.

### Conditional execution

F1 is a gate: if the site does not render, all browser-dependent scorers (F2, F5, C3, C4, C9, V1, V2, V4) are skipped and scored as null. Source-dependent scorers (F6, C1, C2, C5, C6, S1, S2, S3) require a source ZIP.

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

**Within-dimension weight (research):** 30% of the Functional dimension.

**Gap vs research:** The research recommends role/label-based locators only (`getByRole`, `getByLabel`) to survive DOM changes across builds. The current implementation allows arbitrary Playwright expressions — prompt authors should be disciplined about locator choice.

**Recommended change:** Add a lint step on prompt YAML that warns when locators use CSS selectors instead of role/label/text-based ones.

---

### F3 — Spec-based E2E tests (not yet implemented)

**What it measures:** For the app track — synthesized Playwright tests exercising CRUD paths, auth flows, and data persistence across page reload.

**Research spec:** Pass = all critical criteria + ≥80% nice-to-have. Tests are generated from the prompt + acceptance YAML, human-audited once, then frozen for evaluation.

**Status:** Deferred to app track (v0.2+). Not present in v0.1 which only covers the static landing page track.

---

### F4 — LLM-as-judge functional match (not yet implemented)

**What it measures:** Vision + code judge scoring "does this satisfy the prompt intent?" on a 1–5 scale using a per-task checklist and three temporal screenshots.

**Research spec:** Weight 10% within the Functional dimension, paired with F2 so the judge cannot override the deterministic checklist.

**Status:** Not implemented. V1 (visual judge) partially covers this but is scoped to visual quality, not functional intent.

**Recommended change (v0.2):** Add an F4 scorer that sends screenshots + source excerpt to the judge with functional-intent criteria from the prompt YAML, distinct from V1's visual-quality criteria.

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

**Gap vs research:** Single-state scan only. The research also calls out CSS signals (`:focus-visible` presence, `@media (prefers-reduced-motion)`) as low-cost a11y proxies that should be added to C1 or a separate sub-check.

---

### C4 — Lighthouse performance

**What it measures:** Lighthouse mobile-throttled performance score (0–1), plus raw CWV metrics (LCP, FCP, CLS, TBT, Speed Index).

**How:** Runs Lighthouse 3 times, reports median. Mobile emulation: 360×640px, 2dpi. Score = Lighthouse performance score.

**Within-dimension weight (research):** 20% of Code Quality. Research uses Lighthouse 10 weights: LCP 25%, TBT 30%, CLS 25%, FCP 10%, Speed Index 10%.

**Research anchor for judge rubric:** LCP 5 = <2.0s, 4 = 2.0–2.5s, 3 = 2.5–3.5s, 2 = 3.5–5.0s, 1 = >5.0s. INP: 5 = ≤200ms, 3 = 200–500ms, 1 = >500ms.

**Gap vs research:** Current scorer uses whatever Lighthouse version is installed. The research requires pinning to Lighthouse 12.x with a committed lockfile. Lighthouse uses lab data, not field data — acceptable for leaderboards since we want reproducible conditions, but should be documented in results metadata.

---

### C5 — Bundle and dependency hygiene

**What it measures:** Uncompressed JS + CSS source size.

**How:** Scans source ZIP for `.js`, `.ts`, `.tsx`, `.css`, and variants. Skips build artifacts and `node_modules`. Reports raw source bytes (no minification or tree-shaking). Score: 1 at ≤150KB, linear decay to 0 at ≥1MB. Passed if ≤512KB.

**Within-dimension weight (research):** 10% of Code Quality.

**Research spec (three sub-checks, only partial in v0.1):**

1. **`env_setup_clean`** — `npm ci` succeeds from a fresh checkout with no workarounds (`--legacy-peer-deps`, patched `node_modules`). Catches the common AI failure: the tool worked around dep conflicts locally with stale `node_modules` but the committed `package.json` doesn't install cleanly. **Not implemented.**
2. **Bundle size and shape** — gzipped JS payload + route-split count. Current implementation measures raw source, not gzipped output. **Gap: no gzip measurement, no route-split count.**
3. **Vulnerability and license hygiene** — `npm audit` for known-vulnerable packages + license compatibility scan. Audit is now in S3; license scan not implemented.

**Recommended change:** Add `env_setup_clean` sub-check. Measure gzipped payload size from Playwright's `page.on('response')` or via `rollup-plugin-visualizer` output.

---

### C6 — AST complexity

**What it measures:** Cognitive complexity violations (SonarJS rule), normalized per 1,000 LOC.

**How:** ESLint with `eslint-plugin-sonarjs/cognitive-complexity` threshold 15. Score = `max(0, 1 - violationsPer1k / 10)`.

**Within-dimension weight (research):** 5% (halved from 10% because sharded-but-functional code is the norm in AI output, making complexity a weak discriminator). Also calls for nesting depth, file-length distribution, and duplication via `jscpd`. Only cognitive complexity is implemented in v0.1.

**Gap vs research:** Duplication detection (`jscpd`) not implemented. File-length distribution not implemented.

---

### C7 — Maintainability judge (not yet implemented)

**What it measures:** LLM-assessed maintainability — naming, separation of concerns, component reuse, prop typing, secret handling — on a 1–5 scale.

**Research spec:** Claude Sonnet + GPT-4-class judge on a 5-point rubric, two-judge cross-family protocol (one Anthropic, one OpenAI) to mitigate self-preference. Weight: 15% of Code Quality.

**Research anchor:** 5 = component <150 LOC, single responsibility, typed props; 3 = 150–400 LOC, mixed concerns; 1 = >400 LOC or untyped.

**Status:** Not yet implemented. The scorer slot is reserved; v0.1 shipped npm audit as a placeholder under this ID, which has since been moved to S3 where it belongs.

**Recommended change (v0.2):** Implement C7 as a cross-family maintainability judge using the same two-judge protocol as V1.

---

### C9 — SEO hygiene

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

## Visual design quality scorers

### V1 — LLM visual judge

**What it measures:** LLM-assessed visual quality across 8 criteria on a 1–5 scale.

**How:** Three screenshots (initial, viewport-mobile, mid-scroll) are base64-encoded and sent to a vision model via OpenRouter. The model scores: visual hierarchy, typography, color harmony, whitespace, brand fit, CTA prominence, mobile layout, overall polish. Score = (mean raw – 1) / 4 normalized to 0–1.

**Calibration:** 3 = average AI-generated output, 5 = genuinely impressive.

**Within-dimension weight (research):** 45% of Visual dimension.

**Research spec (several gaps vs v0.1):**

1. **Dual-judge cross-family protocol** — research requires two independent vision judges from different model families (e.g., Gemini 2.5 Pro + Claude Opus) to mitigate self-preference bias. Lovable uses Claude Sonnet as its backing LLM — if Claude is also the sole judge, self-preference inflates scores by ~5–10pp. **v0.1 uses a single configurable judge.**
2. **Per-task checklist** — research defines 10–14 checklist items per prompt (not a fixed generic rubric). Includes copy-quality items: (a) copy specificity (no "revolutionize", "unlock", "seamless" SaaS-speak); (b) no fabricated trust signals (invented testimonials, fake customer logos, fabricated metric badges); (c) CTA clarity (specific action verb matching prompt's stated user action). **v0.1 uses a fixed 8-criteria rubric, not per-task.**
3. **Disagreement handling** — when two judges disagree >1 point on any criterion, flag for manual review or a third judge. **Not applicable in v0.1 (single judge).**
4. **Structured JSON output** — required to avoid verbosity bias. **Implemented in v0.1.**
5. **Krippendorff's α calibration** — target α ≥ 0.67 (tentative reliability) against a 50-example human-rated calibration set. **Not implemented.**

**Recommended change (v0.2):** Add second judge from a different model family. Add per-prompt `visualChecklist` field to prompt YAML. Add disagreement flagging logic.

---

### V2 — Design heuristics

**What it measures:** Four automated design principle checks via browser evaluation.

**How:**
1. **Whitespace:** ≥25% of viewport is background-colored (10×10 grid sample)
2. **Contrast:** ≥80% of text nodes pass WCAG AA (4.5:1 normal, 3:1 large ≥18px or ≥14px+bold)
3. **Font size:** ≥80% of text nodes ≥14px
4. **Line length:** ≥70% of block elements ≤85 chars wide

Score = passed checks / 4. Passed if score ≥ 0.75.

**Within-dimension weight (research):** 25% of Visual dimension.

**Research spec (additional heuristics not in v0.1):**
- Typographic hierarchy: distinct (fontSize, fontWeight) tuples counted, ratio cap ≤5
- Color count: ≤6 dominant colors via k-means on sampled pixels
- Color harmony: Delta-E distances between dominant colors
- Alignment grid consistency

**Gap vs research:** Current implementation covers whitespace, contrast, font size, and line length. Missing: typographic hierarchy depth, color count/harmony, grid alignment.

**Research also specifies CSS convention signals** (deterministic, ~10 lines each): `box-sizing: border-box` presence, `@media (prefers-reduced-motion)` respect, CSS custom-properties usage (`--*`), `:focus-visible` presence. These should be added to V2 or C3.

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

### S1 — Secrets detection

**File:** `src/scorers/security/s1-secrets.ts`

**What it measures:** Hardcoded API keys, tokens, passwords, and private keys present anywhere in the source tree.

**How:** Scans all text files <1MB (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.html`, `.json`, `.env*`, `.yaml`, `.yml`, `.toml`, `.sh`), skipping `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `.cache`. Eight regex patterns:

| Pattern ID | Label |
|---|---|
| `openai_key` | OpenAI API key (`sk-…`) |
| `anthropic_key` | Anthropic API key (`sk-ant-…`) |
| `aws_access_key` | AWS access key ID (`AKIA…`) |
| `github_pat` | GitHub personal token (`ghp_…`) |
| `private_key_pem` | PEM private key header |
| `long_jwt` | Hardcoded JWT token (≥150 chars after `eyJ`) |
| `hardcoded_password` | Password/passwd/pwd assigned to a string literal |
| `hardcoded_secret` | Secret/token/api_key assigned to a ≥20-char literal |

**Score:** Binary — 1 (no findings) or 0 (any finding).

**Within-Security weight (research):** 40% (this scorer covers the secrets sub-check of S1; Semgrep OWASP ruleset and deployed HTTP header audit are planned for v0.2).

**Gap vs research:** Full S1 also includes Semgrep OWASP Top-10 ruleset, `trufflehog filesystem`, and in v0.2 a deployed-header audit (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy) via curl. These are not implemented.

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

**Patterns (13 total):**

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

## Summary of recommended changes

### v0.2 priority changes

| Change | Impact |
|---|---|
| Implement dimension-level weighting in `composite.ts` | Aligns composite with research design (F 40%, C 15%, V 20%, T 15%, S 10%) |
| Implement C7 maintainability judge (cross-family two-judge protocol) | Fills the reserved C7 slot; mirrors V1's judge setup |
| Add second vision judge to V1 (cross-family) | Eliminates self-preference bias when tool backing LLM matches judge |
| Add per-prompt `visualChecklist` to prompt YAML; wire into V1 | Enables per-task visual criteria instead of fixed 8-item rubric |
| Add F4 LLM-as-judge functional match scorer | Covers criteria that resist programmatic checks |
| Add `env_setup_clean` sub-check to C5 | Catches AI tools that commit broken `package.json` |
| Add Semgrep OWASP ruleset + deployed header audit to S1 | Completes the full S1 research spec |

### v0.3 priority changes

| Change | Impact |
|---|---|
| Add dynamic per-prompt F1 timeout from `baselineBuildSeconds` in prompt YAML | Prevents false-positive timeouts on complex prompts |
| Implement V3 reference-design fidelity (CLIP + Block-Match + Text + Position + Color) | Enables reference-image prompts (Tier 3 "make it look like Linear") |
| Add typographic hierarchy, color count/harmony, and CSS signal checks to V2 | Closes gap between current 4-check heuristic and full research spec |
| Implement harness-instrumented timing layer (replaces self-reported cost) | Enables automated leaderboard refreshes without manual timing input |
| Krippendorff's α calibration pipeline for V1 | Validates judge reliability against human ratings |
| Duplication detection (`jscpd`) in C6 | Completes AST complexity sub-checks |
| `osv.dev` cross-check in S3 | Catches CVEs not yet in npm advisory feed |
| Quarterly S2 pattern refresh process | Keeps auth anti-patterns current as Supabase/Firebase/Clerk evolve |

### Not planned (v0.1 scope decisions)

| Item | Reason deferred |
|---|---|
| Multi-turn iterative track (T4, T5) | Requires session-state management across turns; significant adapter complexity |
| App track (auth, Supabase, CRUD) | ~2 weeks of plumbing; not needed for static landing page track |
| V5 animation/interaction polish | Research rates this as noise below top quintile; low ROI |
| Private prompt split + contamination rotation | Only needed once public scores stabilize |
| Live tool-drift time series | Operational concern; needs weekly runner infrastructure |

---

## Scorer version history

| Scorer | File | Version | Notes |
|---|---|---|---|
| f1 | `functional/f1-render.ts` | 0.1.0 | Fixed 30s timeout; 8s network-idle cap |
| f2 | `functional/f2-acceptance.ts` | 0.1.0 | mustHave / shouldHave weighting |
| f5 | `functional/f5-errors.ts` | 0.1.0 | Linear decay at 10 errors |
| f6 | `functional/f6-verbatim.ts` | 0.1.0 | exact_copy, hex_value, structural types |
| c1 | `code-quality/c1-eslint.ts` | 0.1.0 | typescript-eslint recommended only |
| c2 | `code-quality/c2-types.ts` | 0.1.0 | tsc strict; ignores missing-module errors |
| c3 | `code-quality/c3-axe.ts` | 0.1.0 | wcag2a/aa, wcag21a/aa, wcag22aa tags |
| c4 | `code-quality/c4-lighthouse.ts` | 0.1.0 | 3-run median; mobile 360×640 |
| c5 | `code-quality/c5-bundle-size.ts` | 0.1.0 | Raw source bytes; no gzip; no env_setup_clean |
| c6 | `code-quality/c6-complexity.ts` | 0.1.0 | SonarJS cognitive-complexity threshold 15 |
| c7 | — | — | Reserved; not yet implemented |
| c9 | `code-quality/c9-seo.ts` | 0.1.0 | 10 configurable checks |
| v1 | `visual/v1-judge.ts` | 0.1.0 | Single judge; fixed 8-criteria rubric |
| v2 | `visual/v2-design.ts` | 0.1.0 | 4 checks: whitespace, contrast, font size, line length |
| v4 | `visual/v4-responsive.ts` | 0.1.0 | 3 viewports; horizontal overflow + touch targets |
| s1 | `security/s1-secrets.ts` | 0.1.0 | 8 regex patterns; binary pass/fail |
| s2 | `security/s2-auth.ts` | 0.1.0 | 13 patterns; client-side awareness; weighted severity |
| s3 | `security/s3-vuln.ts` | 0.1.2 | npm audit; critical=10, high=3, moderate=1, low=0.1 penalty |
| cost | `cost.ts` | 0.1.0 | Self-reported; informational only |

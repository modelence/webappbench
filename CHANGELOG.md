# Changelog

All notable changes to `@modelence/benchmark` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning. For release-level scope and shipping status see [ROADMAP.md](ROADMAP.md); for per-scorer mechanics see [METRICS.md](METRICS.md).

---

## [0.2.0] — 2026-04-29

Signal quality and shippability release. Closes the largest gaps in the v0.1 scorer set, makes the harness robust against batch stalls, and reshapes the corpus to test stateful applications, not just landing pages.

### Added

- **Composite weighting.** Composite is now a weighted mean of dimension scores instead of an unweighted mean across non-null scorers. Implemented dimension weights — Functional 47% / Code Quality 18% / Visual 24% / Security 11%; Cost is informational only (0%) by design. Within-dimension weights documented per scorer in METRICS.md (e.g. F2 = 45% of Functional, V1 = 55% of Visual).
- **Null-scorer renormalization.** When a scorer's input is missing, its weight redistributes proportionally within the dimension. When a whole dimension has no contributors, that dimension drops out and its weight redistributes across the remaining dimensions.
- **Per-dimension breakdown** printed alongside the composite in console output and surfaced as four colored columns in the HTML leaderboard between the composite and per-scorer columns.
- **Weight badges** on per-scorer column headers and glossary cards in the HTML leaderboard.
- **C8 install scorer** (new). `npm ci` (or `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile`) succeeds from a clean temp dir. Catches committed `package.json` files that don't actually install — a common failure where the tool worked around dep conflicts locally with stale `node_modules` but the committed manifest doesn't reproduce.
- **F2 setup actions.** Each acceptance criterion may carry an optional `setup: []` array of state-mutating actions (`evaluate`, `fill`, `click`, `press`, `reload`, `waitFor`) that run before the locator is evaluated. Unlocks empty-state checks, persistence-across-reload, and CRUD-after-action testing — Tier 2+ apps can now verify the app actually works, not just that it has the right shape.
- **F4 + V1 per-prompt checklists.** Both judges now accept per-prompt extras under `functional_checklist.extra` / `visual_checklist.extra`, on top of the fixed default rubrics.
- **V1 copy-quality defaults** — three default criteria added to V1: copy specificity (no SaaS-speak), no fabricated trust signals, CTA verb specificity. Skipped when the prompt sets `placeholder_copy: true`.
- **V2 CSS convention signals** — extended from 4 layout checks to 8 by adding `box-sizing: border-box` rate, `@media (prefers-reduced-motion)` presence, ≥5 distinct CSS custom properties, `:focus-visible` rule presence. Graceful null-handling when stylesheets are CORS-blocked.
- **S1 deployed-header audit** — six standard HTTP security headers checked on the deployed URL: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. Combined with the existing source secrets scan into a unified S1 result.
- **S1 external scanners** — optional Semgrep (`p/secrets` + `p/owasp-top-ten` rulesets) and trufflehog filesystem mode integration. Findings unioned across regex + Semgrep + trufflehog. Each external scanner is independently optional — the harness gracefully degrades when not installed.
- **Tier 2 stateful corpus prompt** — `todo-localstorage.yaml`. Single-user todo app with localStorage persistence. Acceptance criteria exercise empty-state, add-task, persistence-across-reload, and other stateful flows via F2's new setup-action mechanic.
- **`prompts/landing-extra/` archive** for the five v0.1 landing prompts not retained in the active corpus. Loadable for ad-hoc runs via `--corpus prompts/landing-extra`.
- **Default empty-state acceptance criterion** documented as the README's "Adding a prompt" exemplar — every Tier 2/3 app prompt should include a `must_have` criterion that verifies empty-state copy renders on a fresh load.
- **[ROADMAP.md](ROADMAP.md)** — release-by-release status tracking.
- **[CHANGELOG.md](CHANGELOG.md)** — this file.

### Changed

- **C4 robustness rewrite.** Per-run 90s + overall 240s timeouts. Chrome restarted between runs. Tolerates ≥1 successful run; previously required all three. Explicit `maxWaitForLoad` / `maxWaitForFcp` to pin Lighthouse internal timeouts. Resolves batch stalls that affected v0.1 scoring on slow networks or sites with hung renderers.
- **C5 gzipped network measurement.** Primary signal is now the gzipped JS+CSS payload transferred over the wire (`Content-Length` from `page.on('response')`), with Lighthouse-aligned thresholds (≤170 KB = 1.0, decay to 0 at ≥1 MB). Falls back to uncompressed source bytes only when no network capture is available; the fallback is clearly labelled `scoringSource: 'source-fallback'`.
- **Cost reframed as informational.** TTFR / TTWB / USD are still captured per submission and shown on the leaderboard, but no longer enter the composite. Avoids Goodhart-style price-war optimization and skirts the contestable USD-equivalent normalization across heterogeneous credit systems.
- **Corpus reshape.** Active corpus contracted from six landing prompts to two (`nimbus-notes-landing` Tier 1 + `todo-localstorage` Tier 2). The other five landing prompts moved to `prompts/landing-extra/` for ad-hoc use.
- **F3 absorbed into F2.** The original v0.1 design carved out F3 as a separate spec-based-tests scorer; F2's setup-actions extension delivers the same outcome with simpler harness mechanics. The `f3` scorer ID will not be used.
- **`submissions.example.yaml`** updated with a Tier 2 entry and an accurate inventory of which scorers source ZIP unlocks (9 source-only scorers).

### Fixed

- C4 batch stalls on Lighthouse hangs (see "C4 robustness rewrite" above).
- Composite renormalization now correctly handles `null` scorer outputs across dimension boundaries; previously a single `null` could disproportionately affect the composite by being averaged in as if it were a value.

### Scorer version constants bumped

| Scorer | v0.1 | v0.2 |
|---|---|---|
| F2 acceptance | 0.1.0 | 0.2.0 (setup actions) |
| F4 intent judge | 0.1.0 | 0.2.0 (per-prompt checklist) |
| C4 Lighthouse | 0.1.0 | 0.2.0 (robustness rewrite) |
| C5 bundle size | 0.1.0 | 0.2.0 (gzipped network) |
| V1 visual judge | 0.1.0 | 0.2.0 (per-prompt checklist + copy-quality defaults) |
| V2 design heuristics | 0.1.0 | 0.2.0 (4 → 8 checks) |
| S1 secrets | 0.1.0 | 0.3.0 (header audit + Semgrep + trufflehog) |
| C8 install | — | 0.1.0 (new) |

Scorers that did not change in v0.2 retain their `0.1.0` version constants (F1, F5, F6, C1, C2, C3, C6, C7, C9, V4, S2, cost). S3 stays at `0.1.2` from a v0.1.x patch.

### Known limitations

- Backend correctness, auth correctness, and server-side security are out of scope for v0.2. The Tier 3 backend-bearing CRM corpus prompt and the F7 / F8 / F9 / S4 / C10 / C12 scorers that go with it ship in v0.3.
- All three judge scorers (V1, F4, C7) currently use a single LLM from a single provider. Cross-family dual-judge protocol planned for v0.3.

---

## [0.1.0] — 2026-04-27

Established the scoring harness, prompt corpus format, artifact contract, and the static HTML leaderboard. Released untagged; the v0.1.0 work concluded with commit `90d8a6e` (`fix (c7): improved reliability of npm audit`) on 2026-04-27. This entry documents the v0.1.0 baseline against which v0.2's changes are measured.

### Added

#### Scoring harness

- Per-submission orchestration (navigate → capture screenshots → run scorers in dependency order → write artifacts).
- Conditional execution: F1 is a gate; downstream browser-dependent scorers skip when render fails.
- Prompt corpus loader with Zod schema validation.
- Submission YAML schema and `score-all` batch runner.
- Static HTML leaderboard (`leaderboard.html`).
- Per-scorer artifact JSON written to `artifacts/<tool>/<prompt>/<run>/`.

#### Functional scorers (5)

- **F1** render — HTTP 2xx + non-empty body within 30s.
- **F2** acceptance — per-prompt `must_have` / `should_have` Playwright assertions.
- **F4** intent judge — initial fixed 4-criteria rubric (intent_match, feature_completeness, content_relevance, flow_coherence).
- **F5** errors — console errors + 4xx/5xx network responses.
- **F6** verbatim — exact strings, hex values, structural identifiers from the prompt.

#### Code quality scorers (8 in the v0.1 cut)

- **C1** lint — ESLint typescript-eslint recommended, normalized per 1k LOC.
- **C2** types — `tsc --noEmit --strict` errors per 1k LOC.
- **C3** a11y — axe-core WCAG 2.1/2.2 AA violations per 1k DOM nodes.
- **C4** Lighthouse — performance score, mobile-throttled 3-run median (initial single-timeout version; replaced in v0.2).
- **C5** bundle size — uncompressed source bytes (replaced in v0.2 with gzipped network measurement).
- **C6** complexity — cognitive complexity via eslint-plugin-sonarjs.
- **C7** maintainability judge — LLM judge over a sampled source excerpt (5-criteria rubric).
- **C9** SEO — title / meta / canonical / OG / JSON-LD / lang / heading hierarchy.

#### Visual scorers (3)

- **V1** visual judge — initial fixed 8-criteria rubric (visual hierarchy, typography, color harmony, whitespace, brand fit, CTA prominence, mobile layout, overall polish).
- **V2** design heuristics — initial 4 layout checks (whitespace, contrast, font size, line length).
- **V4** responsive — viewport tests at 360×800, 768×1024, 1440×900 + mobile touch targets ≥44px.

#### Security scorers (3)

- **S1** secrets — initial 8-pattern regex scan (OpenAI / Anthropic / AWS / GitHub / PEM / JWT / hardcoded password / hardcoded secret).
- **S2** auth patterns — 13 deterministic anti-pattern checks (Supabase service-role keys in client code, Firebase test mode, JWT decode without verify, Stripe/OpenAI keys in client bundle, hardcoded admin emails/passwords, password reset without token).
- **S3** vulnerabilities — `npm audit` weighted by severity.

#### Cost block

- **Cost** — self-reported TTFR / TTWB / USD-equivalent. Initially weighted into the composite; reframed as informational-only in v0.2.

#### Tooling

- Single CLI entrypoint via `commander`.
- Live console progress with per-scorer pass/score lines.
- Subcommands: `tools`, `prompts`, `submit`, `score`, `score-all`, `report`.

#### Composite

- Unweighted mean across non-null quality scorers. Replaced in v0.2 with the dimension-weighted composite documented in METRICS.md.

#### Corpus

- Six landing-page prompts (Tier 1 / 2): `nimbus-notes-landing`, `blog-index`, `ecommerce-product-landing`, `portfolio-landing`, `saas-pricing-page`, `startup-landing`. Five of these moved to `prompts/landing-extra/` in v0.2.

#### Documentation

- README with repo overview, install + usage, all v0.1 scorers.
- METRICS.md with full per-scorer spec, rationale, and gap-vs-research notes.

[0.2.0]: https://github.com/modelence/benchmark/releases/tag/v0.2.0
[0.1.0]: https://github.com/modelence/benchmark/releases/tag/v0.1.0

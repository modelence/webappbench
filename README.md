# WebAppBench

Reproducible open-source benchmark for AI sitebuilder products — Lovable, Replit Agent, Same.new, v0, bolt.new, Claude Artifacts.

Live leaderboard and rankings: <https://WebAppBench.com>

## What this repo does

You drive each sitebuilder's UI manually (one prompt, one tool), paste the resulting preview URL into a config file, and the harness runs a deterministic scoring pipeline against that URL. Scoring covers four dimensions: **functional correctness**, **code quality**, **visual design**, and **security**. Cost / speed is captured separately as informational data.

The output is a per-run JSON artifact and a static HTML leaderboard (`leaderboard.html`) ranking every (tool, prompt, run) submission across all metrics.

**No browser automation of the sitebuilders.** Playwright-driven sign-ins get accounts banned (confirmed with Lovable), so submission is manual; scoring is fully automated.

See [METRICS.md](METRICS.md) for the full per-scorer spec, weights, and rationale, and [ROADMAP.md](ROADMAP.md) for what's shipped vs planned per release.

## Metrics tracked

19 scorers across 5 dimensions, plus 3 additive backend-track scorers (F7/F8/S4) that activate only on Tier 3 backend-bearing submissions. Composite score = weighted mean of dimension scores (Functional 47% / Code Quality 18% / Visual 24% / Security 11%; Cost 15% redistributed because it is informational only). The composite-contribution percentages below are for the default (non-backend) corpus; on a backend submission F7/F8/S4 reflow in and the others compress proportionally (see [METRICS.md](METRICS.md) § "Backend-track ... scorers (additive)").

### Functional correctness (47% of composite)

| Scorer | Weight | Measures |
|---|---|---|
| **F1** render | 7.05% | HTTP 2xx + non-empty body within 30s. Gate: failures skip downstream scorers. |
| **F2** acceptance | 21.15% | Per-prompt `must_have` / `should_have` checklist via Playwright role/label/text locators. |
| **F4** intent judge | 4.7% | LLM judge (vision) over screenshots scoring intent match, feature completeness, content relevance, flow coherence. Per-prompt extras supported via `functional_checklist.extra`. |
| **F5** errors | 2.35% | Console errors + 4xx/5xx network responses. 0 errors = 1.0; linear decay to 0 at 10+. |
| **F6** verbatim | 11.75% | Exact strings, hex values, structural identifiers from the prompt (e.g. `"Get started"`, `#003366`). Source-only. |
| **F7** auth round-trip | additive | _Backend track._ login → create a marked record → log out → log in again → record persists. N/A without a `backend` block. |
| **F8** cross-session | additive | _Backend track._ Record created in browser context A must appear in a fresh incognito context B after login — real backend vs. localStorage. |

### Code quality (18% of composite)

| Scorer | Weight | Measures |
|---|---|---|
| **C1** lint | 3.6% | ESLint with typescript-eslint recommended rules, normalized per 1k LOC. Source-only. |
| **C2** types | 0.9% | `tsc --noEmit --strict` errors per 1k LOC. Filters missing-module errors. Source-only. |
| **C3** a11y | 3.6% | axe-core WCAG 2.1/2.2 AA violations per 1k DOM nodes. |
| **C4** performance | 3.6% | Lighthouse performance score (mobile-throttled, median of 3 runs). |
| **C5** bundle | 0.9% | Gzipped JS+CSS payload over the wire (`Content-Length` from `page.on('response')`). Lighthouse-aligned thresholds: ≤170 KB = 1.0, ≥1 MB = 0. Falls back to uncompressed source bytes if no network capture. |
| **C6** complexity | 0.9% | Cognitive complexity violations (eslint-plugin-sonarjs) per 1k LOC. Source-only. |
| **C7** maintainability judge | 2.7% | LLM judge over a sampled source excerpt scoring naming, separation of concerns, component reuse, prop typing, secret handling. Source-only. |
| **C8** install | 0.9% | `npm ci` (or pnpm/yarn equivalent) succeeds in a clean temp dir. Catches committed `package.json` files that don't actually install. Source-only. |
| **C9** SEO | 0.9% | Per-prompt-applicable checks: title length, meta description, canonical, OG tags, JSON-LD, `html[lang]`, heading hierarchy. |

### Visual design (24% of composite)

| Scorer | Weight | Measures |
|---|---|---|
| **V1** visual judge | 13.2% | LLM judge over 3 screenshots scoring 8 visual defaults + 3 copy-quality defaults (no SaaS-speak, no fabricated trust signals, CTA verb specificity) + per-prompt `visual_checklist.extra`. |
| **V2** design heuristics | 7.2% | 8 deterministic in-browser checks: 4 layout (whitespace, contrast, font size, line length) + 4 CSS conventions (`box-sizing: border-box`, `@media (prefers-reduced-motion)`, ≥5 CSS custom properties, `:focus-visible` rule). |
| **V4** responsive | 3.6% | Layout sanity at 360×800, 768×1024, 1440×900. No horizontal overflow + mobile touch targets ≥44px. |

### Security (11% of composite)

| Scorer | Weight | Measures |
|---|---|---|
| **S1** secrets + headers | 4.4% | (a) Source secret scan unioned across regex (always on), Semgrep `p/secrets` + `p/owasp-top-ten` (if installed), trufflehog filesystem (if installed). (b) Deployed HTTP header audit: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. |
| **S2** auth patterns | 3.85% | 16 deterministic anti-pattern checks for Supabase service-role keys in client code, RLS disabled, JWT decode without verify, Firebase test mode, Stripe/OpenAI keys in client bundle, hardcoded admin emails/passwords, password reset without token, unsanitized HTML (XSS) sinks, insecure transport, sensitive data in logs. Source-only. |
| **S3** vulnerabilities | 2.75% | `npm audit` weighted by severity (critical×10 + high×3 + moderate + low×0.1). Source-only. |
| **S4** backend probes | additive | _Backend track._ Read-only runtime probes — unauthenticated GET (must be rejected) + cross-user GET (user A must not read user B's data). Catches the canonical "RLS off" failure S2 only infers from client code. |

### Cost / speed (informational, excluded from composite)

| Scorer | Measures |
|---|---|
| **Cost** | Self-reported TTFR (time to first render) / TTWB (time to working build) + approximate USD cost (`cost`, platform credits converted at retail rate). Not instrumented in v0.1. |

When a scorer's input is missing (no source ZIP, unreachable URL, etc.) it returns null and its weight redistributes within the dimension. If a whole dimension is empty, its weight redistributes across the rest.

## Requirements

- Node.js ≥ 20
- Chromium (auto-installed by `@playwright/test`)
- **Optional, recommended for full S1 coverage:**
  - [Semgrep](https://semgrep.dev) — `pip install semgrep`
  - [trufflehog](https://github.com/trufflesecurity/trufflehog) — `brew install trufflehog` or `go install github.com/trufflesecurity/trufflehog/v3@latest`
- **Optional, required for V1/F4/C7 (judge scorers):**
  - `OPENROUTER_API_KEY` environment variable. Get one at [openrouter.ai](https://openrouter.ai/keys). Without it, the three judge scorers return null and drop from the composite.

## Install

```bash
npm install
npx playwright install chromium
npm run typecheck
```

Optionally add an `.env` file:

```bash
OPENROUTER_API_KEY=sk-or-...
# OPENROUTER_MODEL=google/gemini-2.5-pro   # default if unset
```

## Usage

### Config-driven (recommended)

Declare all (tool, prompt, url) triples in one place, then run a single command.

1. Copy the example:
   ```bash
   cp submissions.example.yaml submissions.yaml
   ```
2. For each tool × prompt:
   - Open the tool's UI (e.g. <https://lovable.dev>, <https://replit.com>).
   - Paste the prompt from `prompts/corpus/<prompt-id>.yaml`.
   - Copy the resulting preview URL into `submissions.yaml`.
   - (Optional) export the source ZIP and reference it in `source:`.
   - (Optional) record wall-clock timing (`duration`) and USD cost (`cost`) in the same entry.
3. Score everything and generate the leaderboard:
   ```bash
   npm run bench -- score
   open leaderboard.html
   ```

`score` (with no tool argument) is idempotent. Re-running overwrites scores for URLs still in the config. Add new entries and re-run; remove entries to stop scoring them (existing artifact dirs stay until you `rm -rf artifacts`). To rescore a single tool, pass its name: `npm run bench -- score lovable`.

### Ad-hoc

For one-offs:

```bash
npm run bench -- submit --tool lovable --prompt nimbus-notes-landing --url https://<preview>.lovable.app/
npm run bench -- rescore artifacts/lovable/nimbus-notes-landing/0
npm run bench -- leaderboard
```

### CLI reference

```bash
npm run bench -- tools                                            # List supported tools
npm run bench -- prompts                                          # List corpus prompts (validates YAML)
npm run bench -- submit --tool <t> --prompt <id> --url <url>      # Create a single submission
                       [--source path/to/source.zip]              #   (optional) attach source ZIP for source-only scorers
npm run bench -- score [tool] [--prompt <id>] [--run <idx>]       # Submit + score submissions.yaml entries (all by default; one tool if given), then regenerate the leaderboard
npm run bench -- rescore <submission-dir>                         # Re-run all scorers on an existing submission directory in place
npm run bench -- leaderboard [--artifacts artifacts] [--out leaderboard.html]
npm run bench -- audit <submission-dir> [--out file]              # AI-actionable Markdown audit of failing scorers
npm run bench -- audit --all [--tool <name>] [--out file]         #   rollup mode: every submission under artifacts/, optionally filtered by tool
```

When `score` finishes, the console prints the composite score plus a per-dimension breakdown:

```
Score: 73.4 / 100  ▓  (16 scorers)
    Functional    78.3 / 100   weight 47%   (f1 f2 f4 f5 f6)
    Code Quality  62.1 / 100   weight 18%   (c1 c2 c3 c4 c5 c6 c7 c8 c9)
    Visual        71.5 / 100   weight 24%   (v1 v2 v4)
    Security      88.0 / 100   weight 11%   (s1 s2 s3)
```

### Driving fixes with `audit`

After scoring, run `audit` to get a Markdown audit you can paste into an AI to drive concrete fixes:

```bash
npm run bench -- audit artifacts/lovable/nimbus-notes-landing/0
# Wrote artifacts/lovable/nimbus-notes-landing/0/audit.md (4 failing scorers)
```

The report opens with the composite score + per-dimension breakdown, then enumerates failing scorers in **composite-contribution order** (highest-leverage fixes first). Each failure section contains the concrete data an AI needs to action: F2 surfaces failed acceptance-criterion ids with their original locator/assertion; F6 lists missing verbatim strings; C3 enumerates axe rule ids with selectors; V1/F4/C7 surface judge rationales for criteria scoring ≤3/5; S1/S2/S3 list rule ids, severities, and source line numbers with 7 lines of context (3 before + matched line + 3 after) extracted from the source ZIP. Passing and not-applicable scorers are omitted entirely.

For multi-submission audits across one tool — useful when you want to spot consistent failure patterns across runs:

```bash
npm run bench -- audit --all --tool lovable --out lovable-fixes.md
```

Rollup mode adds a per-tool failure-frequency table at the top so you can prioritize systemic fixes (e.g. "C8 install fails 100% of the time → fix the lockfile generation in Lovable's export step before fixing per-submission F2 failures").

## Adding a prompt

Each prompt is a YAML file under `prompts/corpus/`. Required fields:

- `id` — kebab-case, must match the filename.
- `tier` — 1 / 2 / 3 (difficulty).
- `prompt` — the natural-language prompt sent to the sitebuilder.
- `must_have` / `should_have` — F2 acceptance criteria (see "Acceptance criteria" below).
- `verbatim_constraints` — exact strings / hex values / structural identifiers used by F6.
- `seo_applicable` — list of SEO checks C9 should apply.

Optional fields:

- `visual_checklist.extra[]` — per-prompt criteria added to V1's default rubric.
- `visual_checklist.placeholder_copy` — set `true` to skip V1's 3 copy-quality defaults when the prompt explicitly invites placeholder content (e.g., a todo app prompt that asks for sample tasks).
- `functional_checklist.extra[]` — per-prompt criteria added to F4's default rubric.
- `backend_probes[]` — read-only backend security probes for Tier 3 backend-bearing prompts (consumed by S4). Each is `{ kind, id, path, expect_status }` where `kind` is `unauth_get` (GET a protected endpoint with no auth → expect 401/403) or `cross_user_get` (GET user B's resource while authed as user A → expect rejection; adds `forbid_body_contains`, a synthetic marker that must be absent). Requires the submission to carry a `backend` block (`backend_url` + `signup_credentials` + `seed_strategy` + `seed_records`); see `submissions.example.yaml`.

### Acceptance criteria

Each criterion is `{ id, locator, assert, custom?, setup? }`:

- `locator` — a Playwright expression evaluated against `page` (e.g. `getByRole('button', { name: /submit/i })`)
- `assert` — `toBeVisible`, `toHaveCount(N)`, or `toHaveCountAtLeast(N)`
- `custom` — optional bounding-box check like `boundingBox.y < 800`
- `setup` — optional sequence of actions that run **before** the locator is evaluated (F2 0.2+). Use this for stateful prompts that need to drive the page into a specific state.

#### Setup actions

| Kind | Args | Use for |
|---|---|---|
| `evaluate` | `expr: string` | Run JS in the page (e.g. `() => localStorage.clear()`) |
| `fill` | `locator`, `value` | Type into a textbox/textarea |
| `click` | `locator` | Click a button/link |
| `press` | `locator`, `key` | Press a key (e.g. `Enter`) |
| `reload` | — | `page.reload()` — used to verify persistence |
| `waitFor` | `locator` | Wait for an element to appear |

Setup steps run sequentially. If any step fails, the criterion fails with a `setup failed: <step description>` note.

#### Default empty-state criterion (Tier 2+ apps)

Every Tier 2/3 app prompt should include a `must_have` criterion that verifies the empty-state copy renders on a fresh load (`localStorage.clear()` + `reload`, then assert empty-state text is visible). This is the single most common AI app failure: the page renders fine with seed data, then crashes or shows a blank pane on zero-record state.

Example from [`prompts/corpus/todo-localstorage.yaml`](prompts/corpus/todo-localstorage.yaml):

```yaml
must_have:
  - id: empty_state_copy
    setup:
      - kind: evaluate
        expr: "() => localStorage.clear()"
      - kind: reload
    locator: "getByText(/no tasks yet/i)"
    assert: "toBeVisible"
```

#### Worked example: persistence test

Add a task, reload the page, confirm the task survives — the canonical localStorage round-trip:

```yaml
- id: persists_across_reload
  setup:
    - kind: evaluate
      expr: "() => localStorage.clear()"
    - kind: reload
    - kind: fill
      locator: "getByRole('textbox')"
      value: "Persistent task"
    - kind: press
      locator: "getByRole('textbox')"
      key: "Enter"
    - kind: reload
  locator: "getByText('Persistent task', { exact: true })"
  assert: "toBeVisible"
```

See [`prompts/corpus/todo-localstorage.yaml`](prompts/corpus/todo-localstorage.yaml) for the full Tier 2 example. For a landing-page example with checklist extras, see [`prompts/landing-extra/saas-pricing-page.yaml`](prompts/landing-extra/saas-pricing-page.yaml) (archived from v0.1).

## Layout

```
src/
  core/                  # Types, submission schema, artifact writers
  prompts/               # Zod validator + YAML loader
  scorers/
    functional/          # f1, f2, f4, f5, f6, f7, f8
    code-quality/        # c1, c2, c3, c4, c5, c6, c7, c8, c9
    visual/              # v1, v2, v4
    security/            # s1, s2, s3, s4, external-scanners (Semgrep + trufflehog wrappers)
    backend/             # login.ts (form heuristics), auth.ts (token capture + replay)
    cost.ts              # User-reported timing
    composite.ts         # Weighted composite + per-dimension breakdown
    orchestrate.ts       # Single submission → all scorers
    score-all.ts         # Batch from submissions.yaml
    progress.ts          # Live console progress
    format.ts            # Per-scorer one-line summaries
  report/generate.ts     # JSON artifacts → static HTML leaderboard
  cli.ts                 # Commander entrypoint
prompts/
  corpus/                # Active corpus — Tier 1 landing, Tier 2 localStorage app, Tier 3 backend CRM (auth + per-user isolation; F7/F8/S4 backend scorers)
  landing-extra/         # Archived v0.1 landing prompts; load with --corpus prompts/landing-extra for ad-hoc runs
artifacts/               # .gitignored — scored runs land here
METRICS.md               # Full per-scorer documentation, weights, rationale
ROADMAP.md               # Shipped vs planned per release
```

## Caveats

- **Self-reported timing.** TTFR / TTWB / cost are user-entered. Instrumented timing is planned for a future release via automated-mode adapters for tools with APIs.
- **URL rot.** Preview URLs expire. Scores are snapshotted at submit time; re-scoring later may diverge.
- **What the tool publishes is what gets scored.** Some tools render differently in their in-editor preview than at the deployed URL. The deployed URL is what ships to users, so that's the score that counts.
- **Do not automate sitebuilder UIs.** Playwright-driven sign-in gets accounts banned. Submission is manual by design.
- **Single-judge bias on V1/F4/C7.** All three judge scorers currently use one model from one provider, which inflates scores when the tool's backing LLM matches the judge's family. Cross-family dual-judge protocol is planned for v0.4.
- **Backend-track scorers (F7/F8/S4) are Tier 3 only.** Tools that don't ship a real backend score N/A on these three scorers; null-renormalization preserves their composite proportions exactly (see METRICS.md § "Backend-track scorers (additive)").

## License

Apache-2.0

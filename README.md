# @modelence/benchmark

Reproducible open-source benchmark for AI sitebuilder products — Lovable, Replit Agent, Same.new, v0, bolt.new, Claude Artifacts.

**v0.1 philosophy:** you drive each sitebuilder's UI manually (one prompt, one tool), paste the resulting preview URL into the harness, and the harness runs the full deterministic scoring pipeline against that URL. No browser automation of the sitebuilders themselves — that gets accounts banned and ships to every user of the benchmark. Scoring uses Playwright, Lighthouse, axe-core, and a lightweight SEO checker.

## Requirements

- Node.js ≥ 20
- Chromium (auto-installed by `@playwright/test`)

## Install

```bash
npm install
npx playwright install chromium
npm run typecheck
```

## Workflow

**Config-driven (recommended).** Declare all the (tool, prompt, url) triples in one place, then run a single command.

1. Copy the example:
   ```bash
   cp submissions.example.yaml submissions.yaml
   ```
2. For each tool × prompt you want to evaluate:
   - Open the tool's UI (e.g. <https://lovable.dev>, <https://replit.com>).
   - Paste the prompt from `prompts/corpus/<prompt-id>.yaml`.
   - Copy the resulting preview URL into `submissions.yaml`.
   - (Optional) record wall-clock timing and credits spent in the same entry.
3. Score everything and generate the leaderboard:
   ```bash
   npm run bench -- score-all
   open leaderboard.html
   ```

`score-all` is re-runnable — rerunning it overwrites previous scores for the URLs still in the config. Add new entries and re-run; remove entries to stop scoring them (old artifact dirs stay until you `rm -rf artifacts`).

**Ad-hoc (without config).** For one-offs:
```bash
npm run bench -- submit --tool lovable --prompt nimbus-notes-landing --url https://<preview>.lovable.app/
npm run bench -- score artifacts/lovable/nimbus-notes-landing/0
npm run bench -- report
```

## CLI reference

```bash
npm run bench -- tools         # List supported tools
npm run bench -- prompts       # List corpus prompts (validates YAML)
npm run bench -- submit --tool <t> --prompt <id> --url <url>  # single submission
npm run bench -- score <submission-dir>                       # score a single submission
npm run bench -- score-all [--config submissions.yaml]        # batch: submit + score everything + report
npm run bench -- report [--artifacts artifacts] [--out leaderboard.html]
```

## v0.1 scorers

| Dimension | Scorer | What it measures |
|---|---|---|
| Functional | **F1** render | HTTP 2xx + non-empty body paint within 30s |
| Functional | **F2** acceptance | Per-prompt YAML checklist via Playwright `getByRole`/`getByLabel` |
| Code quality | **C3** a11y | axe-core WCAG 2.1/2.2 AA violations per 1k DOM nodes |
| Code quality | **C4** performance | Lighthouse mobile-throttled (perf, a11y, best-practices, SEO scores) |
| Code quality | **C9** SEO hygiene | Title / meta / canonical / OG / JSON-LD / lang / heading hierarchy |
| Cost / speed | **Cost** | Self-reported TTFR / TTWB + credits / USD (not instrumented) |

**Deferred to later versions:** F6 (verbatim constraints — needs source), C1 (ESLint — needs source), V1 (dual-MLLM visual judge — v0.2), automated-mode adapters for API-accessible tools (v0.3).

## Layout

```
src/
  core/                # types, submission schema, artifact writers, version utils
  prompts/             # Zod validator + YAML loader
  scorers/
    functional/        # f1-render.ts, f2-acceptance.ts
    code-quality/      # c3-axe.ts, c4-lighthouse.ts, c9-seo.ts
    cost.ts            # reads user-reported timing
    orchestrate.ts     # runs all scorers against a submission
  report/              # JSONL → static HTML leaderboard
  cli.ts               # commander entrypoint
prompts/corpus/        # YAML prompts — one per file
artifacts/             # .gitignored — scored runs land here
```

## Caveats

- **Self-reported timing.** T1/T2 are user-entered wall-clock times. Instrumented timing returns in v0.3 via automated-mode adapters for tools with APIs (v0 Platform API, bolt.diy Docker, Anthropic Messages API).
- **URL rot.** Preview URLs may expire. Scorers run at submit time and results are snapshotted; re-scoring later may diverge.
- **We score what the tool *publishes*.** Some tools render differently in their in-editor preview than at the deployed URL. The deployed URL is what ships to users, so that's the score that matters.
- **Do not automate sitebuilder UIs.** Playwright-driven sign-in gets accounts banned (confirmed with Lovable). This benchmark is explicit about that constraint.

See `ai-sitebuilder-benchmark-design.md` for the full research and roadmap, and `~/.claude/plans/plan-how-to-implement-quiet-hare.md` for the implementation plan.

## License

Apache-2.0

# @modelence/benchmark

Reproducible open-source benchmark for AI sitebuilder products (Lovable, Replit Agent, Same.new, …).

**Status:** v0.1 scaffold — adapter interface, prompt schema, CLI wiring, and health-check harness in place. Real adapter Playwright flows and scorers are the next milestone.

## Requirements

- Node.js ≥ 20
- npm ≥ 10

## Quickstart

```bash
npm install
npm run typecheck           # TypeScript strict mode, clean
npm run health              # Run health checks across all adapters
npm run bench -- prompts    # Validate and list prompts from the corpus
npm run bench -- tools      # List supported tools
```

## Layout

```
src/
  core/       # types, adapter interface, artifact-capture writers, version utils
  adapters/   # one file per tool: lovable, replit, same-new
  prompts/    # Zod schema + YAML loader
  cli.ts      # commander-based entrypoint
scripts/
  health-check.ts   # smoke test — gate for full bench runs
prompts/
  corpus/     # *.yaml — one prompt per file
artifacts/    # .gitignored — captured run outputs
```

## v0.1 roadmap

1. ✅ Types, artifact contract, prompt schema, CLI wiring
2. ⏳ Implement Playwright adapter flows (Lovable → Replit → Same.new)
3. ⏳ Implement deterministic scorers (F1, F2, F6, C1, C3, C4, C9, T1/T2)
4. ⏳ Wire `npm run bench -- run --all` end-to-end
5. ⏳ Static HTML leaderboard generator

See the full design in `ai-sitebuilder-benchmark-design.md` and the implementation plan at `~/.claude/plans/plan-how-to-implement-quiet-hare.md`.

## License

Apache-2.0

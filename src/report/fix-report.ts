import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Submission } from '../core/submission.ts';
import type { Prompt } from '../core/types.ts';
import { computeComposite, scorerWeight, type Dimension } from '../scorers/composite.ts';
import type { ScorerResult } from '../scorers/types.ts';

// ── Public API ───────────────────────────────────────────────────────────────

export interface FixReportOptions {
  // Path to a single submission directory (contains submission.json + scores.json).
  artifactDir: string;
  // Optional output path. Defaults to <artifactDir>/audit.md.
  out?: string;
}

export interface FixReportRollupOptions {
  // Path to the artifacts root (contains tool/prompt/run subdirs).
  artifactsRoot: string;
  // Optional output path. Defaults to <artifactsRoot>/audit.md.
  out?: string;
  // Optional tool filter — only include this tool's submissions in the rollup.
  tool?: string;
}

export async function generateFixReport(opts: FixReportOptions): Promise<{ outFile: string; failingScorers: number }> {
  const submission = JSON.parse(await readFile(join(opts.artifactDir, 'submission.json'), 'utf8')) as Submission;
  const prompt = JSON.parse(await readFile(join(opts.artifactDir, 'prompt.json'), 'utf8')) as Prompt;
  const scores = JSON.parse(await readFile(join(opts.artifactDir, 'scores.json'), 'utf8')) as Record<string, ScorerResult>;

  const sourceDir = existsSync(join(opts.artifactDir, 'source')) ? join(opts.artifactDir, 'source') : null;

  const md = await renderSubmissionReport(submission, prompt, scores, sourceDir);
  const outFile = opts.out ?? join(opts.artifactDir, 'audit.md');
  await writeFile(outFile, md, 'utf8');

  const failingScorers = countFailures(scores);
  return { outFile, failingScorers };
}

export async function generateFixReportRollup(opts: FixReportRollupOptions): Promise<{ outFile: string; submissionCount: number; toolCount: number }> {
  const submissions = await collectSubmissions(opts.artifactsRoot, opts.tool);

  const sections: string[] = [];
  sections.push(renderRollupHeader(submissions.length, submissions.map((s) => s.submission.tool)));

  const byTool = groupBy(submissions, (s) => s.submission.tool);
  const toolCount = byTool.size;

  for (const [tool, toolSubmissions] of [...byTool.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Heading hierarchy in rollup mode:
    //   H1 = rollup title
    //   H2 = tool
    //   H3 = submission (set as headingLevel for the inner render)
    //   H4 = inner sub-sections (Submission identity, Score, etc.)
    sections.push(`\n---\n\n## Tool: ${tool}\n`);
    sections.push(renderToolSummary(toolSubmissions));
    for (const sub of toolSubmissions) {
      sections.push(`\n### Submission: ${sub.submission.promptId} (run ${sub.submission.runIdx})\n`);
      sections.push(await renderSubmissionReport(sub.submission, sub.prompt, sub.scores, sub.sourceDir, { headingLevel: 3 }));
    }
  }

  const outFile = opts.out ?? join(opts.artifactsRoot, 'audit.md');
  await writeFile(outFile, sections.join('\n'), 'utf8');
  return { outFile, submissionCount: submissions.length, toolCount };
}

// ── Per-submission rendering ─────────────────────────────────────────────────

interface RenderOptions {
  // Top heading level for this submission's report. Defaults to 1 (single-submission)
  // and bumps to 3 when nested inside a rollup.
  headingLevel?: number;
}

async function renderSubmissionReport(
  submission: Submission,
  prompt: Prompt,
  scores: Record<string, ScorerResult>,
  sourceDir: string | null,
  opts: RenderOptions = {},
): Promise<string> {
  const h = opts.headingLevel ?? 1;
  const heading = (level: number, text: string): string => `${'#'.repeat(Math.min(level, 6))} ${text}`;

  const out: string[] = [];

  // Lead with a one-paragraph orientation written for the AI receiving this.
  if (h === 1) {
    out.push(heading(1, 'Fix report'));
    out.push('');
    out.push("This is an actionable audit of failing benchmark scorers for a single submission. Each section names a specific failure with concrete data (failed acceptance-criterion ids, axe rule ids, missing verbatim strings, judge rationales, source line numbers, etc). Read through the failures top-to-bottom — they are ordered by composite contribution descending, so the highest-leverage fixes come first. Passing and not-applicable scorers are omitted.");
    out.push('');
  }

  // Submission identity + scores.
  out.push(heading(h + 1, 'Submission'));
  out.push('');
  out.push(`- **Tool**: \`${submission.tool}\``);
  out.push(`- **Prompt**: \`${submission.promptId}\` (tier ${prompt.tier})`);
  out.push(`- **Run**: ${submission.runIdx}`);
  out.push(`- **Tool version**: \`${submission.toolVersion}\``);
  out.push(`- **Submitted**: ${submission.submittedAt}`);
  out.push(`- **Live URL**: ${submission.artifactUrl}`);
  out.push('');

  // Composite + dimension breakdown.
  const composite = computeComposite(scores);
  if (composite) {
    out.push(heading(h + 1, 'Score'));
    out.push('');
    out.push(`**Composite: ${composite.pct} / 100** (weighted mean across ${composite.outOf} contributing scorer${composite.outOf === 1 ? '' : 's'})`);
    out.push('');
    out.push('| Dimension | Score | Dimension weight |');
    out.push('|---|---|---|');
    for (const dim of composite.dimensions) {
      out.push(`| ${dimensionLabel(dim.dimension)} | ${(dim.score * 100).toFixed(1)} / 100 | ${dim.weight}% |`);
    }
    out.push('');
  }

  // Original prompt text — the AI fixing things needs to see what was asked for.
  out.push(heading(h + 1, 'Original prompt'));
  out.push('');
  out.push('```');
  out.push(prompt.prompt.trim());
  out.push('```');
  out.push('');

  // Failures, ordered by composite contribution descending.
  const failures = orderedFailures(scores);
  if (failures.length === 0) {
    out.push(heading(h + 1, 'Failures'));
    out.push('');
    out.push('_No failing scorers. Submission passed every applicable check._');
    out.push('');
    return out.join('\n');
  }

  out.push(heading(h + 1, `Failures (${failures.length})`));
  out.push('');
  out.push("Ordered by composite contribution descending — fix the top items first for the largest score gains.");
  out.push('');

  for (const f of failures) {
    out.push(heading(h + 2, `${f.id.toUpperCase()} — ${formatScoreHeader(f.result)}`));
    out.push('');
    const body = await formatScorerFailure(f.id, f.result, prompt, sourceDir);
    out.push(body);
    out.push('');
  }

  return out.join('\n');
}

// ── Failure ordering ─────────────────────────────────────────────────────────

interface OrderedFailure {
  id: string;
  result: ScorerResult;
  contribution: number;
}

function orderedFailures(scores: Record<string, ScorerResult>): OrderedFailure[] {
  const fails: OrderedFailure[] = [];
  for (const [id, result] of Object.entries(scores)) {
    if (id === 'cost') continue;
    if (!isFailureToReport(result)) continue;

    const sw = scorerWeight(id);
    // Composite contribution = within-dim weight × dimension weight (each /100).
    // Used for ordering only; cost isn't in the composite so it sorts to the end.
    const dim = sw ? dimensionWeightFor(sw.dimension) : 0;
    const contribution = sw ? (sw.weight * dim) / 10000 : 0;
    fails.push({ id, result, contribution });
  }
  fails.sort((a, b) => b.contribution - a.contribution);
  return fails;
}

function isFailureToReport(result: ScorerResult): boolean {
  // Definite failure (passed === false) — always include.
  if (result.passed === false) return true;
  // Score === null (skipped/N/A) — include only if the skip is actionable
  // (e.g. C8 install reported a real install failure with passed:false).
  // The `passed === false` path already covers C8 install failures, so any
  // remaining `passed === null` are non-actionable skips. Hide them.
  return false;
}

function countFailures(scores: Record<string, ScorerResult>): number {
  return orderedFailures(scores).length;
}

// ── Per-scorer formatters ────────────────────────────────────────────────────

async function formatScorerFailure(
  id: string,
  result: ScorerResult,
  prompt: Prompt,
  sourceDir: string | null,
): Promise<string> {
  switch (id) {
    case 'f2': return formatF2(result, prompt);
    case 'f4': return formatJudgeRationales(result, 'F4 — Functional intent', /* showMissingFeatures */ true);
    case 'f6': return formatF6(result, prompt, sourceDir);
    case 'c1': return formatC1(result);
    case 'c2': return formatC2(result);
    case 'c3': return formatC3(result);
    case 'c4': return formatC4(result);
    case 'c5': return formatC5(result);
    case 'c6': return formatC6(result);
    case 'c7': return formatJudgeRationales(result, 'C7 — Code maintainability', false);
    case 'c8': return formatC8(result);
    case 'c9': return formatC9(result);
    case 'v1': return formatJudgeRationales(result, 'V1 — Visual quality', false);
    case 'v2': return formatV2(result);
    case 'v4': return formatV4(result);
    case 's1': return await formatS1(result, sourceDir);
    case 's2': return await formatS2(result, sourceDir);
    case 's3': return formatS3(result);
    default:   return formatGeneric(id, result);
  }
}

function formatF2(result: ScorerResult, prompt: Prompt): string {
  const d = result.details as Record<string, unknown>;
  const criteria = (d['criteria'] as Array<Record<string, unknown>>) ?? [];
  const failed = criteria.filter((c) => c['passed'] === false);

  const lines: string[] = [];
  lines.push(`**What this measures**: deterministic acceptance criteria from the prompt YAML, executed as Playwright assertions against the live page.`);
  lines.push('');
  lines.push(`**Result**: ${d['mustPassed'] ?? 0}/${d['mustTotal'] ?? 0} must-have, ${d['shouldPassed'] ?? 0}/${d['shouldTotal'] ?? 0} should-have.`);
  lines.push('');

  if (failed.length === 0) return lines.join('\n');

  lines.push("**Failed criteria** — for each, the prompt YAML's locator + expected assertion is shown. The page must satisfy these for F2 to pass:");
  lines.push('');
  // Look up the original criterion definitions to surface the locator + assert
  // expressions, which the AI needs to know what to actually fix.
  const allCriteria = [...prompt.mustHave, ...prompt.shouldHave];
  for (const f of failed) {
    const id = String(f['id']);
    const def = allCriteria.find((c) => c.id === id);
    const kind = String(f['kind']);
    const note = String(f['note'] ?? '');
    lines.push(`- **${id}** (${kind}-have): ${note}`);
    if (def) {
      lines.push(`  - Locator: \`${def.locator}\``);
      lines.push(`  - Expected: \`${def.assert}\`${def.custom ? ` and \`${def.custom}\`` : ''}`);
      if (def.setup && def.setup.length > 0) {
        lines.push(`  - Setup steps before the assertion ran:`);
        for (const step of def.setup) {
          lines.push(`    - \`${JSON.stringify(step)}\``);
        }
      }
    }
  }
  return lines.join('\n');
}

async function formatF6(result: ScorerResult, _prompt: Prompt, sourceDir: string | null): Promise<string> {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const constraints = (d['constraints'] as Array<Record<string, unknown>>) ?? [];
  const failed = constraints.filter((c) => c['passed'] === false);

  const lines: string[] = [];
  lines.push(`**What this measures**: explicit verbatim constraints from the prompt — exact strings, hex color values, structural identifiers — must appear literally in the source. Catches "the AI made it close but not exact" failures.`);
  lines.push('');
  lines.push(`**Result**: ${d['passed'] ?? 0}/${d['total'] ?? 0} verbatim constraints honored.`);
  lines.push('');

  if (failed.length === 0) return lines.join('\n');

  lines.push('**Missing verbatim constraints** — these strings/values must appear in source exactly as written:');
  lines.push('');
  for (const f of failed) {
    const type = String(f['type']);
    const value = String(f['value']);
    const where = String(f['where'] ?? '');
    lines.push(`- **\`${value}\`** (${type})${where ? ` — should appear in: ${where}` : ''}`);
  }

  // F6 doesn't report file:line for failures — by definition the constraint
  // is missing. But we can hint at where the AI should look by surfacing the
  // closest related strings in source if the source ZIP is present.
  if (sourceDir && failed.length > 0) {
    lines.push('');
    lines.push(`_Source directory available at \`${relative(process.cwd(), sourceDir)}\` for reference._`);
  }

  return lines.join('\n');
}

function formatC1(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const lines: string[] = [];
  lines.push(`**What this measures**: ESLint error and warning density (typescript-eslint recommended config), normalized per 1k LOC.`);
  lines.push('');
  lines.push(`**Result**: ${d['totalErrors'] ?? 0} errors, ${d['totalWarnings'] ?? 0} warnings across ${d['totalLoc'] ?? 0} LOC (${(d['errorsPer1kLoc'] as number ?? 0).toFixed(1)} errors / 1k).`);
  lines.push('');

  const top = (d['topErrors'] as Array<Record<string, unknown>>) ?? [];
  if (top.length > 0) {
    lines.push('**Top errors**:');
    for (const e of top.slice(0, 10)) {
      lines.push(`- \`${String(e['ruleId'] ?? '?')}\` in \`${String(e['file'] ?? '?')}:${String(e['line'] ?? '?')}\` — ${String(e['message'] ?? '')}`);
    }
  }
  return lines.join('\n');
}

function formatC2(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const lines: string[] = [];
  lines.push(`**What this measures**: TypeScript type errors from \`tsc --noEmit --strict\`, normalized per 1k LOC. Module-not-found errors are filtered out.`);
  lines.push('');
  lines.push(`**Result**: ${d['totalErrors'] ?? 0} type errors across ${d['totalLoc'] ?? 0} LOC.`);
  lines.push('');

  const errors = (d['errors'] as Array<Record<string, unknown>>) ?? [];
  if (errors.length > 0) {
    lines.push('**Errors**:');
    for (const e of errors.slice(0, 15)) {
      lines.push(`- \`${String(e['file'] ?? '?')}:${String(e['line'] ?? '?')}\` — \`TS${String(e['code'] ?? '?')}\` ${String(e['message'] ?? '')}`);
    }
  }
  return lines.join('\n');
}

function formatC3(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`**What this measures**: axe-core WCAG 2.1/2.2 AA accessibility violations, weighted by impact (critical > serious > moderate > minor).`);
  lines.push('');
  lines.push(`**Result**: ${d['violationsCount'] ?? 0} violations across ${d['totalNodes'] ?? 0} DOM nodes (${(d['violationsPer1kNodes'] as number ?? 0).toFixed(1)} per 1k nodes).`);
  const impact = d['impactCounts'] as Record<string, number> | undefined;
  if (impact) {
    const parts = Object.entries(impact).map(([k, n]) => `${n} ${k}`).join(', ');
    lines.push(`**By impact**: ${parts}`);
  }
  lines.push('');

  const violations = (d['violations'] as Array<Record<string, unknown>>) ?? [];
  if (violations.length > 0) {
    lines.push('**Violations** (each axe rule id links to its WCAG guidance at https://dequeuniversity.com/rules/axe/):');
    lines.push('');
    for (const v of violations.slice(0, 12)) {
      const ruleId = String(v['id'] ?? '?');
      const impact = String(v['impact'] ?? '?');
      const help = String(v['help'] ?? '');
      const nodes = (v['nodes'] as Array<Record<string, unknown>>) ?? [];
      lines.push(`- **\`${ruleId}\`** (${impact}) — ${help}`);
      for (const n of nodes.slice(0, 3)) {
        const target = (n['target'] as string[] | undefined)?.[0] ?? '?';
        const failureSummary = String(n['failureSummary'] ?? '').split('\n').filter(Boolean).slice(0, 2).join('; ');
        lines.push(`  - Selector: \`${target}\`${failureSummary ? ` — ${failureSummary}` : ''}`);
      }
    }
  } else {
    lines.push(`_Detailed per-violation breakdown is in \`axe.json\` next to this report._`);
  }
  return lines.join('\n');
}

function formatC4(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const lines: string[] = [];
  lines.push(`**What this measures**: Lighthouse performance score (mobile-throttled, median of up to 3 runs). The bar is high — most sites score in the 0.6–0.9 range; a fail (<0.5) usually means heavy unoptimized JS or render-blocking resources.`);
  lines.push('');
  lines.push(`**Result**: perf=${formatPct(d['perfScore'])}, a11y=${formatPct(d['a11yScore'])}, best-practices=${formatPct(d['bestPracticesScore'])}, seo=${formatPct(d['seoScore'])}.`);
  lines.push('');

  const m = d['metrics'] as Record<string, number | null> | undefined;
  if (m) {
    lines.push('**Core Web Vitals (median)**:');
    if (m['lcpMs'] != null) lines.push(`- LCP: ${(m['lcpMs'] / 1000).toFixed(2)}s${m['lcpMs'] > 2500 ? ' ⚠️' : ''} (good: ≤2.5s)`);
    if (m['fcpMs'] != null) lines.push(`- FCP: ${(m['fcpMs'] / 1000).toFixed(2)}s${m['fcpMs'] > 1800 ? ' ⚠️' : ''} (good: ≤1.8s)`);
    if (m['tbtMs'] != null) lines.push(`- TBT: ${m['tbtMs'].toFixed(0)}ms${m['tbtMs'] > 200 ? ' ⚠️' : ''} (good: ≤200ms)`);
    if (m['cls'] != null) lines.push(`- CLS: ${m['cls'].toFixed(3)}${m['cls'] > 0.1 ? ' ⚠️' : ''} (good: ≤0.1)`);
    if (m['siMs'] != null) lines.push(`- Speed Index: ${(m['siMs'] / 1000).toFixed(2)}s${m['siMs'] > 3400 ? ' ⚠️' : ''} (good: ≤3.4s)`);
  }
  return lines.join('\n');
}

function formatC5(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const source = String(d['scoringSource'] ?? '');
  const lines: string[] = [];
  lines.push(`**What this measures**: gzipped JS+CSS payload transferred over the wire during page load. Lighthouse-aligned thresholds: ≤170 KB = full marks, decay to 0 at ≥1 MB.`);
  lines.push('');

  if (source === 'network') {
    const bytes = Number(d['networkBytesTransferred'] ?? 0);
    const compressed = d['compressedMeasurement'] === true;
    lines.push(`**Result**: ${(bytes / 1024).toFixed(0)} KB ${compressed ? 'gzipped' : 'transferred (mixed gzip/uncompressed)'} across ${d['networkJsResponseCount'] ?? 0} JS + ${d['networkCssResponseCount'] ?? 0} CSS responses.`);
  } else {
    const bytes = Number(d['scoredBytes'] ?? 0);
    lines.push(`**Result** (network unavailable, fell back to source bytes): ${(bytes / 1024).toFixed(0)} KB uncompressed source.`);
  }
  lines.push('');
  lines.push('**Common fixes**: tree-shake unused dep imports, code-split routes, lazy-load below-the-fold sections, audit largest JS chunks for unused exports.');
  return lines.join('\n');
}

function formatC6(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const lines: string[] = [];
  lines.push(`**What this measures**: cognitive-complexity violations (eslint-plugin-sonarjs threshold 15) per 1k LOC. High complexity correlates with bug density and AI-tool inability to refactor cleanly.`);
  lines.push('');
  lines.push(`**Result**: ${d['totalViolations'] ?? 0} functions exceed cognitive-complexity 15 (${(d['violationsPer1kLoc'] as number ?? 0).toFixed(1)} per 1k LOC).`);
  lines.push('');

  const hotspots = (d['hotspots'] as Array<Record<string, unknown>>) ?? [];
  if (hotspots.length > 0) {
    lines.push('**Hotspots** — refactor these into smaller functions:');
    for (const h of hotspots.slice(0, 10)) {
      lines.push(`- \`${String(h['file'] ?? '?')}:${String(h['line'] ?? '?')}\` — complexity ${String(h['complexity'] ?? '?')}`);
    }
  }
  return lines.join('\n');
}

function formatC8(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const lines: string[] = [];
  lines.push(`**What this measures**: \`npm ci\` (or \`pnpm install --frozen-lockfile\` / \`yarn install --frozen-lockfile\`) succeeds in a clean temp dir. Catches committed \`package.json\` files that don't actually install — a "works on the AI tool's hosted environment but not on a fresh clone" failure.`);
  lines.push('');
  lines.push(`**Result**: \`${String(d['command'] ?? '?')}\` exited with code ${String(d['exitCode'] ?? 'unknown')}${d['timedOut'] ? ' (timed out)' : ''}.`);
  lines.push('');

  const err = String(d['errorSummary'] ?? '').trim();
  if (err) {
    lines.push('**Install error output**:');
    lines.push('');
    lines.push('```');
    lines.push(err);
    lines.push('```');
    lines.push('');
    lines.push('**Common fixes**: pin missing peer dep versions in `package.json`, remove `--legacy-peer-deps` workarounds, regenerate the lockfile from a known-good state, delete and recommit `node_modules`-derived state.');
  }
  return lines.join('\n');
}

function formatC9(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  const outcomes = (d['outcomes'] as Array<Record<string, unknown>>) ?? [];
  const failed = outcomes.filter((o) => o['passed'] === false);

  const lines: string[] = [];
  lines.push(`**What this measures**: SEO metadata sanity — title, meta description, canonical URL, Open Graph + Twitter Card tags, JSON-LD, lang, heading hierarchy, robots.txt, sitemap.xml. Per-prompt applicability is set in the prompt YAML.`);
  lines.push('');
  lines.push(`**Result**: ${d['passedCount'] ?? 0}/${d['applicableCount'] ?? 0} applicable checks passed.`);
  lines.push('');

  if (failed.length === 0) return lines.join('\n');

  lines.push('**Failed checks**:');
  for (const f of failed) {
    const check = String(f['check'] ?? '?');
    const detail = String(f['detail'] ?? '');
    lines.push(`- **${check}** — ${detail || '(missing)'}`);
  }
  return lines.join('\n');
}

function formatJudgeRationales(result: ScorerResult, label: string, showMissingFeatures: boolean): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;
  if (d['error']) return `_Judge call failed: ${String(d['error']).slice(0, 200)}_`;

  const mean = d['meanRaw'] as number | null;
  const lines: string[] = [];
  lines.push(`**What this measures**: vision-language judge scoring the page on multiple criteria (1–5 each), normalized to 0–1.`);
  lines.push('');
  lines.push(`**Result**: ${mean ?? '?'} / 5 mean across ${(d['criteria'] as unknown[])?.length ?? 0} criteria, judged by \`${String(d['model'] ?? '?')}\`.`);
  lines.push('');

  const criteria = (d['criteria'] as Array<Record<string, unknown>>) ?? [];
  // Only show criteria that scored ≤3 — those are the actionable findings.
  // 4-5 are passes; surfacing them adds noise without helping the AI fix things.
  const actionable = criteria.filter((c) => Number(c['score'] ?? 5) <= 3).sort((a, b) => Number(a['score']) - Number(b['score']));

  if (actionable.length > 0) {
    lines.push('**Criteria scoring 3 or below (actionable)**:');
    for (const c of actionable) {
      lines.push(`- **${String(c['id'])}** (${String(c['score'])}/5): ${String(c['rationale'] ?? '')}`);
    }
    lines.push('');
  }

  if (showMissingFeatures) {
    const missing = (d['missingFeatures'] as string[] | undefined) ?? [];
    if (missing.length > 0) {
      lines.push('**Features named in the prompt but absent from the page**:');
      for (const m of missing) lines.push(`- ${m}`);
      lines.push('');
    }
  }

  const overall = d['overallNotes'] as string | null;
  if (overall) {
    lines.push(`**Overall notes**: ${overall}`);
  }
  return lines.join('\n');
}

function formatV2(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  const checks = (d['checks'] as Array<Record<string, unknown>>) ?? [];
  const failed = checks.filter((c) => c['passed'] === false);

  const lines: string[] = [];
  lines.push(`**What this measures**: 8 deterministic in-browser design-heuristic checks — 4 layout (whitespace, contrast, font size, line length) and 4 CSS-convention proxies (box-sizing, prefers-reduced-motion, custom properties, focus-visible).`);
  lines.push('');
  lines.push(`**Result**: ${d['scorableChecks'] ?? 0} of ${d['totalChecks'] ?? 0} checks scorable; ${checks.filter((c) => c['passed'] === true).length} passed.`);
  lines.push('');

  if (failed.length === 0) return lines.join('\n');

  lines.push('**Failed checks**:');
  for (const f of failed) {
    lines.push(`- **${String(f['name'])}** — ${String(f['detail'] ?? '')}`);
  }
  return lines.join('\n');
}

function formatV4(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  const checks = (d['checks'] as Array<Record<string, unknown>>) ?? [];
  const failed = checks.filter((c) => c['pass'] === false);

  const lines: string[] = [];
  lines.push(`**What this measures**: viewport tests at 360×800 (mobile), 768×1024 (tablet), 1440×900 (desktop). Checks horizontal overflow at each breakpoint plus mobile touch-target sizes (≥44px).`);
  lines.push('');
  lines.push(`**Result**: ${d['passingChecks'] ?? 0} of ${d['totalChecks'] ?? 0} checks passed.`);
  lines.push('');

  if (failed.length === 0) return lines.join('\n');

  lines.push('**Failed checks**:');
  for (const f of failed) {
    lines.push(`- **${String(f['name'])}** — ${String(f['detail'] ?? '')}`);
  }
  return lines.join('\n');
}

async function formatS1(result: ScorerResult, sourceDir: string | null): Promise<string> {
  const d = result.details as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`**What this measures**: two security sub-checks. (1) Source secret scan unioning regex + Semgrep + trufflehog findings. (2) Deployed HTTP security headers (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy).`);
  lines.push('');

  const secrets = d['secrets'] as Record<string, unknown> | undefined;
  const headers = d['headers'] as Record<string, unknown> | undefined;

  if (secrets && !secrets['note']) {
    const findings = (secrets['findings'] as Array<Record<string, unknown>>) ?? [];
    lines.push(`**Secrets**: ${secrets['findingsCount'] ?? 0} findings across ${secrets['filesScanned'] ?? 0} files scanned.`);
    if (findings.length > 0) {
      lines.push('');
      for (const f of findings) {
        const file = String(f['file'] ?? '?');
        const lineNum = Number(f['lineNumber'] ?? 0);
        lines.push(`- **\`${String(f['ruleId'] ?? '?')}\`** at \`${file}:${lineNum}\` — ${String(f['label'] ?? '')} (snippet: \`${String(f['snippet'] ?? '?')}\`)`);
        if (sourceDir) {
          const ctx = await readSourceContext(sourceDir, file, lineNum);
          if (ctx) {
            lines.push('');
            lines.push('  ```');
            for (const l of ctx) lines.push(`  ${l}`);
            lines.push('  ```');
          }
        }
      }
      lines.push('');
      lines.push('**Fix**: move every flagged secret into a server-side environment variable. Never reference a service-role key, secret, or signing key from a path that ships to the browser.');
    }
    lines.push('');
  }

  if (headers && !headers['note']) {
    const outcomes = (headers['outcomes'] as Array<Record<string, unknown>>) ?? [];
    const missing = outcomes.filter((o) => !o['present']);
    lines.push(`**HTTP security headers**: ${headers['passedCount'] ?? 0}/${headers['totalCount'] ?? 0} present.`);
    if (missing.length > 0) {
      lines.push('');
      lines.push('Missing or misconfigured headers:');
      for (const m of missing) {
        lines.push(`- **${String(m['label'])}** — ${m['value'] ? `current value: \`${String(m['value']).slice(0, 80)}\`` : 'not set'}`);
      }
      lines.push('');
      lines.push('**Fix**: configure these headers at the deployment platform layer (Vercel `vercel.json` headers block, Netlify `_headers`, Express `helmet()` middleware, etc.). For static SPAs, set them on the CDN.');
    }
  }
  return lines.join('\n');
}

async function formatS2(result: ScorerResult, sourceDir: string | null): Promise<string> {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const findings = (d['findings'] as Array<Record<string, unknown>>) ?? [];
  const lines: string[] = [];
  lines.push(`**What this measures**: 16 deterministic auth and secure-by-default anti-pattern checks — Supabase service-role keys in client code, RLS disabled, JWT decode without signature verify, Firebase test mode, hardcoded admin emails/passwords, password reset without token, Stripe/OpenAI keys in client bundle, unsanitized HTML (XSS) sinks, insecure transport, and sensitive data written to logs.`);
  lines.push('');
  const sev = d['bySeverity'] as Record<string, number> | undefined;
  if (sev) {
    const parts = [];
    if (sev['critical']) parts.push(`${sev['critical']} critical`);
    if (sev['high']) parts.push(`${sev['high']} high`);
    if (sev['medium']) parts.push(`${sev['medium']} medium`);
    lines.push(`**Result**: ${d['findingsCount']} findings — ${parts.join(', ')}.`);
  }
  lines.push('');

  if (findings.length === 0) return lines.join('\n');

  lines.push('**Findings** (sorted by severity, ordered by appearance in source):');
  lines.push('');
  for (const f of findings) {
    const severity = String(f['severity'] ?? '?');
    const file = String(f['file'] ?? '?');
    const lineNum = Number(f['lineNumber'] ?? 0);
    lines.push(`- **\`${String(f['patternId'] ?? '?')}\`** (${severity}) at \`${file}:${lineNum}\``);
    lines.push(`  ${String(f['label'] ?? '')}`);
    if (sourceDir) {
      const ctx = await readSourceContext(sourceDir, file, lineNum);
      if (ctx) {
        lines.push('');
        lines.push('  ```');
        for (const l of ctx) lines.push(`  ${l}`);
        lines.push('  ```');
        lines.push('');
      }
    }
    if (f['snippet']) lines.push(`  Matched line: \`${String(f['snippet'])}\``);
  }
  lines.push('');
  lines.push('**Critical/high findings must be fixed before shipping**: service-role keys belong only in server-side code; JWT tokens must be verified server-side, not just decoded client-side; Firebase rules must enforce auth before production; HTML written via dangerouslySetInnerHTML/innerHTML/v-html must be sanitized (DOMPurify) before render.');
  return lines.join('\n');
}

function formatS3(result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  if (d['note']) return `_${String(d['note'])}_`;

  const lines: string[] = [];
  lines.push(`**What this measures**: \`npm audit\` weighted by CVE severity. critical=10pts, high=3pts, moderate=1pt, low=0.1pt; score decays to 0 at 20+ penalty points.`);
  lines.push('');
  const c = Number(d['critical'] ?? 0);
  const h = Number(d['high'] ?? 0);
  const m = Number(d['moderate'] ?? 0);
  const l = Number(d['low'] ?? 0);
  lines.push(`**Result**: ${c} critical, ${h} high, ${m} moderate, ${l} low.`);
  lines.push('');

  const top = (d['topVulnerabilities'] as Array<Record<string, unknown>>) ?? [];
  if (top.length > 0) {
    lines.push('**Top vulnerabilities**:');
    for (const v of top) {
      const fix = v['fixAvailable'] === true ? ' (fix available)' : '';
      lines.push(`- **${String(v['name'])}** (${String(v['severity'])})${fix} — ${(v['via'] as string[] ?? []).slice(0, 3).join(', ')}`);
    }
    lines.push('');
    lines.push('**Fix**: run `npm audit fix` for fixable vulns. For unfixable transitive deps, override the version in `package.json`\'s `overrides` block, or upgrade the parent dependency.');
  }
  return lines.join('\n');
}

function formatGeneric(id: string, result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`Score: ${result.score == null ? 'N/A' : `${(result.score * 100).toFixed(1)} / 100`}.`);
  if (d['note']) {
    lines.push('');
    lines.push(`_${String(d['note'])}_`);
  }
  lines.push('');
  lines.push(`See \`scores.json\` → \`${id}.details\` for the full result. The scorer's mechanics and rationale are documented in \`METRICS.md\`.`);
  return lines.join('\n');
}

// ── Source-context helper ────────────────────────────────────────────────────

const SOURCE_CTX_LINES_BEFORE = 3;
const SOURCE_CTX_LINES_AFTER = 3;

// Reads `lineNumber ± 3` lines from a source file under sourceDir. Returns
// formatted lines (with line numbers) or null if the file isn't readable.
// The matched line is marked with `>` so the AI can spot it without parsing.
async function readSourceContext(sourceDir: string, file: string, lineNumber: number): Promise<string[] | null> {
  if (!file || lineNumber <= 0) return null;
  try {
    const text = await readFile(join(sourceDir, file), 'utf8');
    const lines = text.split('\n');
    const start = Math.max(0, lineNumber - 1 - SOURCE_CTX_LINES_BEFORE);
    const end = Math.min(lines.length, lineNumber + SOURCE_CTX_LINES_AFTER);
    const padWidth = String(end).length;
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const ln = i + 1;
      const marker = ln === lineNumber ? '>' : ' ';
      out.push(`${marker} ${String(ln).padStart(padWidth)} | ${lines[i] ?? ''}`);
    }
    return out;
  } catch {
    return null;
  }
}

// ── Rollup helpers ───────────────────────────────────────────────────────────

interface CollectedSubmission {
  artifactDir: string;
  submission: Submission;
  prompt: Prompt;
  scores: Record<string, ScorerResult>;
  sourceDir: string | null;
}

async function collectSubmissions(artifactsRoot: string, toolFilter?: string): Promise<CollectedSubmission[]> {
  const out: CollectedSubmission[] = [];
  const tools = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
  for (const t of tools) {
    if (!t.isDirectory()) continue;
    if (toolFilter && t.name !== toolFilter) continue;
    const promptDirs = await readdir(join(artifactsRoot, t.name), { withFileTypes: true }).catch(() => []);
    for (const p of promptDirs) {
      if (!p.isDirectory()) continue;
      const runDirs = await readdir(join(artifactsRoot, t.name, p.name), { withFileTypes: true }).catch(() => []);
      for (const r of runDirs) {
        if (!r.isDirectory()) continue;
        const dir = join(artifactsRoot, t.name, p.name, r.name);
        if (!existsSync(join(dir, 'scores.json'))) continue;
        try {
          const submission = JSON.parse(await readFile(join(dir, 'submission.json'), 'utf8')) as Submission;
          const prompt = JSON.parse(await readFile(join(dir, 'prompt.json'), 'utf8')) as Prompt;
          const scores = JSON.parse(await readFile(join(dir, 'scores.json'), 'utf8')) as Record<string, ScorerResult>;
          const sourceDir = existsSync(join(dir, 'source')) ? join(dir, 'source') : null;
          out.push({ artifactDir: dir, submission, prompt, scores, sourceDir });
        } catch {
          // Skip unreadable artifacts silently — they shouldn't block the rollup.
        }
      }
    }
  }
  return out.sort((a, b) =>
    a.submission.tool.localeCompare(b.submission.tool) ||
    a.submission.promptId.localeCompare(b.submission.promptId) ||
    a.submission.runIdx - b.submission.runIdx,
  );
}

function renderRollupHeader(submissionCount: number, tools: string[]): string {
  const uniqueTools = [...new Set(tools)].sort();
  const lines: string[] = [];
  lines.push('# Fix report — multi-submission rollup');
  lines.push('');
  lines.push("This is an actionable audit of failing scorers across all submissions in the artifacts directory. Each submission section names specific failures with concrete data (failed acceptance-criterion ids, axe rule ids, missing verbatim strings, judge rationales, source line numbers, etc). Read the per-tool summary first to spot consistent failure patterns, then drill into individual submissions.");
  lines.push('');
  lines.push(`- **Submissions**: ${submissionCount}`);
  lines.push(`- **Tools**: ${uniqueTools.join(', ')}`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  return lines.join('\n');
}

function renderToolSummary(submissions: CollectedSubmission[]): string {
  // Aggregate failure counts per scorer across this tool's submissions.
  const scorerFailureCounts = new Map<string, number>();
  let withFailures = 0;
  for (const s of submissions) {
    const fails = orderedFailures(s.scores);
    if (fails.length > 0) withFailures++;
    for (const f of fails) {
      scorerFailureCounts.set(f.id, (scorerFailureCounts.get(f.id) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  lines.push(`Across ${submissions.length} submission${submissions.length === 1 ? '' : 's'}, ${withFailures} ha${withFailures === 1 ? 's' : 've'} at least one failing scorer.`);
  lines.push('');

  if (scorerFailureCounts.size === 0) {
    lines.push("_No failures across this tool's submissions._");
    return lines.join('\n');
  }

  lines.push("**Most-frequent failures across this tool's submissions** (use this to prioritize systemic fixes):");
  lines.push('');
  const sorted = [...scorerFailureCounts.entries()].sort((a, b) => b[1] - a[1]);
  lines.push('| Scorer | Failed in | Frequency |');
  lines.push('|---|---|---|');
  for (const [id, count] of sorted) {
    const pct = ((count / submissions.length) * 100).toFixed(0);
    lines.push(`| \`${id}\` | ${count} / ${submissions.length} | ${pct}% |`);
  }
  return lines.join('\n');
}

// ── Small helpers ────────────────────────────────────────────────────────────

function dimensionWeightFor(dim: Dimension): number {
  switch (dim) {
    case 'functional':   return 47;
    case 'code_quality': return 18;
    case 'visual':       return 24;
    case 'security':     return 11;
  }
}

function dimensionLabel(dim: Dimension): string {
  switch (dim) {
    case 'functional':   return 'Functional';
    case 'code_quality': return 'Code Quality';
    case 'visual':       return 'Visual';
    case 'security':     return 'Security';
  }
}

function formatScoreHeader(result: ScorerResult): string {
  if (result.score == null) {
    if (result.passed === false) return 'failed';
    return 'N/A';
  }
  return `${(result.score * 100).toFixed(1)} / 100`;
}

function formatPct(val: unknown): string {
  if (typeof val !== 'number') return '?';
  return `${Math.round(val * 100)}`;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}

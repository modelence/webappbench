import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Submission } from '../core/submission.ts';
import { computeComposite } from '../scorers/composite.ts';
import type { ScorerResult } from '../scorers/types.ts';

interface RunSummary {
  tool: string;
  promptId: string;
  runIdx: number;
  toolVersion: string;
  submittedAt: string;
  artifactUrl: string;
  scores: Record<string, ScorerResult>;
  hasSource: boolean;
}

export async function generateReport(artifactsRoot: string, outFile: string): Promise<RunSummary[]> {
  const runs = await collectRuns(artifactsRoot);
  const html = renderHtml(runs);
  await writeFile(outFile, html, 'utf8');
  return runs;
}

async function collectRuns(artifactsRoot: string): Promise<RunSummary[]> {
  const runs: RunSummary[] = [];
  const tools = await readdirOrEmpty(artifactsRoot);
  for (const tool of tools) {
    const promptIds = await readdirOrEmpty(join(artifactsRoot, tool));
    for (const promptId of promptIds) {
      const runIdxs = await readdirOrEmpty(join(artifactsRoot, tool, promptId));
      for (const runIdx of runIdxs) {
        const runDir = join(artifactsRoot, tool, promptId, runIdx);
        const summary = await loadRun(runDir);
        if (summary) runs.push(summary);
      }
    }
  }
  return runs.sort((a, b) => (a.tool + a.promptId).localeCompare(b.tool + b.promptId));
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadRun(runDir: string): Promise<RunSummary | null> {
  try {
    const submission = JSON.parse(
      await readFile(join(runDir, 'submission.json'), 'utf8'),
    ) as Submission;
    const scoresText = await readFile(join(runDir, 'scores.json'), 'utf8').catch(() => null);
    if (!scoresText) return null;
    const scores = JSON.parse(scoresText) as Record<string, ScorerResult>;
    const hasSource = !!(scores['f6'] || scores['c1'] || scores['c5']);
    return {
      tool: submission.tool,
      promptId: submission.promptId,
      runIdx: submission.runIdx,
      toolVersion: submission.toolVersion,
      submittedAt: submission.submittedAt,
      artifactUrl: submission.artifactUrl,
      scores,
      hasSource,
    };
  } catch {
    return null;
  }
}

const BASE_DIMS = ['f1', 'f2', 'f5', 'c3', 'v1', 'v2', 'v4', 'c4', 'c9'] as const;
const SOURCE_DIMS = ['f6', 'c1', 'c2', 'c5', 'c6', 'c7', 'c8'] as const;
const ALL_DIMS = [...BASE_DIMS, ...SOURCE_DIMS, 'cost'] as const;
type Dim = (typeof ALL_DIMS)[number];

function scoreCell(score: ScorerResult | undefined, format: 'score' | 'pct' = 'score'): string {
  if (!score) return `<td class="na">—</td>`;
  if (score.score === null) return `<td class="na">N/A</td>`;
  const cls = score.passed === true ? 'pass' : score.passed === false ? 'fail' : 'na';
  const val = format === 'pct' ? (score.score * 100).toFixed(1) : score.score.toFixed(3);
  return `<td class="${cls}">${val}</td>`;
}

function compositeCell(scores: Record<string, ScorerResult>): string {
  const c = computeComposite(scores);
  if (!c) return `<td class="na">—</td>`;
  const pct = (c.score * 100).toFixed(1);
  const cls = c.score >= 0.8 ? 'composite-high' : c.score >= 0.6 ? 'composite-mid' : 'composite-low';
  return `<td class="composite ${cls}"><strong>${pct}</strong><span class="of"> / ${c.outOf}</span></td>`;
}

interface ToolAgg {
  runs: number;
  composite: number | null;
  dims: Record<Dim, number | null>;
}

function summarizeByTool(runs: RunSummary[]): Map<string, ToolAgg> {
  const map = new Map<string, ToolAgg>();
  for (const r of runs) {
    const agg = map.get(r.tool) ?? { runs: 0, composite: null, dims: Object.fromEntries(ALL_DIMS.map((d) => [d, null])) as Record<Dim, number | null> };
    agg.runs += 1;
    for (const d of ALL_DIMS) {
      const s = r.scores[d]?.score;
      if (typeof s === 'number') {
        agg.dims[d] = agg.dims[d] === null ? s : agg.dims[d]! + s;
      }
    }
    const c = computeComposite(r.scores);
    if (c) agg.composite = agg.composite === null ? c.score : agg.composite + c.score;
    map.set(r.tool, agg);
  }
  for (const agg of map.values()) {
    for (const d of ALL_DIMS) {
      if (agg.dims[d] !== null) agg.dims[d] = agg.dims[d]! / agg.runs;
    }
    if (agg.composite !== null) agg.composite /= agg.runs;
  }
  return map;
}

function renderHtml(runs: RunSummary[]): string {
  const anySource = runs.some((r) => r.hasSource);
  const dimHeaders = [
    '<th>F1 render</th>', '<th>F2 accept</th>', '<th>F5 errors</th>', '<th>C3 a11y</th>', '<th>V1 visual</th>', '<th>V2 design</th>', '<th>V4 responsive</th>', '<th>C4 perf</th>', '<th>C9 SEO</th>',
    ...(anySource ? ['<th>F6 verbatim</th>', '<th>C1 lint</th>', '<th>C2 types</th>', '<th>C5 bundle</th>', '<th>C6 complexity</th>', '<th>C7 audit</th>', '<th>C8 secrets</th>'] : []),
    '<th>Cost</th>',
  ];

  const perRunRows = runs.map((r) => {
    const c = compositeCell(r.scores);
    const dimCells = [
      ...BASE_DIMS.map((d) => scoreCell(r.scores[d])),
      ...(anySource ? SOURCE_DIMS.map((d) => scoreCell(r.scores[d])) : []),
      scoreCell(r.scores['cost']),
    ].join('');
    return `<tr>
      ${c}
      <td>${escape(r.tool)}</td>
      <td>${escape(r.promptId)}</td>
      <td><a href="${escape(r.artifactUrl)}" target="_blank" rel="noopener">↗</a></td>
      <td class="ver">${escape(r.toolVersion)}</td>
      ${dimCells}
    </tr>`;
  }).join('\n');

  const summary = summarizeByTool(runs);
  const summaryRows = [...summary.entries()]
    .sort((a, b) => (b[1].composite ?? 0) - (a[1].composite ?? 0))
    .map(([tool, agg]) => {
      const compositePct = agg.composite !== null ? `<strong>${(agg.composite * 100).toFixed(1)}</strong>` : '—';
      const compositeCls = agg.composite !== null
        ? agg.composite >= 0.8 ? 'composite composite-high' : agg.composite >= 0.6 ? 'composite composite-mid' : 'composite composite-low'
        : 'na';
      const dimCells = [
        ...BASE_DIMS.map((d) => agg.dims[d] !== null ? `<td>${agg.dims[d]!.toFixed(3)}</td>` : `<td class="na">—</td>`),
        ...(anySource ? SOURCE_DIMS.map((d) => agg.dims[d] !== null ? `<td>${agg.dims[d]!.toFixed(3)}</td>` : `<td class="na">—</td>`) : []),
        agg.dims['cost'] !== null ? `<td>${agg.dims['cost']!.toFixed(3)}</td>` : `<td class="na">—</td>`,
      ].join('');
      return `<tr>
        <td class="${compositeCls}">${compositePct}</td>
        <td>${escape(tool)}</td>
        <td>${agg.runs}</td>
        ${dimCells}
      </tr>`;
    }).join('\n');

  const summaryColCount = 3 + BASE_DIMS.length + (anySource ? SOURCE_DIMS.length : 0) + 1;
  const perRunColCount = 4 + BASE_DIMS.length + (anySource ? SOURCE_DIMS.length : 0) + 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AI Sitebuilder Benchmark — Leaderboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #1a1a1a; max-width: 1400px; }
  h1 { margin-top: 0; }
  h2 { margin-top: 2.5rem; }
  table { border-collapse: collapse; margin-bottom: 2rem; width: 100%; }
  th, td { padding: .45rem .65rem; text-align: left; border-bottom: 1px solid #eee; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th { font-weight: 600; background: #f7f7f5; }
  td.pass { background: rgba(0,128,0,.07); }
  td.fail { background: rgba(200,0,0,.07); }
  td.na { color: #aaa; }
  td.ver { color: #888; font-size: .85em; }
  td.composite { font-size: 1.1em; }
  td.composite-high { background: rgba(0,160,0,.12); }
  td.composite-mid  { background: rgba(255,180,0,.14); }
  td.composite-low  { background: rgba(200,0,0,.10); }
  .of { font-size: .75em; color: #888; }
  a { color: #2f6f4f; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .caveat { background: #fff9db; padding: .75rem 1rem; border-left: 3px solid #ffc107; font-size: .9rem; margin-bottom: 1.5rem; }
</style>
</head>
<body>
<h1>AI Sitebuilder Benchmark</h1>
<p>Generated ${new Date().toISOString()} · ${escape(String(runs.length))} scored run(s).</p>
<p class="caveat">v0.1 · deterministic scorers · Score = mean of non-null quality scorers (cost excluded) · higher is better · /100</p>

<h2>Leaderboard</h2>
<table>
  <thead><tr>
    <th>Score</th><th>Tool</th><th>Runs</th>
    ${dimHeaders.join('')}
  </tr></thead>
  <tbody>${summaryRows || `<tr><td colspan="${summaryColCount}">No runs yet.</td></tr>`}</tbody>
</table>

<h2>Per run</h2>
<table>
  <thead><tr>
    <th>Score</th><th>Tool</th><th>Prompt</th><th>URL</th>
    ${dimHeaders.join('')}
  </tr></thead>
  <tbody>${perRunRows || `<tr><td colspan="${perRunColCount}">No runs yet.</td></tr>`}</tbody>
</table>
</body>
</html>
`;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

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

const METRIC_META: Record<string, { label: string; group: string; desc: string }> = {
  f1: { label: 'F1 render',      group: 'Functional',    desc: 'Page loads with HTTP 2xx and non-empty body within 30 s. The baseline — a failing site scores 0 on all downstream metrics.' },
  f2: { label: 'F2 acceptance',  group: 'Functional',    desc: 'Per-prompt checklist of must-have and should-have requirements, executed as Playwright assertions (roles, labels, counts). Weighted: must-have failures penalise more than should-have.' },
  f5: { label: 'F5 errors',      group: 'Functional',    desc: 'Console errors, uncaught JS exceptions, and 4xx/5xx network responses collected during the full scoring session. 0 errors = 1.0; decays linearly to 0 at 10+ errors.' },
  f6: { label: 'F6 verbatim',    group: 'Functional',    desc: 'Exact string constraints specified in the prompt (e.g. "Get started", "Nimbus Notes") must appear verbatim in the rendered page. Source-only scorer.' },
  c1: { label: 'C1 lint',        group: 'Code Quality',  desc: 'ESLint with typescript-eslint recommended rules run over the source ZIP. Score decays linearly from 0 errors/1k LOC (1.0) to 20+ errors/1k LOC (0). Source-only.' },
  c2: { label: 'C2 types',       group: 'Code Quality',  desc: 'tsc --noEmit --strict run on the source. 0 type errors = 1.0; decays at 20 errors/1k LOC. "Cannot find module" errors are filtered out. Source-only.' },
  c3: { label: 'C3 a11y',        group: 'Code Quality',  desc: 'axe-core WCAG 2.1/2.2 AA audit. Score = 1 − (violations / (violations + passes)); weighted by violation impact (critical > serious > moderate > minor).' },
  c4: { label: 'C4 perf',        group: 'Code Quality',  desc: 'Lighthouse performance score (mobile throttled, median of 3 runs). Composite of FCP, LCP, TBT, CLS, Speed Index.' },
  c5: { label: 'C5 bundle',      group: 'Code Quality',  desc: 'Uncompressed JS + CSS source size. Full marks up to 150 KB; linear penalty up to 1 MB; 0 above 1 MB. Source-only. Does not account for tree-shaking.' },
  c6: { label: 'C6 complexity',  group: 'Code Quality',  desc: 'Cognitive complexity via eslint-plugin-sonarjs. Functions exceeding threshold 15 are flagged. Score decays from 0 violations/1k LOC (1.0) to 10+/1k (0). Source-only.' },
  c7: { label: 'C7 audit',       group: 'Code Quality',  desc: 'npm audit CVE count from the source lockfile. Weighted: critical×10 + high×3 + moderate×1 + low×0.1. Score decays to 0 at 20 weighted penalty points. Source-only.' },
  c8: { label: 'C8 secrets',     group: 'Code Quality',  desc: 'Regex scan for leaked credentials: OpenAI/Anthropic API keys, AWS access keys, GitHub PATs, PEM headers, hardcoded passwords. Any match = 0. Source-only.' },
  c9: { label: 'C9 SEO',         group: 'Code Quality',  desc: 'Deterministic DOM checks: title length (10–70 chars), meta description (50–300 chars), canonical URL, OG tags (title/description/type), html[lang], heading hierarchy.' },
  v1: { label: 'V1 visual',      group: 'Visual',        desc: 'MLLM visual judge (Gemini 2.5 Pro via OpenRouter). 8 criteria scored 1–5: visual hierarchy, typography, color harmony, whitespace, brand fit, CTA prominence, mobile layout, overall polish. Normalised to 0–1.' },
  v2: { label: 'V2 design',      group: 'Visual',        desc: 'Deterministic in-browser design heuristics: whitespace ratio (≥25% background), WCAG AA contrast pass rate (≥80% of text nodes), readable font sizes (≥80% ≥14px), line length (≥70% blocks ≤85ch).' },
  v4: { label: 'V4 responsive',  group: 'Visual',        desc: 'Playwright viewport tests at 360×800 (mobile), 768×1024 (tablet), 1440×900 (desktop). Checks: no horizontal overflow at each breakpoint + mobile touch targets ≥44px. 4 checks total.' },
  cost: { label: 'Cost',         group: 'Cost',          desc: 'Informational only — not included in composite score. Self-reported by user at submission: TTFR (time to first render), TTWB (time to working build), USD estimate.' },
};

const GROUP_COLORS: Record<string, string> = {
  Functional:   '#3b82f6',
  'Code Quality': '#8b5cf6',
  Visual:       '#ec4899',
  Cost:         '#6b7280',
};

function renderHtml(runs: RunSummary[]): string {
  const anySource = runs.some((r) => r.hasSource);
  const visibleDims: Dim[] = [
    ...BASE_DIMS,
    ...(anySource ? SOURCE_DIMS : [] as unknown as typeof SOURCE_DIMS),
    'cost' as Dim,
  ];

  const thWithTooltip = (dim: Dim) => {
    const m = METRIC_META[dim];
    if (!m) return `<th>${dim}</th>`;
    const color = GROUP_COLORS[m.group] ?? '#6b7280';
    return `<th class="metric-th" data-tip="${escape(m.desc)}"><span class="metric-badge" style="background:${color}22;color:${color}">${escape(m.label)}</span></th>`;
  };

  const dimHeaders = visibleDims.map(thWithTooltip).join('');
  const summary = summarizeByTool(runs);
  const rankedSummaryEntries = [...summary.entries()]
    .sort((a, b) =>
      (b[1].composite ?? -1) - (a[1].composite ?? -1) ||
      a[0].localeCompare(b[0]),
    );
  const toolRank = new Map(rankedSummaryEntries.map(([tool], index) => [tool, index]));

  const perRunRows = [...runs].sort((a, b) =>
    (toolRank.get(a.tool) ?? Number.MAX_SAFE_INTEGER) - (toolRank.get(b.tool) ?? Number.MAX_SAFE_INTEGER) ||
    a.promptId.localeCompare(b.promptId) ||
    a.runIdx - b.runIdx,
  ).map((r) => {
    const c = computeComposite(r.scores);
    const pct = c ? (c.score * 100).toFixed(1) : null;
    const bar = c ? scoreBar(c.score) : '';
    const scoreCls = c ? (c.score >= 0.8 ? 'hi' : c.score >= 0.6 ? 'mid' : 'lo') : 'na';
    const scoreCell = pct
      ? `<td class="score-cell"><div class="score-wrap ${scoreCls}">${bar}<span class="score-num">${pct}</span></div></td>`
      : `<td class="na">—</td>`;
    const dimCells = visibleDims.map((d) => renderScoreCell(r.scores[d]?.score)).join('');
    const toolSlug = escape(r.tool);
    return `<tr>
      ${scoreCell}
      <td class="tool-cell"><span class="tool-pill">${toolSlug}</span></td>
      <td class="prompt-cell">${escape(r.promptId)}</td>
      <td class="link-cell"><a href="${escape(r.artifactUrl)}" target="_blank" rel="noopener" title="Open live site">↗</a></td>
      <td class="ver-cell">${escape(r.toolVersion)}</td>
      ${dimCells}
    </tr>`;
  }).join('\n');

  const rank = { i: 0 };
  const summaryRows = rankedSummaryEntries.map(([tool, agg]) => {
      rank.i++;
      const medal = `<span class="rank-circle">${rank.i}</span>`;
      const pct = agg.composite !== null ? (agg.composite * 100).toFixed(1) : null;
      const bar = agg.composite !== null ? scoreBar(agg.composite) : '';
      const cls = agg.composite !== null ? (agg.composite >= 0.8 ? 'hi' : agg.composite >= 0.6 ? 'mid' : 'lo') : 'na';
      const scoreCell = pct
        ? `<td class="score-cell"><div class="score-wrap ${cls}">${bar}<span class="score-num">${pct}</span></div></td>`
        : `<td class="na">—</td>`;
      const dimCells = visibleDims.map((d) => renderScoreCell(agg.dims[d])).join('');
      return `<tr>
        <td class="rank-cell">${medal}</td>
        ${scoreCell}
        <td class="tool-cell"><span class="tool-pill">${escape(tool)}</span></td>
        <td class="runs-cell">${agg.runs} run${agg.runs === 1 ? '' : 's'}</td>
        ${dimCells}
      </tr>`;
    }).join('\n');

  const leaderColCount = 4 + visibleDims.length;
  const perRunColCount  = 5 + visibleDims.length;
  const generatedAt = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI sitebuilder benchmark</title>
<script src="https://unpkg.com/lucide@latest"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Dark theme (default) ── */
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #22263a;
    --border: #2e3347;
    --text: #e2e8f0;
    --text-muted: #64748b;
    --text-dim: #94a3b8;
    --accent: #6366f1;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --header-bg-start: #1e1b4b;
    --header-bg-end: #0f1117;
    --header-title: linear-gradient(90deg, #a5b4fc, #818cf8);
    --badge-bg: #312e81; --badge-color: #a5b4fc; --badge-border: #4338ca;
    --tooltip-bg: #1e293b;
    --score-bar-track: rgba(255,255,255,.08);
  }

  /* ── Light theme ── */
  :root.light {
    --bg: #f8f9fc;
    --surface: #ffffff;
    --surface2: #f1f3f9;
    --border: #e2e6f0;
    --text: #0f172a;
    --text-muted: #94a3b8;
    --text-dim: #475569;
    --accent: #4f46e5;
    --green: #16a34a;
    --yellow: #ca8a04;
    --red: #dc2626;
    --header-bg-start: #eef2ff;
    --header-bg-end: #f8f9fc;
    --header-title: linear-gradient(90deg, #4338ca, #6366f1);
    --badge-bg: #e0e7ff; --badge-color: #4338ca; --badge-border: #c7d2fe;
    --tooltip-bg: #1e293b;
    --score-bar-track: rgba(0,0,0,.08);
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-size: 14px;
    line-height: 1.5;
    transition: background .2s, color .2s;
  }

  /* ── Theme toggle button ── */
  .theme-toggle {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 99px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: .8rem;
    font-weight: 600;
    padding: .3rem .75rem;
    display: flex; align-items: center; gap: .4rem;
    transition: background .15s, border-color .15s;
    white-space: nowrap;
  }
  .theme-toggle:hover { background: var(--border); }
  .theme-toggle i { width: 14px; height: 14px; stroke-width: 2; }

  /* ── Header ── */
  .site-header {
    background: linear-gradient(135deg, var(--header-bg-start) 0%, var(--header-bg-end) 60%);
    border-bottom: 1px solid var(--border);
    padding: 2.5rem 2rem 2rem;
    transition: background .2s;
  }
  .header-inner { max-width: 1600px; margin: 0 auto; }
  .header-inner { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .header-text { flex: 1; }
  .header-title {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    background: var(--header-title);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: .4rem;
  }
  .header-meta { color: var(--text-muted); font-size: .82rem; display: flex; gap: 1.5rem; flex-wrap: wrap; margin-top: .5rem; }
  .header-meta span { display: flex; align-items: center; gap: .35rem; }
  .badge {
    display: inline-flex; align-items: center; gap: .3rem;
    background: var(--badge-bg); color: var(--badge-color);
    border: 1px solid var(--badge-border);
    border-radius: 99px; padding: .15rem .65rem; font-size: .75rem; font-weight: 600;
  }

  /* ── Layout ── */
  .main { max-width: 1600px; margin: 0 auto; padding: 2rem; }
  section { margin-bottom: 3rem; }
  .section-title {
    font-size: 1rem; font-weight: 700; letter-spacing: 0;
    color: var(--text-dim); margin-bottom: 1rem; display: flex; align-items: center; gap: .5rem;
  }
  .section-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }

  /* ── Tables ── */
  .table-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); }
  table { border-collapse: collapse; width: 100%; }
  thead { position: sticky; top: 0; z-index: 10; }
  th {
    background: var(--surface2); color: var(--text-dim);
    font-size: .72rem; font-weight: 600; text-transform: none; letter-spacing: 0;
    padding: .6rem .75rem; border-bottom: 1px solid var(--border);
    white-space: nowrap; user-select: none;
  }
  td {
    padding: .55rem .75rem; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; white-space: nowrap;
    background: var(--surface);
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface2); }

  /* ── Metric header tooltips ── */
  .metric-th { cursor: help; position: relative; }
  .metric-th:hover::after {
    content: attr(data-tip);
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
    background: var(--tooltip-bg); border: 1px solid var(--border);
    color: var(--text-dim); font-size: .78rem; font-weight: 400;
    text-transform: none; letter-spacing: 0;
    padding: .6rem .85rem; border-radius: var(--radius-sm);
    width: 280px; white-space: normal; line-height: 1.4;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  .metric-badge {
    border-radius: 99px; padding: .1rem .5rem;
    font-size: .7rem; font-weight: 700; text-transform: none; letter-spacing: 0;
  }

  /* ── Score bar ── */
  .score-cell { min-width: 90px; }
  .score-wrap {
    display: flex; align-items: center; gap: .45rem;
    padding: .25rem .5rem; border-radius: var(--radius-sm);
  }
  .score-wrap.hi { background: rgba(34,197,94,.12); }
  .score-wrap.mid { background: rgba(234,179,8,.1); }
  .score-wrap.lo { background: rgba(239,68,68,.1); }
  .score-bar-track { width: 42px; height: 5px; background: var(--score-bar-track); border-radius: 99px; overflow: hidden; flex-shrink: 0; }
  .score-bar-fill { height: 100%; border-radius: 99px; }
  .hi .score-bar-fill { background: var(--green); }
  .mid .score-bar-fill { background: var(--yellow); }
  .lo .score-bar-fill { background: var(--red); }
  .score-num { font-size: .9rem; font-weight: 700; }
  .hi .score-num { color: var(--green); }
  .mid .score-num { color: var(--yellow); }
  .lo .score-num { color: var(--red); }

  /* ── Mini bar metric cells ── */
  .dim-avg { font-size: .8rem; color: var(--text-dim); }
  .dim-avg span { display: inline-block; min-width: 22px; }
  .mini-bar { display: inline-block; width: 28px; height: 3px; border-radius: 99px; margin-right: 4px; vertical-align: middle; }

  /* ── Per-run cells ── */
  td.na { color: var(--text-muted) !important; background: var(--surface) !important; }
  .rank-cell { text-align: center; width: 48px; }
  .rank-circle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--surface2); border: 1px solid var(--border);
    font-size: .72rem; font-weight: 700; color: var(--text-dim);
  }
  .tool-cell { }
  .tool-pill {
    display: inline-block;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 99px; padding: .1rem .55rem;
    font-size: .78rem; font-weight: 600; color: var(--text-dim);
  }
  .prompt-cell { font-size: .8rem; color: var(--text-dim); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
  .link-cell a { color: var(--accent); text-decoration: none; font-size: 1rem; }
  .link-cell a:hover { color: #a5b4fc; }
  .ver-cell { font-size: .75rem; color: var(--text-muted); }
  .runs-cell { font-size: .8rem; color: var(--text-muted); }

  /* ── Metric glossary ── */
  .glossary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: .75rem;
  }
  .glossary-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: .85rem 1rem;
  }
  .glossary-card-header { display: flex; align-items: center; gap: .5rem; margin-bottom: .35rem; }
  .glossary-id { font-size: .7rem; font-weight: 700; font-family: monospace; color: var(--text-muted); }
  .glossary-label { font-size: .85rem; font-weight: 700; color: var(--text); }
  .glossary-group {
    font-size: .65rem; font-weight: 700; text-transform: none; letter-spacing: 0;
    padding: .1rem .4rem; border-radius: 99px; margin-left: auto;
  }
  .glossary-desc { font-size: .8rem; color: var(--text-muted); line-height: 1.5; }
  .group-Functional   { background: rgba(59,130,246,.15); color: #93c5fd; }
  .group-CodeQuality  { background: rgba(139,92,246,.15); color: #c4b5fd; }
  .group-Visual       { background: rgba(236,72,153,.15); color: #f9a8d4; }
  .group-Cost         { background: rgba(107,114,128,.15); color: #d1d5db; }

  /* ── Footer ── */
  .site-footer { border-top: 1px solid var(--border); padding: 1.5rem 2rem; text-align: center; color: var(--text-muted); font-size: .78rem; }

  /* ── No data ── */
  .empty { text-align: center; padding: 3rem; color: var(--text-muted); font-size: .9rem; }
</style>
</head>
<body>

<header class="site-header">
  <div class="header-inner">
    <div class="header-text">
      <div class="header-title">AI sitebuilder benchmark</div>
      <div style="color:var(--text-dim);font-size:.88rem;margin-top:.25rem">
        Reproducible, open-source scoring for AI-generated websites
      </div>
      <div class="header-meta">
        <span><span class="badge">v0.1</span></span>
        <span>Generated ${escape(generatedAt)}</span>
        <span>${escape(String(runs.length))} scored run${runs.length === 1 ? '' : 's'}</span>
        <span>Score = mean of non-null quality scorers · higher is better · /100</span>
      </div>
    </div>
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle light/dark theme">
      <i data-lucide="sun" id="themeIcon"></i>
      <span id="themeLabel">Light</span>
    </button>
  </div>
</header>

<main class="main">

<section>
  <div class="section-title">Leaderboard</div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th style="width:48px"></th>
        <th>Score</th><th>Tool</th><th>Runs</th>
        ${dimHeaders}
      </tr></thead>
      <tbody>${summaryRows || `<tr><td colspan="${leaderColCount}" class="empty">No scored runs yet.</td></tr>`}</tbody>
    </table>
  </div>
</section>

<section>
  <div class="section-title">Per-run detail</div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Score</th><th>Tool</th><th>Prompt</th><th>URL</th><th>Version</th>
        ${dimHeaders}
      </tr></thead>
      <tbody>${perRunRows || `<tr><td colspan="${perRunColCount}" class="empty">No scored runs yet.</td></tr>`}</tbody>
    </table>
  </div>
</section>

<section>
  <div class="section-title">Metric glossary</div>
  <div class="glossary-grid">
    ${Object.entries(METRIC_META).map(([id, m]) => {
      const groupClass = 'group-' + m.group.replace(/\s+/g, '');
      const color = GROUP_COLORS[m.group] ?? '#6b7280';
      return `<div class="glossary-card">
        <div class="glossary-card-header">
          <span class="metric-badge" style="background:${color}22;color:${color}">${escape(m.label)}</span>
          <span class="glossary-group ${groupClass}">${escape(m.group)}</span>
        </div>
        <div class="glossary-desc">${escape(m.desc)}</div>
      </div>`;
    }).join('\n    ')}
  </div>
</section>

</main>

<footer class="site-footer">
  AI Sitebuilder Benchmark · open-source · scores captured at submission time · URL results may change
</footer>

<script>
  function setThemeIcon(isLight) {
    const el = document.getElementById('themeIcon');
    el.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
    lucide.createIcons();
    document.getElementById('themeLabel').textContent = isLight ? 'Dark' : 'Light';
  }
  function toggleTheme() {
    const isLight = document.documentElement.classList.toggle('light');
    setThemeIcon(isLight);
    try { localStorage.setItem('theme', isLight ? 'light' : 'dark'); } catch(e) {}
  }
  (function() {
    lucide.createIcons();
    try {
      if (localStorage.getItem('theme') === 'light') {
        document.documentElement.classList.add('light');
        setThemeIcon(true);
      }
    } catch(e) {}
  })();
</script>
</body>
</html>`;
}

function scoreBar(score: number): string {
  const pct = Math.round(score * 100);
  return `<div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%"></div></div>`;
}

function renderMiniBar(score: number): string {
  const pct = Math.round(score * 100);
  const color = score >= 0.8 ? '#22c55e' : score >= 0.6 ? '#eab308' : '#ef4444';
  return `<div class="mini-bar" style="background:${color};width:${Math.round(pct * 0.28)}px"></div>`;
}

function renderScoreCell(score: number | null | undefined): string {
  if (score == null) return `<td class="na">—</td>`;
  return `<td class="dim-avg">${renderMiniBar(score)}<span>${(score * 100).toFixed(0)}</span></td>`;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

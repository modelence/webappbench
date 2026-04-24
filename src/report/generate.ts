import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Submission } from '../core/submission.ts';
import type { ScorerResult } from '../scorers/types.ts';

interface RunSummary {
  tool: string;
  promptId: string;
  runIdx: number;
  toolVersion: string;
  submittedAt: string;
  artifactUrl: string;
  scores: Record<string, ScorerResult>;
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
    return {
      tool: submission.tool,
      promptId: submission.promptId,
      runIdx: submission.runIdx,
      toolVersion: submission.toolVersion,
      submittedAt: submission.submittedAt,
      artifactUrl: submission.artifactUrl,
      scores,
    };
  } catch {
    return null;
  }
}

const DIMENSIONS = ['f1', 'f2', 'c3', 'c4', 'c9', 'cost'] as const;

function renderHtml(runs: RunSummary[]): string {
  const rows = runs
    .map((r) => {
      const cells = DIMENSIONS.map((d) => {
        const score = r.scores[d];
        if (!score) return `<td class="na">—</td>`;
        if (score.score === null) return `<td class="na">N/A</td>`;
        const cls = score.passed === true ? 'pass' : score.passed === false ? 'fail' : 'na';
        return `<td class="${cls}">${score.score.toFixed(3)}</td>`;
      }).join('');
      return `<tr>
        <td>${escape(r.tool)}</td>
        <td>${escape(r.promptId)}</td>
        <td><a href="${escape(r.artifactUrl)}" target="_blank" rel="noopener">link</a></td>
        <td>${escape(r.toolVersion)}</td>
        ${cells}
      </tr>`;
    })
    .join('\n');

  const summary = summarizeByTool(runs);
  const summaryRows = Object.entries(summary)
    .map(([tool, agg]) => {
      const cells = DIMENSIONS.map((d) => {
        const v = agg[d];
        return v === null ? `<td class="na">—</td>` : `<td>${v.toFixed(3)}</td>`;
      }).join('');
      return `<tr><td>${escape(tool)}</td><td>${agg.runs}</td>${cells}</tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AI Sitebuilder Benchmark — Leaderboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { margin-top: 0; }
  h2 { margin-top: 2.5rem; }
  table { border-collapse: collapse; margin-bottom: 2rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid #eee; font-variant-numeric: tabular-nums; }
  th { font-weight: 600; background: #f7f7f5; }
  td.pass { background: rgba(0, 128, 0, .08); }
  td.fail { background: rgba(200, 0, 0, .08); }
  td.na { color: #888; }
  a { color: #2f6f4f; }
  .caveat { background: #fff9db; padding: .75rem 1rem; border-left: 3px solid #ffc107; font-size: .9rem; }
</style>
</head>
<body>
<h1>AI Sitebuilder Benchmark</h1>
<p>Generated ${new Date().toISOString()} from <code>${escape(runs.length.toString())}</code> scored run(s).</p>
<p class="caveat">v0.1 — deterministic scorers only. Cost (T1/T2) is user self-reported, not instrumented.</p>

<h2>By tool (mean of scored runs)</h2>
<table>
  <thead><tr><th>Tool</th><th>Runs</th><th>F1 render</th><th>F2 accept</th><th>C3 a11y</th><th>C4 perf</th><th>C9 SEO</th><th>Cost</th></tr></thead>
  <tbody>${summaryRows || '<tr><td colspan="8">No runs.</td></tr>'}</tbody>
</table>

<h2>Per run</h2>
<table>
  <thead><tr><th>Tool</th><th>Prompt</th><th>URL</th><th>Version</th><th>F1</th><th>F2</th><th>C3</th><th>C4</th><th>C9</th><th>Cost</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="10">No runs.</td></tr>'}</tbody>
</table>
</body>
</html>
`;
}

type Agg = { runs: number } & Record<(typeof DIMENSIONS)[number], number | null>;

function summarizeByTool(runs: RunSummary[]): Record<string, Agg> {
  const byTool: Record<string, Agg> = {};
  for (const r of runs) {
    const key = r.tool;
    const existing = byTool[key] ?? initAgg();
    existing.runs += 1;
    for (const d of DIMENSIONS) {
      const s = r.scores[d]?.score;
      if (typeof s === 'number') {
        const prev = existing[d];
        existing[d] = prev === null ? s : prev + s;
      }
    }
    byTool[key] = existing;
  }
  for (const [, agg] of Object.entries(byTool)) {
    for (const d of DIMENSIONS) {
      const prev = agg[d];
      if (prev !== null) agg[d] = prev / agg.runs;
    }
  }
  return byTool;
}

function initAgg(): Agg {
  return {
    runs: 0,
    f1: null,
    f2: null,
    c3: null,
    c4: null,
    c9: null,
    cost: null,
  };
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

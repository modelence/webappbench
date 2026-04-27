import { loadConfig, type SubmissionConfigEntry } from '../core/config.ts';
import { createSubmissionArtifact } from '../core/submission.ts';
import type { UserReportedCost, UserReportedTiming } from '../core/types.ts';
import { computeComposite, formatComposite } from './composite.ts';
import { formatScorerDetail } from './format.ts';
import { scoreSubmission } from './orchestrate.ts';
import type { ScorerResult } from './types.ts';

export interface BatchOutcome {
  tool: string;
  promptId: string;
  runIdx: number;
  url: string;
  ok: boolean;
  artifactDir?: string;
  error?: string;
  scores?: Record<string, ScorerResult>;
}

export interface BatchOptions {
  configPath: string;
  corpusDir: string;
  artifactsRoot: string;
}

export async function scoreAll(opts: BatchOptions): Promise<BatchOutcome[]> {
  const config = await loadConfig(opts.configPath);
  const outcomes: BatchOutcome[] = [];

  for (const entry of config.runs) {
    const label = `${entry.tool}/${entry.prompt}/${entry.runIdx}`;
    console.log(`\n→ ${label}  ${entry.url}`);
    const outcome = await runOne(entry, opts);
    outcomes.push(outcome);
    if (!outcome.ok) {
      console.error(`  failed: ${outcome.error}`);
    }
  }

  return outcomes;
}

async function runOne(
  entry: SubmissionConfigEntry,
  opts: BatchOptions,
): Promise<BatchOutcome> {
  try {
    const { paths } = await createSubmissionArtifact({
      tool: entry.tool,
      promptId: entry.prompt,
      runIdx: entry.runIdx,
      url: entry.url,
      sourcePath: entry.source,
      toolVersion: entry.toolVersion,
      timing: timingFromEntry(entry),
      cost: costFromEntry(entry),
      corpusDir: opts.corpusDir,
      artifactsRoot: opts.artifactsRoot,
    });
    const { results } = await scoreSubmission(paths.root, {
      onProgress: (e) => {
        if (e.kind === 'scorer_start') {
          process.stdout.write(`  ${e.name.padEnd(5)} running…`);
        } else {
          const pass = e.result.passed === null ? 'N/A' : e.result.passed ? 'yes' : 'NO ';
          const score = e.result.score === null ? '  N/A' : e.result.score.toFixed(3);
          const elapsed = formatElapsed(e.elapsedMs);
          const detail = formatScorerDetail(e.name, e.result);
          const suffix = detail ? `   ${detail}` : '';
          process.stdout.write(`\r  ${e.name.padEnd(5)} ${pass}   ${score}   ${elapsed.padEnd(6)}${suffix}\n`);
        }
      },
    });
    console.log(`  ${formatComposite(computeComposite(results))}`);
    return {
      tool: entry.tool,
      promptId: entry.prompt,
      runIdx: entry.runIdx,
      url: entry.url,
      ok: true,
      artifactDir: paths.root,
      scores: results,
    };
  } catch (err) {
    return {
      tool: entry.tool,
      promptId: entry.prompt,
      runIdx: entry.runIdx,
      url: entry.url,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function timingFromEntry(e: SubmissionConfigEntry): UserReportedTiming | undefined {
  const t: UserReportedTiming = {};
  if (e.promptSubmittedAt) t.promptSubmittedAt = e.promptSubmittedAt;
  if (e.firstRenderAt) t.firstRenderAt = e.firstRenderAt;
  if (e.workingBuildAt) t.workingBuildAt = e.workingBuildAt;
  return Object.keys(t).length > 0 ? t : undefined;
}

function costFromEntry(e: SubmissionConfigEntry): UserReportedCost | undefined {
  const c: UserReportedCost = {};
  if (e.credits !== undefined) c.credits = e.credits;
  if (e.usd !== undefined) c.usdEstimate = e.usd;
  if (e.note) c.notes = e.note;
  return Object.keys(c).length > 0 ? c : undefined;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

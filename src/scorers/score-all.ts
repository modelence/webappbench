import { loadConfig, backendFromEntry, type SubmissionConfigEntry } from '../core/config.ts';
import { createSubmissionArtifact } from '../core/submission.ts';
import type { UserReportedCost, UserReportedTiming } from '../core/types.ts';
import { computeComposite, formatComposite, formatCompositeBreakdown } from './composite.ts';
import { scoreSubmission } from './orchestrate.ts';
import { makeProgressHandler } from './progress.ts';
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
  only?: string[];
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

export async function runOne(
  entry: SubmissionConfigEntry,
  opts: Omit<BatchOptions, 'configPath'>,
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
      backend: backendFromEntry(entry),
      corpusDir: opts.corpusDir,
      artifactsRoot: opts.artifactsRoot,
    });
    const { onProgress, flush } = makeProgressHandler();
    const { results } = await scoreSubmission(paths.root, { onProgress, only: opts.only });
    flush();
    const composite = computeComposite(results);
    console.log(`  ${formatComposite(composite)}`);
    const breakdown = formatCompositeBreakdown(composite);
    if (breakdown) console.log(breakdown);
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
  if (e.buildSeconds !== undefined) t.buildSeconds = e.buildSeconds;
  return Object.keys(t).length > 0 ? t : undefined;
}

function costFromEntry(e: SubmissionConfigEntry): UserReportedCost | undefined {
  const c: UserReportedCost = {};
  if (e.credits !== undefined) c.credits = e.credits;
  if (e.usd !== undefined) c.usdEstimate = e.usd;
  if (e.note) c.notes = e.note;
  return Object.keys(c).length > 0 ? c : undefined;
}


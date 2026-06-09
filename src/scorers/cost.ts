import { writeJson } from '../core/artifact.ts';
import type { Submission } from '../core/submission.ts';
import type { ArtifactPaths } from '../core/artifact.ts';
import type { ScorerResult } from './types.ts';

export const COST_VERSION = '0.1.0';

export async function runCost(submission: Submission, paths: ArtifactPaths): Promise<ScorerResult> {
  const timing = submission.userReportedTiming;
  const cost = submission.userReportedCost;

  const ttfrMs = diffMsOrNull(timing?.promptSubmittedAt, timing?.firstRenderAt);
  const ttwbMs =
    diffMsOrNull(timing?.promptSubmittedAt, timing?.workingBuildAt) ??
    secToMsOrNull(timing?.buildSeconds);

  const payload = {
    source: 'user-reported' as const,
    promptSubmittedAt: timing?.promptSubmittedAt ?? null,
    firstRenderAt: timing?.firstRenderAt ?? null,
    workingBuildAt: timing?.workingBuildAt ?? null,
    ttfrMs,
    ttwbMs,
    credits: cost?.credits ?? null,
    usdEstimate: cost?.usdEstimate ?? null,
    notes: cost?.notes ?? null,
  };
  await writeJson(paths.cost, payload);

  const hasAnyTiming = ttfrMs !== null || ttwbMs !== null;
  const hasAnyCost = cost?.credits !== undefined || cost?.usdEstimate !== undefined;

  return {
    scorer: 'cost',
    version: COST_VERSION,
    passed: null,
    score: null,
    details: payload,
    notes:
      hasAnyTiming || hasAnyCost
        ? 'Self-reported by user; not instrumented.'
        : 'No user-reported timing or cost provided.',
  };
}

function diffMsOrNull(fromIso: string | undefined, toIso: string | undefined): number | null {
  if (!fromIso || !toIso) return null;
  const diff = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Number.isFinite(diff) && diff >= 0 ? diff : null;
}

function secToMsOrNull(seconds: number | undefined): number | null {
  if (seconds === undefined) return null;
  return seconds * 1000;
}

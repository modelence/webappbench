import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { writeJson } from '../../core/artifact.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C4_VERSION = '0.2.0';

// ── Timeouts ─────────────────────────────────────────────────────────────────
//
// Each Lighthouse invocation gets its own hard wall-clock cap (PER_RUN_TIMEOUT_MS).
// On timeout we abandon the run, kill the Chrome instance (it's likely stuck
// holding a request open), and continue to the next run with a fresh Chrome.
//
// The whole scorer also gets a hard cap (OVERALL_TIMEOUT_MS) so a chronically
// slow site can't stall the entire batch. We score whatever runs completed
// before the cap; below MIN_SUCCESSFUL_RUNS we return null.
//
// Lighthouse's own internal defaults (maxWaitForLoad/maxWaitForFcp) are set
// explicitly here rather than relying on Lighthouse defaults, which have
// changed between major versions.

const RUNS = 3;
const MIN_SUCCESSFUL_RUNS = 1;
const PER_RUN_TIMEOUT_MS = 90_000;
const OVERALL_TIMEOUT_MS = 240_000;
const LH_MAX_WAIT_FOR_LOAD_MS = 45_000;
const LH_MAX_WAIT_FOR_FCP_MS = 30_000;

type LHR = {
  categories: Record<string, { id: string; score: number | null }>;
  audits: Record<string, { id: string; numericValue?: number; score: number | null }>;
  runtimeError?: { code: string; message: string };
};

interface RunOutcome {
  index: number;          // 1-indexed
  status: 'ok' | 'timeout' | 'runtime_error' | 'error';
  elapsedMs: number;
  error?: string;
  // Only present when status === 'ok'.
  lhr?: LHR;
}

export async function runC4(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const outcomes: RunOutcome[] = [];

  for (let i = 0; i < RUNS; i++) {
    const remainingOverall = OVERALL_TIMEOUT_MS - (Date.now() - start);
    if (remainingOverall <= 0) {
      // We've burned the whole budget; record a synthetic skip and stop.
      outcomes.push({
        index: i + 1,
        status: 'timeout',
        elapsedMs: 0,
        error: 'overall scorer timeout exceeded before run started',
      });
      break;
    }
    // Each run gets the smaller of its own timeout or the overall remainder.
    const runTimeout = Math.min(PER_RUN_TIMEOUT_MS, remainingOverall);
    const outcome = await runOnce(ctx.submission.artifactUrl, i + 1, runTimeout);
    outcomes.push(outcome);
  }

  const successful = outcomes.filter((o): o is RunOutcome & { lhr: LHR } => o.status === 'ok' && !!o.lhr);

  if (successful.length < MIN_SUCCESSFUL_RUNS) {
    return {
      scorer: 'c4',
      version: C4_VERSION,
      passed: null,
      score: null,
      details: {
        runs: RUNS,
        successfulRuns: 0,
        outcomes,
        elapsedMs: Date.now() - start,
        note: summarizeFailure(outcomes),
      },
    };
  }

  const lhrs = successful.map((o) => o.lhr);
  // Keep the median run's LHR for diagnostics. With 1 run we keep that one;
  // with 2 we keep the lower-scoring one (more conservative).
  const medianIdx = Math.floor((lhrs.length - 1) / 2);
  await writeJson(ctx.paths.lighthouse, lhrs[medianIdx]);

  const perf = median(lhrs.map((r) => r.categories['performance']?.score ?? 0));
  const a11y = median(lhrs.map((r) => r.categories['accessibility']?.score ?? 0));
  const bp = median(lhrs.map((r) => r.categories['best-practices']?.score ?? 0));
  const seo = median(lhrs.map((r) => r.categories['seo']?.score ?? 0));

  const getMetric = (key: string): number | null => {
    const vals = lhrs
      .map((r) => r.audits[key]?.numericValue ?? null)
      .filter((v): v is number => v !== null);
    return vals.length > 0 ? median(vals) : null;
  };

  return {
    scorer: 'c4',
    version: C4_VERSION,
    passed: perf >= 0.5,
    score: perf,
    details: {
      runs: RUNS,
      successfulRuns: successful.length,
      perfScore: perf,
      a11yScore: a11y,
      bestPracticesScore: bp,
      seoScore: seo,
      metrics: {
        lcpMs: getMetric('largest-contentful-paint'),
        fcpMs: getMetric('first-contentful-paint'),
        cls: getMetric('cumulative-layout-shift'),
        tbtMs: getMetric('total-blocking-time'),
        siMs: getMetric('speed-index'),
      },
      outcomes,
      elapsedMs: Date.now() - start,
    },
  };
}

// Runs Lighthouse once with a hard wall-clock timeout. Owns its own Chrome
// instance — on timeout we kill Chrome explicitly so a hung renderer can't
// keep the next run from starting cleanly.
async function runOnce(url: string, index: number, timeoutMs: number): Promise<RunOutcome> {
  const runStart = Date.now();
  let chrome: Awaited<ReturnType<typeof chromeLauncher.launch>> | null = null;

  try {
    chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless', '--no-sandbox'],
    });

    const lhPromise = lighthouse(url, {
      port: chrome.port,
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor: 'mobile',
      maxWaitForLoad: LH_MAX_WAIT_FOR_LOAD_MS,
      maxWaitForFcp: LH_MAX_WAIT_FOR_FCP_MS,
      screenEmulation: {
        mobile: true,
        width: 360,
        height: 640,
        deviceScaleFactor: 2,
        disabled: false,
      },
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`lighthouse run ${index} exceeded ${timeoutMs}ms wall-clock`));
      }, timeoutMs);
    });

    let result: Awaited<typeof lhPromise>;
    try {
      result = await Promise.race([lhPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (!result) {
      return {
        index,
        status: 'error',
        elapsedMs: Date.now() - runStart,
        error: 'lighthouse returned no result',
      };
    }

    const lhr = result.lhr as LHR;
    if (lhr.runtimeError) {
      return {
        index,
        status: 'runtime_error',
        elapsedMs: Date.now() - runStart,
        error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`,
      };
    }

    return { index, status: 'ok', elapsedMs: Date.now() - runStart, lhr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('exceeded') && message.includes('wall-clock');
    return {
      index,
      status: isTimeout ? 'timeout' : 'error',
      elapsedMs: Date.now() - runStart,
      error: message,
    };
  } finally {
    if (chrome) {
      // Always tear down Chrome between runs. On timeout this is critical:
      // the launcher's port may still be held by a hung process, and starting
      // a fresh Lighthouse against a stuck Chrome would inherit the hang.
      // chrome.kill() is sync and may throw if the process already exited.
      try { chrome.kill(); } catch { /* already gone */ }
    }
  }
}

function summarizeFailure(outcomes: RunOutcome[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`);
  // Surface the first error message for diagnostics.
  const firstErr = outcomes.find((o) => o.error)?.error;
  const errSuffix = firstErr ? ` — first: ${firstErr.slice(0, 160)}` : '';
  return `c4 lighthouse: ${parts.join(', ')} of ${outcomes.length} run(s)${errSuffix}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

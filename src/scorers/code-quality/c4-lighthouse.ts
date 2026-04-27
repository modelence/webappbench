import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { writeJson } from '../../core/artifact.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C4_VERSION = '0.1.0';
const RUNS = 3;

type LHR = {
  categories: Record<string, { id: string; score: number | null }>;
  audits: Record<string, { id: string; numericValue?: number; score: number | null }>;
  runtimeError?: { code: string; message: string };
};

export async function runC4(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless', '--no-sandbox'],
  });
  try {
    const lhrs: LHR[] = [];
    for (let i = 0; i < RUNS; i++) {
      const result = await lighthouse(ctx.submission.artifactUrl, {
        port: chrome.port,
        logLevel: 'error',
        output: 'json',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 360,
          height: 640,
          deviceScaleFactor: 2,
          disabled: false,
        },
      });
      if (!result) throw new Error(`lighthouse run ${i + 1} returned no result`);
      const lhr = result.lhr as LHR;
      if (lhr.runtimeError) {
        return {
          scorer: 'c4',
          version: C4_VERSION,
          passed: null,
          score: null,
          details: {
            elapsedMs: Date.now() - start,
            error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`,
          },
        };
      }
      lhrs.push(lhr);
    }

    await writeJson(ctx.paths.lighthouse, lhrs[Math.floor(RUNS / 2)]);

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
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'c4',
      version: C4_VERSION,
      passed: null,
      score: null,
      details: {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    await chrome.kill();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

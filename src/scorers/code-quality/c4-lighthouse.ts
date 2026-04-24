import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { writeJson } from '../../core/artifact.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C4_VERSION = '0.1.0';

export async function runC4(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless', '--no-sandbox'],
  });
  try {
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
    if (!result) {
      throw new Error('lighthouse returned no result');
    }

    const lhr = result.lhr as {
      categories: Record<string, { id: string; score: number | null }>;
      audits: Record<string, { id: string; numericValue?: number; score: number | null }>;
      runtimeError?: { code: string; message: string };
    };
    await writeJson(ctx.paths.lighthouse, lhr);

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

    const perf = lhr.categories['performance']?.score ?? null;
    const metrics = {
      lcpMs: lhr.audits['largest-contentful-paint']?.numericValue ?? null,
      fcpMs: lhr.audits['first-contentful-paint']?.numericValue ?? null,
      cls: lhr.audits['cumulative-layout-shift']?.numericValue ?? null,
      tbtMs: lhr.audits['total-blocking-time']?.numericValue ?? null,
      siMs: lhr.audits['speed-index']?.numericValue ?? null,
    };

    return {
      scorer: 'c4',
      version: C4_VERSION,
      passed: perf !== null ? perf >= 0.5 : null,
      score: perf,
      details: {
        perfScore: perf,
        a11yScore: lhr.categories['accessibility']?.score ?? null,
        bestPracticesScore: lhr.categories['best-practices']?.score ?? null,
        seoScore: lhr.categories['seo']?.score ?? null,
        metrics,
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

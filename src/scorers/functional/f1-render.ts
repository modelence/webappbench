import { join } from 'node:path';
import type { ScorerContext, ScorerResult } from '../types.ts';

const GOTO_TIMEOUT_MS = 30_000;
// Deployments with WebSockets / long-polling / analytics beacons (Replit, etc.)
// may never reach `networkidle`. Cap short; sites that don't settle in this
// window won't in 30s either.
const NETWORKIDLE_TIMEOUT_MS = 8_000;

export const F1_VERSION = '0.1.0';

export async function runF1(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  try {
    const response = await ctx.page.goto(ctx.submission.artifactUrl, {
      waitUntil: 'domcontentloaded',
      timeout: GOTO_TIMEOUT_MS,
    });
    const status = response?.status() ?? 0;
    await ctx.page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_TIMEOUT_MS }).catch(() => undefined);

    const bodyText = (await ctx.page.textContent('body').catch(() => null)) ?? '';
    const textLength = bodyText.trim().length;
    const hasContent = textLength >= 10;

    await ctx.page
      .screenshot({ path: join(ctx.paths.screenshots, 'initial.png'), fullPage: true })
      .catch(() => undefined);

    const passed = status >= 200 && status < 300 && hasContent;
    return {
      scorer: 'f1',
      version: F1_VERSION,
      passed,
      score: passed ? 1 : 0,
      details: {
        httpStatus: status,
        bodyTextLength: textLength,
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'f1',
      version: F1_VERSION,
      passed: false,
      score: 0,
      details: {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

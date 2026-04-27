import { join } from 'node:path';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const V4_VERSION = '0.1.0';

const VIEWPORTS = [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const TOUCH_TARGET_MIN_PX = 44;
// Allow up to 20% of interactive elements to be undersized before failing.
const TOUCH_TARGET_TOLERANCE = 0.2;

interface ViewportResult {
  name: string;
  width: number;
  hasHorizontalOverflow: boolean;
  overflowingElements: number;
  smallTouchTargets?: number;
  totalInteractiveElements?: number;
}

export async function runV4(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const viewportResults: ViewportResult[] = [];

  for (const vp of VIEWPORTS) {
    const vpCtx = await ctx.browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await vpCtx.newPage();
    try {
      await page.goto(ctx.submission.artifactUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);

      // NOTE: keep evaluate callbacks self-contained (no named helper fns — tsx/esbuild __name issue)
      const overflow = await page.evaluate(() => {
        const body = document.documentElement;
        const overflowCount = Array.from(document.querySelectorAll('*')).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > window.innerWidth + 2;
        }).length;
        return {
          hasOverflow: body.scrollWidth > body.clientWidth + 2,
          count: overflowCount,
        };
      });

      const result: ViewportResult = {
        name: vp.name,
        width: vp.width,
        hasHorizontalOverflow: overflow.hasOverflow,
        overflowingElements: overflow.count,
      };

      if (vp.name === 'mobile') {
        const touchStats = await page.evaluate((minSize: number) => {
          const selectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"]';
          const els = Array.from(document.querySelectorAll(selectors));
          const interactive = els.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const small = interactive.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width < minSize || r.height < minSize;
          });
          return { total: interactive.length, small: small.length };
        }, TOUCH_TARGET_MIN_PX);
        result.smallTouchTargets = touchStats.small;
        result.totalInteractiveElements = touchStats.total;
      }

      await page.screenshot({
        path: join(ctx.paths.screenshots, `viewport-${vp.name}.png`),
        fullPage: false,
      }).catch(() => undefined);

      viewportResults.push(result);
    } finally {
      await vpCtx.close();
    }
  }

  const checks = computeChecks(viewportResults);
  const passing = checks.filter((c) => c.pass).length;
  const score = checks.length > 0 ? passing / checks.length : null;

  return {
    scorer: 'v4',
    version: V4_VERSION,
    passed: score !== null ? score >= 0.75 : null,
    score,
    details: {
      viewports: viewportResults,
      checks,
      passingChecks: passing,
      totalChecks: checks.length,
      elapsedMs: Date.now() - start,
    },
  };
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function computeChecks(results: ViewportResult[]): Check[] {
  const checks: Check[] = [];

  for (const r of results) {
    checks.push({
      name: `${r.name}_no_horizontal_overflow`,
      pass: !r.hasHorizontalOverflow,
      detail: r.hasHorizontalOverflow
        ? `${r.overflowingElements} element(s) overflow at ${r.width}px`
        : `no overflow at ${r.width}px`,
    });

    if (r.name === 'mobile' && r.totalInteractiveElements !== undefined && r.smallTouchTargets !== undefined) {
      const total = r.totalInteractiveElements;
      const small = r.smallTouchTargets;
      const ratio = total > 0 ? small / total : 0;
      checks.push({
        name: 'mobile_touch_targets',
        pass: ratio <= TOUCH_TARGET_TOLERANCE,
        detail: total > 0
          ? `${small}/${total} interactive elements < ${TOUCH_TARGET_MIN_PX}px (${(ratio * 100).toFixed(0)}%)`
          : 'no interactive elements found',
      });
    }
  }

  return checks;
}

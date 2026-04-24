import { writeJson } from '../../core/artifact.ts';
import type { SeoCheck } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C9_VERSION = '0.1.0';

interface SeoCheckOutcome {
  check: SeoCheck;
  passed: boolean;
  detail?: string;
}

export async function runC9(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  try {
    const applicable = ctx.prompt.seoApplicable;
    if (applicable.length === 0) {
      return {
        scorer: 'c9',
        version: C9_VERSION,
        passed: null,
        score: null,
        details: { note: 'No SEO checks applicable for this prompt', elapsedMs: Date.now() - start },
      };
    }

    const outcomes: SeoCheckOutcome[] = [];
    for (const check of applicable) {
      outcomes.push(await runCheck(ctx, check));
    }

    const passed = outcomes.filter((o) => o.passed).length;
    const total = outcomes.length;
    const score = total === 0 ? null : passed / total;

    await writeJson(ctx.paths.seo, { applicable, outcomes });

    return {
      scorer: 'c9',
      version: C9_VERSION,
      passed: passed === total,
      score,
      details: {
        applicableCount: total,
        passedCount: passed,
        outcomes,
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'c9',
      version: C9_VERSION,
      passed: null,
      score: null,
      details: {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function runCheck(ctx: ScorerContext, check: SeoCheck): Promise<SeoCheckOutcome> {
  const { page } = ctx;
  switch (check) {
    case 'title': {
      const title = (await page.title()).trim();
      const passed = title.length >= 10 && title.length <= 70 && !/untitled|document/i.test(title);
      return { check, passed, detail: title };
    }
    case 'meta_description': {
      const content = await page.locator('meta[name="description"]').first().getAttribute('content').catch(() => null);
      const passed = !!content && content.trim().length >= 50 && content.trim().length <= 300;
      return { check, passed, detail: content ?? 'missing' };
    }
    case 'canonical': {
      const href = await page.locator('link[rel="canonical"]').first().getAttribute('href').catch(() => null);
      return { check, passed: !!href && /^https?:\/\//.test(href), detail: href ?? 'missing' };
    }
    case 'og_tags': {
      const required = ['og:title', 'og:description', 'og:type'];
      const missing: string[] = [];
      for (const prop of required) {
        const content = await page.locator(`meta[property="${prop}"]`).first().getAttribute('content').catch(() => null);
        if (!content) missing.push(prop);
      }
      return { check, passed: missing.length === 0, detail: missing.length === 0 ? 'ok' : `missing: ${missing.join(', ')}` };
    }
    case 'twitter_card': {
      const content = await page.locator('meta[name="twitter:card"]').first().getAttribute('content').catch(() => null);
      return { check, passed: !!content, detail: content ?? 'missing' };
    }
    case 'json_ld': {
      const count = await page.locator('script[type="application/ld+json"]').count();
      return { check, passed: count > 0, detail: `${count} block(s)` };
    }
    case 'lang': {
      const lang = await page.locator('html').first().getAttribute('lang').catch(() => null);
      return { check, passed: !!lang && lang.length >= 2, detail: lang ?? 'missing' };
    }
    case 'heading_hierarchy': {
      const h1Count = await page.locator('h1').count();
      const levels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((n) => Number(n.tagName.slice(1))),
      );
      const skipped = detectSkippedLevels(levels);
      const passed = h1Count === 1 && !skipped;
      return {
        check,
        passed,
        detail: `h1Count=${h1Count}, skippedLevel=${skipped ? 'yes' : 'no'}, sequence=[${levels.join(',')}]`,
      };
    }
    case 'robots_txt': {
      const url = new URL('/robots.txt', ctx.submission.artifactUrl).toString();
      const ok = await headOk(url);
      return { check, passed: ok, detail: url };
    }
    case 'sitemap_xml': {
      const url = new URL('/sitemap.xml', ctx.submission.artifactUrl).toString();
      const ok = await headOk(url);
      return { check, passed: ok, detail: url };
    }
  }
}

function detectSkippedLevels(levels: number[]): boolean {
  let prev = 0;
  for (const l of levels) {
    if (prev !== 0 && l > prev + 1) return true;
    prev = l;
  }
  return false;
}

async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

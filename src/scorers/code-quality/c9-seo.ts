import { writeJson } from '../../core/artifact.ts';
import type { SeoCheck } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C9_VERSION = '0.1.0';

interface SeoCheckOutcome {
  check: SeoCheck;
  passed: boolean;
  detail?: string;
}

// DOM facts extracted once via page.evaluate — avoids per-lookup 30s actionTimeouts
// from Playwright locators when an element is missing.
interface DomFacts {
  title: string;
  metaDescription: string | null;
  canonical: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogType: string | null;
  twitterCard: string | null;
  jsonLdCount: number;
  htmlLang: string | null;
  h1Count: number;
  headingLevels: number[];
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

    const facts = await collectDomFacts(ctx);
    const outcomes: SeoCheckOutcome[] = [];
    for (const check of applicable) {
      outcomes.push(await runCheck(check, facts, ctx.submission.artifactUrl));
    }

    const passed = outcomes.filter((o) => o.passed).length;
    const total = outcomes.length;
    const score = total === 0 ? null : passed / total;

    await writeJson(ctx.paths.seo, { applicable, outcomes, facts });

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

async function collectDomFacts(ctx: ScorerContext): Promise<DomFacts> {
  // NOTE: keep this callback self-contained (no nested fn/arrow helpers).
  // tsx/esbuild injects a `__name` helper for named functions that Playwright
  // cannot transport into the browser context.
  return ctx.page.evaluate<DomFacts>(() => {
    const headingNodes = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
    const headings: number[] = [];
    for (const n of Array.from(headingNodes)) {
      headings.push(Number(n.tagName.slice(1)));
    }
    return {
      title: (document.title || '').trim(),
      metaDescription:
        document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
      canonical:
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogTitle:
        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null,
      ogDescription:
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null,
      ogType:
        document.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? null,
      twitterCard:
        document.querySelector('meta[name="twitter:card"]')?.getAttribute('content') ?? null,
      jsonLdCount: document.querySelectorAll('script[type="application/ld+json"]').length,
      htmlLang: document.documentElement.getAttribute('lang'),
      h1Count: document.querySelectorAll('h1').length,
      headingLevels: headings,
    };
  });
}

async function runCheck(
  check: SeoCheck,
  f: DomFacts,
  baseUrl: string,
): Promise<SeoCheckOutcome> {
  switch (check) {
    case 'title': {
      const passed = f.title.length >= 10 && f.title.length <= 70 && !/untitled|document/i.test(f.title);
      return { check, passed, detail: f.title || 'missing' };
    }
    case 'meta_description': {
      const d = (f.metaDescription ?? '').trim();
      const passed = d.length >= 50 && d.length <= 300;
      return { check, passed, detail: f.metaDescription ?? 'missing' };
    }
    case 'canonical': {
      const passed = !!f.canonical && /^https?:\/\//.test(f.canonical);
      return { check, passed, detail: f.canonical ?? 'missing' };
    }
    case 'og_tags': {
      const missing: string[] = [];
      if (!f.ogTitle) missing.push('og:title');
      if (!f.ogDescription) missing.push('og:description');
      if (!f.ogType) missing.push('og:type');
      return {
        check,
        passed: missing.length === 0,
        detail: missing.length === 0 ? 'ok' : `missing: ${missing.join(', ')}`,
      };
    }
    case 'twitter_card': {
      return { check, passed: !!f.twitterCard, detail: f.twitterCard ?? 'missing' };
    }
    case 'json_ld': {
      return { check, passed: f.jsonLdCount > 0, detail: `${f.jsonLdCount} block(s)` };
    }
    case 'lang': {
      const passed = !!f.htmlLang && f.htmlLang.length >= 2;
      return { check, passed, detail: f.htmlLang ?? 'missing' };
    }
    case 'heading_hierarchy': {
      const skipped = detectSkippedLevels(f.headingLevels);
      const passed = f.h1Count === 1 && !skipped;
      return {
        check,
        passed,
        detail: `h1Count=${f.h1Count}, skippedLevel=${skipped ? 'yes' : 'no'}, sequence=[${f.headingLevels.join(',')}]`,
      };
    }
    case 'robots_txt': {
      const url = new URL('/robots.txt', baseUrl).toString();
      return { check, passed: await headOk(url), detail: url };
    }
    case 'sitemap_xml': {
      const url = new URL('/sitemap.xml', baseUrl).toString();
      return { check, passed: await headOk(url), detail: url };
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

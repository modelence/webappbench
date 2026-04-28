import type { ScorerContext, ScorerResult } from '../types.ts';

export const V2_VERSION = '0.2.0';

interface DesignFacts {
  // Whitespace: fraction of viewport that is background-colored (sampled grid)
  backgroundRatio: number;
  // Contrast: fraction of text nodes passing WCAG AA (4.5:1 for normal, 3:1 for large)
  contrastPassRate: number;
  contrastSampled: number;
  contrastPassed: number;
  // Font size: fraction of text nodes with font-size >= 14px
  readableFontRate: number;
  fontSizeSampled: number;
  // Line length: fraction of block text nodes with line width <= 80ch
  lineLengthPassRate: number;
  lineLengthSampled: number;
  // CSS convention signals (proxies for modern scaffolding):
  // box-sizing: fraction of sampled elements using border-box
  boxSizingBorderBoxRate: number;
  boxSizingSampled: number;
  // prefers-reduced-motion: at least one @media query found in any same-origin stylesheet
  hasReducedMotionQuery: boolean;
  // CSS custom properties: count of distinct --* declarations across stylesheets
  customPropertyCount: number;
  // :focus-visible: at least one rule selector contains :focus-visible
  hasFocusVisibleRule: boolean;
  // True when at least one stylesheet was readable; if all are CORS-blocked
  // the three CSS-rule-based checks return null instead of false.
  stylesheetsReadable: boolean;
}

interface DesignCheck {
  name: string;
  // null when the check could not run (e.g. CSS-rule checks when every
  // stylesheet was CORS-blocked). Null checks are excluded from the score.
  passed: boolean | null;
  value: number;
  threshold: number;
  detail: string;
}

export async function runV2(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  try {
    // Pass as a string to prevent tsx/esbuild from transpiling the callback body,
    // which would inject __name helpers that the browser context cannot resolve.
    const facts = await ctx.page.evaluate<DesignFacts>(`(() => {
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      const htmlBg = window.getComputedStyle(document.documentElement).backgroundColor;
      const bgColors = new Set([bodyBg, htmlBg, 'rgba(0, 0, 0, 0)', 'transparent']);
      let bgHits = 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
          const x = Math.round((col + 0.5) * (vw / 10));
          const y = Math.round((row + 0.5) * (vh / 10));
          const el = document.elementFromPoint(x, y);
          if (!el) { bgHits++; continue; }
          const bg = window.getComputedStyle(el).backgroundColor;
          if (bgColors.has(bg)) bgHits++;
        }
      }
      const backgroundRatio = bgHits / 100;

      const parseSrgb = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      const lum = (r, g, b) => 0.2126 * parseSrgb(r) + 0.7152 * parseSrgb(g) + 0.0722 * parseSrgb(b);
      const parseColor = (css) => { const m = css.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; };
      const contrast = (fg, bg) => { const l1 = lum(...fg), l2 = lum(...bg); const hi = Math.max(l1,l2), lo = Math.min(l1,l2); return (hi+0.05)/(lo+0.05); };

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node = walker.nextNode();
      while (node && textNodes.length < 40) {
        if ((node.nodeValue || '').trim().length > 3) textNodes.push(node);
        node = walker.nextNode();
      }

      let contrastSampled = 0, contrastPassed = 0;
      let fontSizeSampled = 0, readableFontCount = 0;
      let lineLengthSampled = 0, lineLengthPassed = 0;

      for (const tn of textNodes) {
        const el = tn.parentElement;
        if (!el) continue;
        const style = window.getComputedStyle(el);
        const fg = parseColor(style.color);
        const bgCss = style.backgroundColor;
        const bg = parseColor(bgCss !== 'rgba(0, 0, 0, 0)' ? bgCss : bodyBg);
        if (fg && bg) {
          contrastSampled++;
          const fontSize = parseFloat(style.fontSize);
          const fontWeight = parseInt(style.fontWeight, 10);
          const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
          if (contrast(fg, bg) >= (isLarge ? 3.0 : 4.5)) contrastPassed++;
        }
        const fontSize = parseFloat(style.fontSize);
        if (!isNaN(fontSize)) {
          fontSizeSampled++;
          if (fontSize >= 14) readableFontCount++;
        }
        const display = style.display;
        if (display === 'block' || display === 'flex' || display === 'grid') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            lineLengthSampled++;
            if (rect.width / (fontSize * 0.5) <= 85) lineLengthPassed++;
          }
        }
      }

      // box-sizing sample: deterministically pick the first 200 elements via TreeWalker.
      // The original document.querySelectorAll('*') would also work but on large pages
      // it is wasteful; 200 is plenty to distinguish "applied via reset" from "ad-hoc".
      let boxSizingSampled = 0, boxSizingBorderBox = 0;
      const elWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let elNode = elWalker.nextNode();
      while (elNode && boxSizingSampled < 200) {
        const cs = window.getComputedStyle(elNode);
        boxSizingSampled++;
        if (cs.boxSizing === 'border-box') boxSizingBorderBox++;
        elNode = elWalker.nextNode();
      }

      // Stylesheet walk: detect prefers-reduced-motion media query, count
      // distinct CSS custom properties (--*), and look for :focus-visible rules.
      // Cross-origin stylesheets (e.g. Google Fonts) throw on .cssRules access;
      // we skip those silently and only set stylesheetsReadable=true if at least
      // one sheet was inspectable.
      let stylesheetsReadable = false;
      let hasReducedMotionQuery = false;
      let hasFocusVisibleRule = false;
      const customProps = new Set();

      const visitRule = (rule) => {
        const t = rule.type;
        // CSSStyleRule = 1
        if (t === 1 && rule.selectorText) {
          if (rule.selectorText.indexOf(':focus-visible') !== -1) {
            hasFocusVisibleRule = true;
          }
          if (rule.style) {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style.item(i);
              if (prop && prop.startsWith('--')) customProps.add(prop);
            }
          }
        }
        // CSSMediaRule = 4
        if (t === 4 && rule.media && rule.media.mediaText) {
          if (rule.media.mediaText.indexOf('prefers-reduced-motion') !== -1) {
            hasReducedMotionQuery = true;
          }
        }
        // Recurse into grouping rules (@media, @supports, @layer).
        if (rule.cssRules) {
          for (let i = 0; i < rule.cssRules.length; i++) visitRule(rule.cssRules[i]);
        }
      };

      for (let i = 0; i < document.styleSheets.length; i++) {
        const sheet = document.styleSheets[i];
        try {
          const rules = sheet.cssRules;
          if (!rules) continue;
          stylesheetsReadable = true;
          for (let j = 0; j < rules.length; j++) visitRule(rules[j]);
        } catch (e) {
          // CORS-blocked sheet — skip silently.
        }
      }

      // Inline style attributes can also declare --vars (Tailwind/shadcn theme overrides),
      // count those toward the custom-property total.
      const allEls = document.querySelectorAll('[style]');
      for (let i = 0; i < allEls.length; i++) {
        const decl = allEls[i].style;
        for (let j = 0; j < decl.length; j++) {
          const prop = decl.item(j);
          if (prop && prop.startsWith('--')) customProps.add(prop);
        }
      }

      return {
        backgroundRatio,
        contrastPassRate: contrastSampled > 0 ? contrastPassed / contrastSampled : 1,
        contrastSampled,
        contrastPassed,
        readableFontRate: fontSizeSampled > 0 ? readableFontCount / fontSizeSampled : 1,
        fontSizeSampled,
        lineLengthPassRate: lineLengthSampled > 0 ? lineLengthPassed / lineLengthSampled : 1,
        lineLengthSampled,
        boxSizingBorderBoxRate: boxSizingSampled > 0 ? boxSizingBorderBox / boxSizingSampled : 0,
        boxSizingSampled,
        hasReducedMotionQuery,
        customPropertyCount: customProps.size,
        hasFocusVisibleRule,
        stylesheetsReadable,
      };
    })()`);

    const checks: DesignCheck[] = [
      {
        name: 'whitespace',
        passed: facts.backgroundRatio >= 0.25,
        value: facts.backgroundRatio,
        threshold: 0.25,
        detail: `${(facts.backgroundRatio * 100).toFixed(0)}% background (need ≥25%)`,
      },
      {
        name: 'contrast',
        passed: facts.contrastPassRate >= 0.8,
        value: facts.contrastPassRate,
        threshold: 0.8,
        detail: `${facts.contrastPassed}/${facts.contrastSampled} text nodes pass WCAG AA`,
      },
      {
        name: 'font_size',
        passed: facts.readableFontRate >= 0.8,
        value: facts.readableFontRate,
        threshold: 0.8,
        detail: `${(facts.readableFontRate * 100).toFixed(0)}% text nodes ≥14px`,
      },
      {
        name: 'line_length',
        passed: facts.lineLengthPassRate >= 0.7,
        value: facts.lineLengthPassRate,
        threshold: 0.7,
        detail: `${(facts.lineLengthPassRate * 100).toFixed(0)}% block elements ≤85ch wide`,
      },
      // ── CSS convention signals (proxies for modern scaffolding) ──
      {
        name: 'box_sizing',
        passed: facts.boxSizingSampled > 0 ? facts.boxSizingBorderBoxRate >= 0.8 : null,
        value: facts.boxSizingBorderBoxRate,
        threshold: 0.8,
        detail: facts.boxSizingSampled > 0
          ? `${(facts.boxSizingBorderBoxRate * 100).toFixed(0)}% of ${facts.boxSizingSampled} elements use border-box`
          : 'no elements sampled',
      },
      {
        // Reduced-motion media query: present in stylesheet rules.
        name: 'reduced_motion',
        passed: facts.stylesheetsReadable ? facts.hasReducedMotionQuery : null,
        value: facts.hasReducedMotionQuery ? 1 : 0,
        threshold: 1,
        detail: !facts.stylesheetsReadable
          ? 'no readable stylesheets'
          : facts.hasReducedMotionQuery
          ? '@media (prefers-reduced-motion) found'
          : 'no @media (prefers-reduced-motion) rule',
      },
      {
        // CSS custom properties: ≥5 distinct --* declarations is a reasonable
        // "design tokens / themed scaffold" threshold (Tailwind, shadcn, MUI all hit this).
        name: 'custom_properties',
        passed: facts.stylesheetsReadable ? facts.customPropertyCount >= 5 : null,
        value: facts.customPropertyCount,
        threshold: 5,
        detail: !facts.stylesheetsReadable
          ? 'no readable stylesheets'
          : `${facts.customPropertyCount} distinct CSS custom properties (need ≥5)`,
      },
      {
        // :focus-visible: at least one rule selector references it. Modern
        // accessibility scaffolds always include focus-visible styling separately
        // from :focus to avoid showing the ring on mouse clicks.
        name: 'focus_visible',
        passed: facts.stylesheetsReadable ? facts.hasFocusVisibleRule : null,
        value: facts.hasFocusVisibleRule ? 1 : 0,
        threshold: 1,
        detail: !facts.stylesheetsReadable
          ? 'no readable stylesheets'
          : facts.hasFocusVisibleRule
          ? ':focus-visible rule found'
          : 'no :focus-visible rule',
      },
    ];

    // Null checks (CSS rules unreadable due to CORS) drop out of the score
    // calculation rather than counting as failures.
    const scorable = checks.filter((c) => c.passed !== null);
    const passed = scorable.filter((c) => c.passed === true).length;
    const score = scorable.length === 0 ? 0 : passed / scorable.length;

    return {
      scorer: 'v2',
      version: V2_VERSION,
      passed: score >= 0.75,
      score,
      details: {
        checks,
        backgroundRatio: facts.backgroundRatio,
        contrastPassRate: facts.contrastPassRate,
        readableFontRate: facts.readableFontRate,
        lineLengthPassRate: facts.lineLengthPassRate,
        boxSizingBorderBoxRate: facts.boxSizingBorderBoxRate,
        boxSizingSampled: facts.boxSizingSampled,
        hasReducedMotionQuery: facts.hasReducedMotionQuery,
        customPropertyCount: facts.customPropertyCount,
        hasFocusVisibleRule: facts.hasFocusVisibleRule,
        stylesheetsReadable: facts.stylesheetsReadable,
        scorableChecks: checks.filter((c) => c.passed !== null).length,
        totalChecks: checks.length,
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'v2',
      version: V2_VERSION,
      passed: null,
      score: null,
      details: {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

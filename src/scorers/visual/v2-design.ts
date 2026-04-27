import type { ScorerContext, ScorerResult } from '../types.ts';

export const V2_VERSION = '0.1.0';

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
}

interface DesignCheck {
  name: string;
  passed: boolean;
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

      return {
        backgroundRatio,
        contrastPassRate: contrastSampled > 0 ? contrastPassed / contrastSampled : 1,
        contrastSampled,
        contrastPassed,
        readableFontRate: fontSizeSampled > 0 ? readableFontCount / fontSizeSampled : 1,
        fontSizeSampled,
        lineLengthPassRate: lineLengthSampled > 0 ? lineLengthPassed / lineLengthSampled : 1,
        lineLengthSampled,
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
    ];

    const passed = checks.filter((c) => c.passed).length;
    const score = passed / checks.length;

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

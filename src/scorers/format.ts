import type { ScorerResult } from './types.ts';

export function formatScorerDetail(id: string, result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  try {
    switch (id) {
      case 'f1':
        return `HTTP ${d['httpStatus'] ?? '?'} · ${d['bodyTextLength'] ?? 0} chars`;

      case 'f2': {
        const must = `${d['mustPassed'] ?? 0}/${d['mustTotal'] ?? 0} must`;
        const should = `${d['shouldPassed'] ?? 0}/${d['shouldTotal'] ?? 0} should`;
        const failures = ((d['criteria'] as Array<Record<string, unknown>>) ?? [])
          .filter((c) => c['passed'] === false)
          .map((c) => String(c['id']))
          .slice(0, 3);
        const suffix = failures.length ? ` — failed: ${failures.join(', ')}` : '';
        return `${must} · ${should}${suffix}`;
      }

      case 'f5': {
        const total = Number(d['totalErrors'] ?? 0);
        if (total === 0) return 'no errors';
        const ce = Number(d['consoleErrorCount'] ?? 0);
        const ne = Number(d['networkErrorCount'] ?? 0);
        const parts: string[] = [];
        if (ce > 0) parts.push(`${ce} console error${ce === 1 ? '' : 's'}`);
        if (ne > 0) parts.push(`${ne} network error${ne === 1 ? '' : 's'}`);
        return parts.join(' · ');
      }

      case 'f6': {
        const passed = Number(d['passed'] ?? 0);
        const total = Number(d['total'] ?? 0);
        const failures = ((d['constraints'] as Array<Record<string, unknown>>) ?? [])
          .filter((c) => c['passed'] === false)
          .map((c) => `"${String(c['value']).slice(0, 20)}"`)
          .slice(0, 3);
        const suffix = failures.length ? ` — missing: ${failures.join(', ')}` : '';
        return `${passed}/${total} verbatim${suffix}`;
      }

      case 'v1': {
        const mean = typeof d['meanRaw'] === 'number' ? d['meanRaw'] : null;
        const notes = (d['overallNotes'] ?? d['overall_notes']) as string | null;
        const note = d['note'] as string | null;
        const error = d['error'] as string | null;
        if (note) return note.slice(0, 80);
        if (error) return `error: ${error.slice(0, 80)}`;
        if (mean === null) return 'N/A';
        const pct = ((mean - 1) / 4 * 100).toFixed(0);
        const model = String(d['model'] ?? '?').split('/').pop() ?? '';
        const suffix = notes ? ` — ${notes.slice(0, 50)}` : '';
        return `${mean.toFixed(1)}/5 (${pct}%) via ${model}${suffix}`;
      }

      case 'v4': {
        const passing = Number(d['passingChecks'] ?? 0);
        const total = Number(d['totalChecks'] ?? 0);
        const checks = (d['checks'] as Array<Record<string, unknown>>) ?? [];
        const failures = checks.filter((c) => c['pass'] === false).map((c) => String(c['name']));
        const suffix = failures.length ? ` — failed: ${failures.join(', ')}` : '';
        return `${passing}/${total} checks${suffix}`;
      }

      case 'c2': {
        const errors = Number(d['totalErrors'] ?? 0);
        const loc = Number(d['totalLoc'] ?? 0);
        const per1k = (d['errorsPer1kLoc'] as number | undefined) ?? 0;
        if (errors === 0) return `no type errors (${loc} LOC)`;
        return `${errors} type error${errors === 1 ? '' : 's'} / ${loc} LOC (${per1k.toFixed(1)}/1k)`;
      }

      case 'c8': {
        const count = Number(d['findingsCount'] ?? 0);
        if (count === 0) return 'no secrets found';
        const patterns = (d['patternsSeen'] as string[] | undefined) ?? [];
        return `${count} secret${count === 1 ? '' : 's'} found: ${patterns.join(', ')}`;
      }

      case 'c1': {
        const errors = Number(d['totalErrors'] ?? 0);
        const warns = Number(d['totalWarnings'] ?? 0);
        const loc = Number(d['totalLoc'] ?? 0);
        const ePer = (d['errorsPer1kLoc'] as number | undefined) ?? 0;
        return `${errors}e ${warns}w / ${loc} LOC (${ePer.toFixed(1)}/1k)`;
      }

      case 'c3': {
        const v = Number(d['violationsCount'] ?? 0);
        if (v === 0) return 'no violations';
        const impact = d['impactCounts'] as Record<string, number> | undefined;
        const parts = Object.entries(impact ?? {}).map(([k, n]) => `${n} ${k}`);
        return `${v} violation${v === 1 ? '' : 's'}: ${parts.join(', ')}`;
      }

      case 'c4': {
        const p = fmt(d['perfScore']);
        const a = fmt(d['a11yScore']);
        const b = fmt(d['bestPracticesScore']);
        const s = fmt(d['seoScore']);
        const m = d['metrics'] as Record<string, number | null> | undefined;
        const lcp = m?.['lcpMs'] != null ? ` LCP=${(m['lcpMs']! / 1000).toFixed(1)}s` : '';
        return `perf=${p} a11y=${a} bp=${b} seo=${s}${lcp}`;
      }

      case 'c5': {
        const bytes = Number(d['totalBytesUncompressed'] ?? 0);
        const jsFiles = Number(d['jsFileCount'] ?? 0);
        return `${(bytes / 1024).toFixed(0)}KB uncompressed · ${jsFiles} JS files`;
      }

      case 'c9': {
        const passedCount = Number(d['passedCount'] ?? 0);
        const total = Number(d['applicableCount'] ?? 0);
        const failures = ((d['outcomes'] as Array<Record<string, unknown>>) ?? [])
          .filter((o) => o['passed'] === false)
          .map((o) => String(o['check']))
          .slice(0, 4);
        const suffix = failures.length ? ` — failed: ${failures.join(', ')}` : '';
        return `${passedCount}/${total} checks${suffix}`;
      }

      case 'cost': {
        const ttfr = d['ttfrMs'] as number | null;
        const ttwb = d['ttwbMs'] as number | null;
        const usd = d['usdEstimate'] as number | null;
        if (ttfr == null && ttwb == null && usd == null) return 'no data';
        const parts: string[] = [];
        if (ttfr != null) parts.push(`TTFR ${(ttfr / 1000).toFixed(1)}s`);
        if (ttwb != null) parts.push(`TTWB ${(ttwb / 1000).toFixed(1)}s`);
        if (usd != null) parts.push(`$${usd.toFixed(2)}`);
        return parts.join(' · ');
      }

      default:
        return d['note'] ? String(d['note']).slice(0, 50) : '';
    }
  } catch {
    return '';
  }
}

function fmt(val: unknown): string {
  if (typeof val !== 'number') return '?';
  return (val * 100).toFixed(0);
}

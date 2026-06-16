import type { ScorerResult } from '../scorers/types.ts';

/**
 * One itemized result within a scorer: a single check, error, vulnerability, or
 * requirement extracted from the scorer's `details`. Carries its own `passed`
 * flag so the report shows the full breakdown — e.g. for a scorer that passes
 * 99/100 you can see which one item did not pass.
 */
export interface CheckItem {
  /** Stable kind so consumers can group/filter (e.g. 'check', 'error', 'vuln'). */
  kind: string;
  /** Whether this individual item passed. Always-failure items (errors, vulns) are false. */
  passed: boolean;
  /** Short human-readable identifier of the item (criterion id, file, rule). */
  id?: string;
  /** One-line explanation of the item's outcome. */
  message: string;
  /** Optional severity for items that carry one (vulns, secrets, axe impact). */
  severity?: string;
}

/**
 * Itemized report for one scorer within a run.
 *
 * `passed`/`score` mirror the scorer result; `status` collapses the tri-state
 * into a single label. `items` is the full per-item breakdown (passing and
 * failing), `passedItems`/`totalItems` summarize it, and `note` carries the
 * top-level skip/error reason when a scorer produced no score (N/A).
 */
export interface ScorerDetailReport {
  scorer: string;
  status: 'pass' | 'fail' | 'na';
  passed: boolean | null;
  score: number | null;
  note?: string;
  passedItems: number;
  totalItems: number;
  items: CheckItem[];
}

function statusOf(result: ScorerResult): ScorerDetailReport['status'] {
  if (result.score === null && result.passed === null) return 'na';
  if (result.passed === false) return 'fail';
  if (result.passed === true) return 'pass';
  return result.score !== null && result.score >= 1 ? 'pass' : 'fail';
}

/** Read a string property off an unknown record, or undefined. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** Coerce an unknown value into a short display string. */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Normalize a stored source path for display. Strips the artifact wrapper
 * (`…/artifacts/<tool>/<prompt>/<idx>/source/`) so paths read relative to the
 * source root, which also repairs the mangled `…hmark/artifacts/…` prefix
 * produced by older c1 runs (a bad slice landing inside "benchmark"). New runs
 * already store clean relative paths; this only cleans pre-fix artifacts so old
 * reports look right without a re-score.
 */
function cleanPath(p: string | undefined): string | undefined {
  if (!p) return p;
  return p.replace(/^.*?\/?artifacts\/[^/]+\/[^/]+\/[^/]+\/source\//, '');
}

/** Per-item pass flag across our schemas; defaults to true (item is informational). */
function itemPassed(item: Record<string, unknown>): boolean {
  if (typeof item['passed'] === 'boolean') return item['passed'];
  if (typeof item['pass'] === 'boolean') return item['pass'];
  return true;
}

type ItemBuilder = (item: Record<string, unknown>) => Omit<CheckItem, 'passed'>;

/**
 * Per-scorer mapping of a `details` array field → how to render each element as a
 * CheckItem. `kind` is the emitted item kind. By default every element is emitted
 * with its own `passed` flag (read from the element) so the report carries the
 * full breakdown. `alwaysFailure` lists hold only failures (errors, vulns,
 * missing features) — every element is emitted as `passed: false`. `stringList`
 * lists are flat string[] of failures (also always-failure).
 */
interface ListSpec {
  key: string;
  kind: string;
  /** When true, every element is a failure (no per-item passed flag to read). */
  alwaysFailure?: boolean;
  /** When true, the array is a flat string[] of failures; `build` is ignored. */
  stringList?: boolean;
  build: ItemBuilder;
}

const LIST_SPECS: Record<string, ListSpec[]> = {
  f2: [
    {
      key: 'criteria',
      kind: 'check',
      build: (c) => ({
        kind: 'check',
        id: str(c, 'id'),
        severity: str(c, 'kind'), // 'must' | 'should'
        message:
          str(c, 'note') ??
          (itemPassed(c)
            ? `${str(c, 'kind') ?? ''} requirement met`.trim()
            : `${str(c, 'kind') ?? ''} requirement not met`.trim()),
      }),
    },
  ],
  f4: [
    {
      key: 'missingFeatures',
      kind: 'missing-feature',
      alwaysFailure: true,
      build: (f) => ({ kind: 'missing-feature', message: asText(f) }),
    },
  ],
  f5: [
    {
      key: 'consoleErrors',
      kind: 'console-error',
      alwaysFailure: true,
      build: (e) => ({ kind: 'console-error', message: asText(e) }),
    },
    {
      key: 'networkErrors',
      kind: 'network-error',
      alwaysFailure: true,
      build: (e) => ({ kind: 'network-error', message: asText(e) }),
    },
  ],
  f6: [
    {
      key: 'constraints',
      kind: 'verbatim',
      build: (c) => ({
        kind: 'verbatim',
        id: str(c, 'value'),
        message: itemPassed(c)
          ? `verbatim text "${str(c, 'value') ?? ''}" found${str(c, 'foundIn') ? ` in ${str(c, 'foundIn')}` : ''}`
          : `verbatim text "${str(c, 'value') ?? ''}" not found${str(c, 'where') ? ` in ${str(c, 'where')}` : ''}`,
      }),
    },
  ],
  c1: [
    {
      key: 'topOffenders',
      kind: 'lint',
      alwaysFailure: true,
      build: (o) => {
        const file = cleanPath(str(o, 'file')) ?? 'file';
        const errors = typeof o['errors'] === 'number' ? o['errors'] : 0;
        const warnings = typeof o['warnings'] === 'number' ? o['warnings'] : 0;
        const parts: string[] = [];
        if (errors > 0) parts.push(`${errors} error(s)`);
        if (warnings > 0) parts.push(`${warnings} warning(s)`);
        const counts = parts.length > 0 ? parts.join(', ') : 'lint issues';
        return { kind: 'lint', id: file, message: `${counts} in ${file}` };
      },
    },
  ],
  c6: [
    {
      key: 'hotspots',
      kind: 'complexity',
      alwaysFailure: true,
      build: (o) => {
        const file = cleanPath(str(o, 'file')) ?? 'file';
        return {
          kind: 'complexity',
          id: file,
          message: `cognitive complexity ${asText(o['complexity'])} at ${file}:${asText(o['line'])}`,
        };
      },
    },
  ],
  c9: [
    {
      key: 'outcomes',
      kind: 'seo-check',
      build: (o) => ({
        kind: 'seo-check',
        id: str(o, 'check') ?? str(o, 'name') ?? str(o, 'id'),
        message:
          str(o, 'detail') ??
          str(o, 'note') ??
          `${str(o, 'check') ?? 'SEO check'} ${itemPassed(o) ? 'passed' : 'failed'}`,
      }),
    },
  ],
  c2: [
    {
      key: 'topErrors',
      kind: 'type-error',
      stringList: true,
      // topErrors are preformatted "file:line code: message" strings; clean the
      // leading path token so it reads source-relative.
      build: (e) => ({ kind: 'type-error', message: cleanPath(asText(e)) ?? asText(e) }),
    },
  ],
  v2: [
    {
      key: 'checks',
      kind: 'design-check',
      build: (c) => ({
        kind: 'design-check',
        id: str(c, 'name'),
        message: str(c, 'detail') ?? `${str(c, 'name') ?? 'design check'} ${itemPassed(c) ? 'passed' : 'failed'}`,
      }),
    },
  ],
  v4: [
    {
      key: 'checks',
      kind: 'responsive-check',
      build: (c) => ({
        kind: 'responsive-check',
        id: str(c, 'name'),
        message: str(c, 'detail') ?? `${str(c, 'name') ?? 'responsive check'} ${itemPassed(c) ? 'passed' : 'failed'}`,
      }),
    },
  ],
  s3: [
    {
      key: 'topVulnerabilities',
      kind: 'vuln',
      alwaysFailure: true,
      build: (v) => ({
        kind: 'vuln',
        id: str(v, 'name'),
        severity: str(v, 'severity'),
        message: `${str(v, 'severity') ?? ''} vulnerability in ${str(v, 'name') ?? 'package'}`.trim(),
      }),
    },
  ],
};

/** Pull every itemized result (passing and failing) out of a scorer's `details`. */
function extractItems(result: ScorerResult): CheckItem[] {
  const details = result.details ?? {};
  const items: CheckItem[] = [];

  const specs = LIST_SPECS[result.scorer] ?? [];
  for (const spec of specs) {
    const arr = details[spec.key];
    if (!Array.isArray(arr)) continue;
    if (spec.stringList) {
      for (const raw of arr) {
        items.push({ kind: spec.kind, passed: false, message: asText(raw) });
      }
      continue;
    }
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const passed = spec.alwaysFailure ? false : itemPassed(item);
      items.push({ ...spec.build(item), passed });
    }
  }

  // c3 (axe) only exposes aggregate impactCounts, not a per-violation list.
  // Emit one failing item per impact level with a non-zero count.
  if (result.scorer === 'c3') {
    const counts = details['impactCounts'];
    if (counts && typeof counts === 'object') {
      for (const [impact, n] of Object.entries(counts as Record<string, unknown>)) {
        if (typeof n === 'number' && n > 0) {
          items.push({ kind: 'a11y', passed: false, severity: impact, message: `${n} ${impact} accessibility violation(s)` });
        }
      }
    }
  }

  // s1 nests its findings under details.secrets.findings; surface them too.
  if (result.scorer === 's1') {
    const secrets = details['secrets'];
    if (secrets && typeof secrets === 'object') {
      const findings = (secrets as Record<string, unknown>)['findings'];
      if (Array.isArray(findings)) {
        for (const raw of findings) {
          if (!raw || typeof raw !== 'object') continue;
          const f = raw as Record<string, unknown>;
          items.push({
            kind: 'secret',
            passed: false,
            id: str(f, 'ruleId'),
            message: `secret matched rule "${str(f, 'ruleId') ?? 'unknown'}"${str(f, 'file') ? ` in ${cleanPath(str(f, 'file'))}` : ''}`,
          });
        }
      }
    }
  }

  return items;
}

/** Top-level skip/error note when a scorer produced no score. */
function noteOf(result: ScorerResult): string | undefined {
  const details = result.details ?? {};
  return result.notes ?? str(details, 'note') ?? str(details, 'error');
}

/**
 * Build the itemized detail report for a single scorer. Always returns the full
 * per-item breakdown (passing and failing) so consumers can see exactly which
 * items contributed to a non-perfect score.
 */
export function buildScorerDetailReport(result: ScorerResult): ScorerDetailReport {
  const status = statusOf(result);
  const items = extractItems(result);
  const passedItems = items.filter((i) => i.passed).length;
  return {
    scorer: result.scorer,
    status,
    passed: result.passed,
    score: result.score,
    ...(noteOf(result) ? { note: noteOf(result) } : {}),
    passedItems,
    totalItems: items.length,
    items,
  };
}

/** Build itemized detail reports for every scorer in a run, keyed by scorer id. */
export function buildRunDetailReports(
  scores: Record<string, ScorerResult>,
): Record<string, ScorerDetailReport> {
  const out: Record<string, ScorerDetailReport> = {};
  for (const [id, result] of Object.entries(scores)) {
    out[id] = buildScorerDetailReport(result);
  }
  return out;
}

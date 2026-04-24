import { AxeBuilder } from '@axe-core/playwright';
import type { Result as AxeViolation } from 'axe-core';
import { writeJson } from '../../core/artifact.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C3_VERSION = '0.1.0';

export async function runC3(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  try {
    const axe = new AxeBuilder({ page: ctx.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
    const result = await axe.analyze();
    await writeJson(ctx.paths.axe, result);

    const nodeCount = await ctx.page.locator('*').count().catch(() => 0);
    const violations = result.violations.length;
    const violatingNodes = result.violations.reduce(
      (sum: number, v: AxeViolation) => sum + v.nodes.length,
      0,
    );
    const violationsPer1k = nodeCount > 0 ? (violatingNodes / nodeCount) * 1000 : 0;
    const score = violationsPer1k === 0 ? 1 : Math.max(0, 1 - violationsPer1k / 50);
    const passed = violations === 0;

    return {
      scorer: 'c3',
      version: C3_VERSION,
      passed,
      score,
      details: {
        violationsCount: violations,
        violatingNodes,
        totalNodes: nodeCount,
        violationsPer1kNodes: Number(violationsPer1k.toFixed(3)),
        impactCounts: countByImpact(result.violations),
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'c3',
      version: C3_VERSION,
      passed: null,
      score: null,
      details: {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function countByImpact(violations: readonly { impact?: string | null }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of violations) {
    const key = v.impact ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

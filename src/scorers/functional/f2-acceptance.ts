import type { Locator, Page } from '@playwright/test';
import type { AcceptanceCriterion } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const F2_VERSION = '0.1.0';

const VISIBILITY_TIMEOUT_MS = 5_000;

type BoundingBoxAxis = 'x' | 'y' | 'width' | 'height';

interface CriterionOutcome {
  id: string;
  kind: 'must' | 'should';
  passed: boolean;
  note?: string;
}

export async function runF2(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const outcomes: CriterionOutcome[] = [];

  for (const c of ctx.prompt.mustHave) {
    outcomes.push(await evalCriterion(ctx.page, c, 'must'));
  }
  for (const c of ctx.prompt.shouldHave) {
    outcomes.push(await evalCriterion(ctx.page, c, 'should'));
  }

  const mustTotal = ctx.prompt.mustHave.length;
  const mustPassed = outcomes.filter((o) => o.kind === 'must' && o.passed).length;
  const shouldTotal = ctx.prompt.shouldHave.length;
  const shouldPassed = outcomes.filter((o) => o.kind === 'should' && o.passed).length;

  const weightedTotal = mustTotal + 0.5 * shouldTotal;
  const weightedPassed = mustPassed + 0.5 * shouldPassed;
  const score = weightedTotal === 0 ? null : weightedPassed / weightedTotal;
  const passed = mustTotal === 0 ? null : mustPassed === mustTotal;

  return {
    scorer: 'f2',
    version: F2_VERSION,
    passed,
    score,
    details: {
      mustTotal,
      mustPassed,
      shouldTotal,
      shouldPassed,
      weightedScore: score,
      criteria: outcomes,
      elapsedMs: Date.now() - start,
    },
  };
}

async function evalCriterion(
  page: Page,
  c: AcceptanceCriterion,
  kind: 'must' | 'should',
): Promise<CriterionOutcome> {
  try {
    const locator = buildLocator(page, c.locator);
    const assertOk = await runAssertion(locator, c.assert);
    if (!assertOk) {
      return { id: c.id, kind, passed: false, note: `assertion failed: ${c.assert}` };
    }
    if (c.custom) {
      const customOk = await runCustom(locator, c.custom);
      return customOk
        ? { id: c.id, kind, passed: true }
        : { id: c.id, kind, passed: false, note: `custom failed: ${c.custom}` };
    }
    return { id: c.id, kind, passed: true };
  } catch (err) {
    return {
      id: c.id,
      kind,
      passed: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildLocator(page: Page, expr: string): Locator {
  const fn = new Function('page', `return page.${expr};`) as (p: Page) => Locator;
  const result = fn(page);
  if (!result || typeof (result as Locator).first !== 'function') {
    throw new Error(`Invalid locator expression: ${expr}`);
  }
  return result;
}

async function runAssertion(locator: Locator, assert: string): Promise<boolean> {
  if (assert === 'toBeVisible') {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: VISIBILITY_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
  const countMatch = assert.match(/^toHaveCount\((\d+)\)$/);
  if (countMatch) {
    const expected = Number.parseInt(countMatch[1]!, 10);
    const actual = await locator.count();
    return actual === expected;
  }
  const countAtLeastMatch = assert.match(/^toHaveCountAtLeast\((\d+)\)$/);
  if (countAtLeastMatch) {
    const expected = Number.parseInt(countAtLeastMatch[1]!, 10);
    const actual = await locator.count();
    return actual >= expected;
  }
  throw new Error(`Unsupported assertion: ${assert}`);
}

async function runCustom(locator: Locator, expr: string): Promise<boolean> {
  const bboxMatch = expr.match(/^boundingBox\.(x|y|width|height)\s*(<=|>=|<|>|===|==)\s*(-?\d+)$/);
  if (bboxMatch) {
    const [, axisRaw, op, numStr] = bboxMatch;
    const axis = axisRaw as BoundingBoxAxis;
    const box = await locator.first().boundingBox();
    if (!box) return false;
    const actual = box[axis];
    const target = Number.parseInt(numStr!, 10);
    switch (op) {
      case '<':
        return actual < target;
      case '>':
        return actual > target;
      case '<=':
        return actual <= target;
      case '>=':
        return actual >= target;
      case '==':
      case '===':
        return actual === target;
      default:
        return false;
    }
  }
  throw new Error(`Unsupported custom expression: ${expr}`);
}

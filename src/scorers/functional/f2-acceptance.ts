import type { Locator, Page } from '@playwright/test';
import type { AcceptanceCriterion, SetupAction } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const F2_VERSION = '0.2.0';

const VISIBILITY_TIMEOUT_MS = 5_000;
// Used by setup actions (fill/click/press/waitFor) — same budget as
// VISIBILITY_TIMEOUT_MS so a missing element doesn't hang the run.
const SETUP_LOCATOR_TIMEOUT_MS = 5_000;
// page.evaluate() during setup gets a longer budget because some prompts
// chain reload + DOM waits via the script (rare but legal).
const SETUP_EVALUATE_TIMEOUT_MS = 10_000;

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
    if (c.setup && c.setup.length > 0) {
      const setupErr = await runSetup(page, c.setup);
      if (setupErr) {
        return { id: c.id, kind, passed: false, note: `setup failed: ${setupErr}` };
      }
    }
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

// Runs setup actions sequentially against the page. Returns an error string
// describing the first action that failed, or null on success. Used by stateful
// prompts to drive the page into a specific state before the locator runs.
async function runSetup(page: Page, actions: SetupAction[]): Promise<string | null> {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const label = `step ${i + 1} (${action.kind})`;
    try {
      await runSetupStep(page, action);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `${label}: ${msg.slice(0, 200)}`;
    }
  }
  return null;
}

async function runSetupStep(page: Page, action: SetupAction): Promise<void> {
  switch (action.kind) {
    case 'evaluate': {
      // The expression is passed as a string so prompt authors can write
      // either `() => localStorage.clear()` (a function) or
      // `localStorage.clear()` (a statement). Playwright's page.evaluate
      // accepts a string and wraps it as the body of a browser-side function,
      // so both forms work without us reconstructing the function ourselves.
      // 10s budget guards against accidental infinite loops.
      await Promise.race([
        page.evaluate(action.expr),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`evaluate timed out after ${SETUP_EVALUATE_TIMEOUT_MS}ms`)), SETUP_EVALUATE_TIMEOUT_MS),
        ),
      ]);
      return;
    }
    case 'fill': {
      const locator = buildLocator(page, action.locator);
      await locator.first().waitFor({ state: 'visible', timeout: SETUP_LOCATOR_TIMEOUT_MS });
      await locator.first().fill(action.value);
      return;
    }
    case 'click': {
      const locator = buildLocator(page, action.locator);
      await locator.first().waitFor({ state: 'visible', timeout: SETUP_LOCATOR_TIMEOUT_MS });
      await locator.first().click();
      return;
    }
    case 'press': {
      const locator = buildLocator(page, action.locator);
      await locator.first().waitFor({ state: 'visible', timeout: SETUP_LOCATOR_TIMEOUT_MS });
      await locator.first().press(action.key);
      return;
    }
    case 'reload': {
      await page.reload({ waitUntil: 'domcontentloaded' });
      return;
    }
    case 'waitFor': {
      const locator = buildLocator(page, action.locator);
      await locator.first().waitFor({ state: 'visible', timeout: SETUP_LOCATOR_TIMEOUT_MS });
      return;
    }
  }
}

// Expose `page`'s locator factories as bare names inside the expression so
// chained matchers like `.or(getByRole(...))` and `.filter({ has: locator(...) })`
// resolve against the same page. Without this, the second `getByRole` in
// `getByRole('button',...).or(getByRole('link',...))` would throw
// `ReferenceError: getByRole is not defined` at runtime.
const LOCATOR_FACTORIES = ['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'locator'] as const;

function buildLocator(page: Page, expr: string): Locator {
  const factoryArgs = LOCATOR_FACTORIES.map((name) => `${name} = page.${name}.bind(page)`).join(', ');
  const body = `const ${factoryArgs}; return page.${expr};`;
  const fn = new Function('page', body) as (p: Page) => Locator;
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

import type { Locator, Page } from '@playwright/test';
import type { AcceptanceCriterion, SetupAction } from '../../core/types.ts';
import type { Account } from '../../core/backend.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';
import { revealLoginForm, login, logout } from '../backend/login.ts';

// Credentials available to `login` setup actions, or null on a submission with
// no backend block (auth-gated criteria then fail rather than throw).
interface SetupAccounts {
  a: Account;
  b: Account;
}

// 0.4.0 — adds the `login` / `logout` setup actions, enabling auth-gated
// acceptance criteria against the authenticated dashboard.
export const F2_VERSION = '0.4.0';

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

  const url = ctx.submission.artifactUrl;
  const backend = ctx.submission.backend;
  const accounts: SetupAccounts | null = backend
    ? { a: backend.userA, b: backend.userB }
    : null;
  for (const c of ctx.prompt.mustHave) {
    outcomes.push(await evalCriterion(ctx.page, c, 'must', url, accounts));
  }
  for (const c of ctx.prompt.shouldHave) {
    outcomes.push(await evalCriterion(ctx.page, c, 'should', url, accounts));
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
  url: string,
  accounts: SetupAccounts | null,
): Promise<CriterionOutcome> {
  try {
    if (c.setup && c.setup.length > 0) {
      const setupErr = await runSetup(page, c.setup, url, accounts);
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
      const customOk = await runCustom(page, locator, c.custom);
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
async function runSetup(
  page: Page,
  actions: SetupAction[],
  url: string,
  accounts: SetupAccounts | null,
): Promise<string | null> {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const label = `step ${i + 1} (${action.kind})`;
    try {
      await runSetupStep(page, action, url, accounts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `${label}: ${msg.slice(0, 200)}`;
    }
  }
  return null;
}

async function runSetupStep(
  page: Page,
  action: SetupAction,
  url: string,
  accounts: SetupAccounts | null,
): Promise<void> {
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
      // SPAs mount their UI after domcontentloaded — give the network a moment
      // to settle so the post-reload DOM is the rendered app, not the shell.
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
      return;
    }
    case 'waitFor': {
      const locator = buildLocator(page, action.locator);
      await locator.first().waitFor({ state: 'visible', timeout: SETUP_LOCATOR_TIMEOUT_MS });
      return;
    }
    case 'revealLoginForm': {
      // Click through a marketing splash to the actual login form (a "Sign In"
      // button at `/` and the form at /login). No-op when the form is already
      // on the page. Shared with the F7/F8/S4 login driver.
      await revealLoginForm(page, url);
      return;
    }
    case 'login': {
      // Authenticate so a criterion can assert against the logged-in dashboard.
      // Reuses the F7/F8/S4 driver, so it inherits the splash/staged-form/OTP
      // handling and the per-account session cache (later logins in the same
      // run replay the cached session instead of re-driving the form).
      if (!accounts) {
        throw new Error('login setup requires a `backend` block on the submission');
      }
      const account = action.account === 'b' ? accounts.b : accounts.a;
      const outcome = await login(page, url, account);
      if (!outcome.ok) {
        throw new Error(`login failed: ${outcome.reason ?? 'unknown reason'}`);
      }
      return;
    }
    case 'logout': {
      // Click the app's own log-out control. Throws when no such control
      // exists, which is itself the finding for a "log out is present" check.
      const ok = await logout(page);
      if (!ok) throw new Error('no log-out control found on the page');
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
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
    // Exact count: wait until the count stabilises at the expected value (the
    // first element appearing is enough to anchor the wait), then compare.
    if (expected > 0) {
      await locator.first().waitFor({ state: 'attached', timeout: VISIBILITY_TIMEOUT_MS }).catch(() => undefined);
    }
    const actual = await locator.count();
    return actual === expected;
  }
  const countAtLeastMatch = assert.match(/^toHaveCountAtLeast\((\d+)\)$/);
  if (countAtLeastMatch) {
    const expected = Number.parseInt(countAtLeastMatch[1]!, 10);
    // Auto-retry for SPA mount: wait for the locator to attach before counting,
    // so a count run immediately after a reload doesn't race the framework's
    // re-render and spuriously see 0.
    if (expected > 0) {
      await locator.first().waitFor({ state: 'attached', timeout: VISIBILITY_TIMEOUT_MS }).catch(() => undefined);
    }
    const actual = await locator.count();
    return actual >= expected;
  }
  throw new Error(`Unsupported assertion: ${assert}`);
}

// Pixel tolerance for sticky checks. After scrolling, a sticky/fixed element may
// shift a few px due to subpixel rounding or scroll-state styling (e.g. nav adds
// a border on scroll). 50px is generous enough to absorb that without admitting
// a non-sticky element that scrolls fully out of frame.
const STICKY_TOP_TOLERANCE_PX = 50;
const STICKY_SCROLL_DISTANCE_PX = 600;
const STICKY_SETTLE_MS = 300;

async function runCustom(page: Page, locator: Locator, expr: string): Promise<boolean> {
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
  if (expr === 'stickyAfterScroll') {
    return checkStickyAfterScroll(page, locator);
  }
  throw new Error(`Unsupported custom expression: ${expr}`);
}

// Verifies an element stays pinned near the top of the viewport after the page
// is scrolled. Works for both `position: sticky` and `position: fixed`. The
// element must start near the top (initialTop <= tolerance) and remain near
// the top after a scroll of STICKY_SCROLL_DISTANCE_PX.
async function checkStickyAfterScroll(page: Page, locator: Locator): Promise<boolean> {
  const element = locator.first();
  const initialBox = await element.boundingBox();
  if (!initialBox) return false;
  if (initialBox.y > STICKY_TOP_TOLERANCE_PX) return false;

  const originalScrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
  try {
    await page.evaluate((y) => window.scrollTo(0, y), STICKY_SCROLL_DISTANCE_PX);
    await page.waitForTimeout(STICKY_SETTLE_MS);
    const scrolledBox = await element.boundingBox();
    if (!scrolledBox) return false;
    return scrolledBox.y <= STICKY_TOP_TOLERANCE_PX;
  } finally {
    await page.evaluate((y) => window.scrollTo(0, y), originalScrollY).catch(() => undefined);
    await page.waitForTimeout(STICKY_SETTLE_MS).catch(() => undefined);
  }
}

import type { Page } from '@playwright/test';
import type { Account } from '../../core/backend.ts';

// Browser login driver for F7/F8. Drives the deployed app's login form using
// resilient role/label heuristics (the prompt doesn't declare form selectors).
// Best-effort: returns whether login appears to have succeeded.

export interface LoginOutcome {
  ok: boolean;
  reason?: string;
}

// Heuristic email/password/submit locators, tried in order of specificity.
async function fillEmail(page: Page, value: string): Promise<boolean> {
  const candidates = [
    page.getByLabel(/email/i),
    page.getByPlaceholder(/email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name="email" i]'),
  ];
  for (const loc of candidates) {
    if (await loc.count().then((c) => c > 0).catch(() => false)) {
      await loc.first().fill(value).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function fillPassword(page: Page, value: string): Promise<boolean> {
  const loc = page.locator('input[type="password"]');
  if (await loc.count().then((c) => c > 0).catch(() => false)) {
    await loc.first().fill(value).catch(() => undefined);
    return true;
  }
  return false;
}

async function submit(page: Page): Promise<void> {
  const buttons = [
    page.getByRole('button', { name: /log ?in|sign ?in|continue|submit/i }),
    page.locator('button[type="submit"]'),
    page.getByRole('button'),
  ];
  for (const loc of buttons) {
    if (await loc.count().then((c) => c > 0).catch(() => false)) {
      await loc.first().click().catch(() => undefined);
      return;
    }
  }
  // Fallback: press Enter in the password field.
  await page.locator('input[type="password"]').first().press('Enter').catch(() => undefined);
}

// Returns true if the page no longer shows a password field (proxy for "left
// the login screen"). Imperfect but resilient across markup variations.
async function looksLoggedIn(page: Page): Promise<boolean> {
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const stillHasPassword = await page
    .locator('input[type="password"]')
    .count()
    .then((c) => c > 0)
    .catch(() => true);
  return !stillHasPassword;
}

export async function login(page: Page, url: string, account: Account): Promise<LoginOutcome> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    // Client-side apps (React/Modelence/etc.) mount the login form after the
    // initial HTML loads. Wait for a password field to appear before deciding
    // the form is absent — without this, a fresh context can check too early and
    // spuriously fail (the form is there, just not mounted yet).
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    const hasEmail = await fillEmail(page, account.email);
    const hasPassword = await fillPassword(page, account.password);
    if (!hasEmail || !hasPassword) {
      return { ok: false, reason: 'could not locate email/password fields on the login screen' };
    }
    await submit(page);
    const ok = await looksLoggedIn(page);
    return ok ? { ok: true } : { ok: false, reason: 'still on login screen after submitting credentials' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Fill an input and verify the value registered. `fill` sets the DOM value and
// fires an input event, which most controlled components accept — but if the
// value didn't stick (hydration race, custom onChange), retype it key-by-key
// with pressSequentially so React/Vue see real keystrokes.
async function fillVerified(locator: import('@playwright/test').Locator, value: string): Promise<void> {
  await locator.fill(value).catch(() => undefined);
  const stuck = await locator.inputValue().then((v) => v === value).catch(() => false);
  if (stuck) return;
  await locator.click().catch(() => undefined);
  await locator.fill('').catch(() => undefined);
  await locator.pressSequentially(value, { delay: 15 }).catch(() => undefined);
}

// Fill and submit the deployed app's "new contact" form. Fills every field the
// form exposes (name / email / company) — some apps require all of them before
// the submit fires, so a name-only fill silently no-ops. `name` carries the
// unique marker the caller asserts on afterward. Returns true if the form was
// found and submitted (not whether the record persisted — caller checks that).
export async function createContact(page: Page, name: string): Promise<boolean> {
  const nameField = page
    .getByLabel(/name/i)
    .or(page.getByPlaceholder(/name/i))
    .or(page.locator('input[name="name" i]'));
  // Wait for the field to be visible AND editable — a freshly navigated SPA can
  // render the form before React attaches its handlers, so an early fill sets
  // the DOM value but the controlled component ignores it and the submit no-ops.
  try {
    await nameField.first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    return false;
  }
  // Fill, then verify it stuck; if the controlled input didn't register the
  // value, fall back to typing it key-by-key (which fires React onChange).
  await fillVerified(nameField.first(), name);

  const emailField = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
  if (await emailField.count().then((c) => c > 0).catch(() => false)) {
    // Derive a valid email local-part — strip anything that isn't allowed (e.g.
    // spaces in "Sample Contact"), which would otherwise trip the field's email
    // validation and block the submit.
    const localPart = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^\.|\.$/g, '') || 'contact';
    await fillVerified(emailField.first(), `${localPart}@bench.test`);
  }
  // Company (and any other common contact field) — fill if present; some forms
  // require it before the submit button activates.
  const companyField = page.getByLabel(/company|organization|organisation/i).or(page.getByPlaceholder(/company|organization/i));
  if (await companyField.count().then((c) => c > 0).catch(() => false)) {
    await fillVerified(companyField.first(), 'BenchCo');
  }

  const addBtn = page.getByRole('button', { name: /add contact|new contact|add|create|save|submit/i });
  if (await addBtn.count().then((c) => c > 0).catch(() => false)) {
    await addBtn.first().click().catch(() => undefined);
  } else {
    await nameField.first().press('Enter').catch(() => undefined);
  }
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  return true;
}

// Delete every contact in the signed-in user's list via the app's OWN per-row
// delete control (the ✕ / "delete" / "remove" button the prompt requires) — the
// harness never asks the app for a special bulk-delete affordance. Used for test
// teardown (so scoring doesn't litter accounts) and to reveal the empty state
// for the screenshot judges. Best-effort: clicks the first delete control,
// waits, repeats until the list is empty or a safety cap is hit. Returns the
// number of records deleted.
export async function deleteAllContacts(page: Page, cap = 50): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < cap; i++) {
    const delBtn = page
      .getByRole('button', { name: /^(✕|×|x|delete|remove|trash)$/i })
      .or(page.getByRole('button', { name: /delete|remove/i }))
      .or(page.getByLabel(/delete|remove/i));
    const count = await delBtn.count().catch(() => 0);
    if (count === 0) break;
    // Accept a confirm dialog if the app pops one.
    page.once('dialog', (d) => d.accept().catch(() => undefined));
    await delBtn.first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    deleted++;
  }
  return deleted;
}

export async function logout(page: Page): Promise<boolean> {
  const loc = page
    .getByRole('button', { name: /log ?out|sign ?out/i })
    .or(page.getByRole('link', { name: /log ?out|sign ?out/i }));
  if (await loc.count().then((c) => c > 0).catch(() => false)) {
    await loc.first().click().catch(() => undefined);
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
}

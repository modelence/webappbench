import type { ScorerContext, ScorerResult } from '../types.ts';
import { login, logout, createContact } from '../backend/login.ts';

export const F7_VERSION = '0.1.0';

// F7 — Auth round-trip. Log in → create a record → log out → log in again →
// the record persists. Catches broken sessions, broken signup forms, and
// data that doesn't actually persist server-side. Backend-track only.
//
// Uses a unique marker per run so the assertion can't pass on seed data.

function uniqueMarker(runIdx: number): string {
  // No Math.random/Date in scorers' deterministic path is not required here
  // (scorers may use time), but a stable-per-run marker is fine and debuggable.
  return `F7_CONTACT_${runIdx}_${Date.now().toString(36)}`;
}

export async function runF7(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const backend = ctx.submission.backend;

  if (!backend) {
    return naResult('no backend block in submission', start);
  }

  const userA = backend.userA;
  const url = ctx.submission.artifactUrl;
  const page = ctx.page;
  const marker = uniqueMarker(ctx.submission.runIdx);
  const steps: Array<{ step: string; ok: boolean; note?: string }> = [];

  // 1. Log in as A.
  const login1 = await login(page, url, userA);
  steps.push({ step: 'initial_login', ok: login1.ok, note: login1.reason });
  if (!login1.ok) return failResult(steps, start, 'initial login failed');

  // 2. Create a contact with the unique marker as its name.
  const created = await createContact(page, marker);
  steps.push({ step: 'create_contact', ok: created, note: created ? undefined : 'new-contact form not found' });

  // 3. Verify it appears now.
  const visibleNow = await page.getByText(marker, { exact: false }).count().then((c) => c > 0).catch(() => false);
  steps.push({ step: 'visible_after_create', ok: visibleNow });

  // 4. Log out.
  const loggedOut = await logout(page);
  steps.push({ step: 'logout', ok: loggedOut, note: loggedOut ? undefined : 'log-out control not found' });

  // 5. Log in again (fresh navigation).
  const login2 = await login(page, url, userA);
  steps.push({ step: 'relogin', ok: login2.ok, note: login2.reason });
  if (!login2.ok) return failResult(steps, start, 're-login failed');

  // 6. The contact persists across the session.
  const persisted = await page.getByText(marker, { exact: false }).count().then((c) => c > 0).catch(() => false);
  steps.push({ step: 'persists_after_relogin', ok: persisted });

  // The round-trip passes only if the record survived create → logout → re-login.
  const passed = created && persisted;
  const passedSteps = steps.filter((s) => s.ok).length;
  const score = passed ? 1 : passedSteps / steps.length;

  // No teardown here — a single account cleanup runs at the end of the whole
  // submission (see orchestrate) so per-scorer deletes can't wipe each other's
  // in-flight test data.

  return {
    scorer: 'f7',
    version: F7_VERSION,
    passed,
    score,
    details: { marker, steps, passedSteps, totalSteps: steps.length, elapsedMs: Date.now() - start },
  };
}

function naResult(note: string, start: number): ScorerResult {
  return { scorer: 'f7', version: F7_VERSION, passed: null, score: null, details: { note, elapsedMs: Date.now() - start }, notes: note };
}

function failResult(steps: unknown[], start: number, note: string): ScorerResult {
  const arr = steps as Array<{ ok: boolean }>;
  return {
    scorer: 'f7',
    version: F7_VERSION,
    passed: false,
    score: arr.filter((s) => s.ok).length / Math.max(1, arr.length),
    details: { steps, note, elapsedMs: Date.now() - start },
  };
}

import type { Browser } from '@playwright/test';
import type { ScorerContext, ScorerResult } from '../types.ts';
import { login, createContact, applyCachedSession } from '../backend/login.ts';

export const F8_VERSION = '0.1.0';

// F8 — Cross-session backend persistence. Create a record in browser context A,
// then open the SAME url in a fresh incognito context B (clean storage), log in
// as the same user, and verify the record is present. A localStorage-only app
// fails this (context B has empty storage); a real-backend app passes. This is
// the discriminator between "ships a backend" and "fakes one in the browser".
//
// Backend-track only. Independent of F7 — F8 creates its own record in a fresh
// context so the two scorers don't interfere.

export async function runF8(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const backend = ctx.submission.backend;
  if (!backend) {
    return naResult('no backend block in submission', start);
  }

  const userA = backend.userA;
  const url = ctx.submission.artifactUrl;
  const marker = `F8_CONTACT_${ctx.submission.runIdx}_${Date.now().toString(36)}`;
  const steps: Array<{ step: string; ok: boolean; note?: string }> = [];
  const browser: Browser = ctx.browser;

  // Context A: its OWN fresh context — do NOT reuse ctx.page, which a prior
  // scorer (F7) may have left authenticated, landing on the dashboard instead
  // of the login screen and breaking the login form lookup.
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await applyCachedSession(contextA, userA);
    const pageA = await contextA.newPage();
    const loginA = await login(pageA, url, userA);
    steps.push({ step: 'context_a_login', ok: loginA.ok, note: loginA.reason });
    if (!loginA.ok) return failResult(steps, start, 'context A login failed');

    const created = await createContact(pageA, marker);
    steps.push({ step: 'context_a_create', ok: created, note: created ? undefined : 'new-contact form not found' });
    if (!created) return failResult(steps, start, 'could not create record in context A');

    // Context B: a second fresh incognito context with clean storage.
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      // Cookies-only: restore the auth session so context B doesn't re-trigger
      // the OTP challenge, but keep its localStorage clean so a localStorage-only
      // "backend" can't fake cross-session persistence (that's what F8 detects).
      await applyCachedSession(contextB, userA, { cookiesOnly: true });
      const pageB = await contextB.newPage();
      const loginB = await login(pageB, url, userA);
      steps.push({ step: 'context_b_login', ok: loginB.ok, note: loginB.reason });
      if (!loginB.ok) return failResult(steps, start, 'context B login failed');

      // The record created in A must be visible in the fresh context B.
      const visibleInB = await pageB.getByText(marker, { exact: false }).count().then((c) => c > 0).catch(() => false);
      steps.push({ step: 'record_visible_in_context_b', ok: visibleInB });

      const passed = visibleInB;
      // No teardown here — a single account cleanup runs at the end of the whole
      // submission (see orchestrate).
      return {
        scorer: 'f8',
        version: F8_VERSION,
        passed,
        score: passed ? 1 : steps.filter((s) => s.ok).length / steps.length,
        details: {
          marker,
          steps,
          // The headline signal: did a record cross browser contexts (real
          // backend) or vanish (localStorage masquerading as a backend)?
          crossedSessions: passed,
          elapsedMs: Date.now() - start,
        },
      };
    } finally {
      await contextB.close().catch(() => undefined);
    }
  } finally {
    await contextA.close().catch(() => undefined);
  }
}

function naResult(note: string, start: number): ScorerResult {
  return { scorer: 'f8', version: F8_VERSION, passed: null, score: null, details: { note, elapsedMs: Date.now() - start }, notes: note };
}

function failResult(steps: unknown[], start: number, note: string): ScorerResult {
  const arr = steps as Array<{ ok: boolean }>;
  return {
    scorer: 'f8',
    version: F8_VERSION,
    passed: false,
    score: arr.filter((s) => s.ok).length / Math.max(1, arr.length),
    details: { steps, note, elapsedMs: Date.now() - start },
  };
}

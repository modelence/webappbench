import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Page } from '@playwright/test';
import type { Account } from '../../core/backend.ts';

// Browser login driver for F7/F8. Drives the deployed app's login form using
// resilient role/label heuristics (the prompt doesn't declare form selectors).
// Best-effort: returns whether login appears to have succeeded.

export interface LoginOutcome {
  ok: boolean;
  reason?: string;
}

// Per-account authenticated storage state (cookies + localStorage), captured
// after a successful login and reused for the rest of the run. This matters for
// apps with new-device OTP verification: each fresh context would otherwise
// trigger a new emailed code, so without reuse the operator would be prompted
// ~9 times per submission (dashboard ×2, S4, F7 ×2, F8 ×2, cleanup ×2). With
// reuse we prompt once per account; later logins replay the trusted session and
// skip the challenge entirely. Keyed by account email. Process-lifetime only.
type StorageState = Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>;
const sessionCache = new Map<string, StorageState>();

// Seed a freshly-opened context with a cached authenticated session, if we have
// one for this account, BEFORE navigating. Call this right after newContext().
// Returns true if a session was injected (caller can then verify it's still
// valid by loading the app and checking for a logged-in state).
export async function applyCachedSession(
  context: import('@playwright/test').BrowserContext,
  account: Account,
  opts: { cookiesOnly?: boolean } = {},
): Promise<boolean> {
  const state = sessionCache.get(account.email);
  if (!state) return false;
  await context.addCookies(state.cookies).catch(() => undefined);
  // F8 (cross-session persistence) must keep context B's storage clean so a
  // localStorage-faked backend can't masquerade as real persistence. cookiesOnly
  // restores just the auth cookies (enough to satisfy a real server session)
  // without replaying any app localStorage.
  if (opts.cookiesOnly) return true;
  // localStorage is restored per-origin via addInitScript so it's present
  // before the app's first script runs.
  for (const origin of state.origins) {
    await context
      .addInitScript((entries: Array<{ name: string; value: string }>) => {
        for (const { name, value } of entries) {
          try {
            window.localStorage.setItem(name, value);
          } catch {
            // origin mismatch / storage disabled — ignore
          }
        }
      }, origin.localStorage)
      .catch(() => undefined);
  }
  return true;
}

// Save the current context's authenticated session into the cache, keyed by
// account email. Called after a successful login so later logins this run reuse
// it. Best-effort — a failure just means we'll drive the form again next time.
async function cacheSession(page: Page, account: Account): Promise<void> {
  const state = await page.context().storageState();
  sessionCache.set(account.email, state);
}

// Whether we hold a cached authenticated session for this account (populated by
// a prior successful login this run).
function hasCachedSession(account: Account): boolean {
  return sessionCache.has(account.email);
}

// True when the page currently shows the authenticated dashboard — detected
// POSITIVELY by its own controls (logout, create-contact affordance, list/empty
// markers), never by mere absence of a splash (a 404 also lacks the splash).
async function isOnDashboard(page: Page): Promise<boolean> {
  const markers = page
    .getByRole('button', { name: /log ?out|sign ?out/i })
    .or(page.getByRole('link', { name: /log ?out|sign ?out/i }))
    .or(page.getByRole('button', { name: /add contact|new contact|add|create|save/i }))
    .or(page.getByText(/new contact|add contact|no contacts yet|your contacts|directory/i));
  return markers.count().then((c) => c > 0).catch(() => false);
}

// After auth succeeds, make sure the page is actually on the authenticated
// dashboard — not a transitional Clerk page or the marketing splash that `/`
// serves to logged-out visitors. We navigate to the app root (the session
// cookie should now render the dashboard) and, if we still see a "Sign In"
// splash, give the SPA a moment to route/redirect. Best-effort: never throws,
// so a quirky app can't break the login result.
async function settleOnDashboard(page: Page, url: string): Promise<void> {
  // POSITIVE detection: the authenticated dashboard reliably shows a logout
  // control and/or the contact-management UI (a create form / "Add contact"
  // button). We detect the dashboard by its PRESENCE — not by the mere absence
  // of a splash, because a 404 page also lacks the splash and would otherwise be
  // mistaken for "logged in".
  const on404 = async (): Promise<boolean> => {
    const body = await page.locator('body').innerText().catch(() => '');
    // Cover the common soft-404 phrasings sitebuilders ship. Anything renders
    // "Uh-oh! This page doesn't exist (yet). Looks like "/x" isn't part of your
    // project" — which matches none of the classic "not found" strings, so a
    // narrow pattern would mistake it for a real page and strand login there.
    return /404|page not found|not found|forgot to add the page|doesn'?t exist|does not exist|isn'?t part of your|page you('?re| are) looking for/i.test(body);
  };
  // Wait for either the dashboard to appear (success) or a definitive 404. Up to
  // ~`rounds` seconds. Returns true if the dashboard was reached.
  const waitForDashboard = async (rounds: number): Promise<boolean> => {
    for (let i = 0; i < rounds; i++) {
      if (await isOnDashboard(page)) return true;
      if (await on404()) return false;
      await page.waitForTimeout(1000);
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
    }
    return isOnDashboard(page);
  };
  try {
    // 1) Wait IN PLACE for the app's OWN post-login redirect (this app uses
    //    Clerk's <Show when="signed-in"><Redirect to="/contacts">). Don't touch
    //    the URL yet — re-navigating too eagerly re-renders the splash and races
    //    the redirect.
    if (await waitForDashboard(10)) return;
    // 2) Not there yet. After a FRESH OTP login, Clerk has set the session cookie
    //    but the SPA still shows the logged-out splash because its client hasn't
    //    re-hydrated the session on this already-loaded page. A HARD RELOAD forces
    //    Clerk to re-read the cookie and mount as signed-in (this is exactly why
    //    the cached-session contexts, which load fresh, reach the dashboard while
    //    the OTP context doesn't). Try a few reloads, giving hydration time.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
      if (await waitForDashboard(6)) return;
    }
    // 3) Still stuck — navigate to the app ROOT first (many apps, e.g. Anything,
    //    render the dashboard at `/` itself), then fall back to common dashboard
    //    routes. ONLY accept one that actually renders the dashboard; a 404 is
    //    rejected (we never screenshot, or strand login on, a guessed route that
    //    doesn't exist — Anything serves a soft-404 at /contacts, /dashboard, …).
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return url.replace(/\/+$/, '');
      }
    })();
    for (const path of ['/', '/contacts', '/dashboard', '/app', '/home']) {
      await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      if (await waitForDashboard(3)) return;
    }
    // 4) Nothing rendered the dashboard. Return to root so we DON'T leave the
    //    page sitting on a 404 page that a caller would then screenshot — and
    //    give the root one more chance to mount the dashboard before giving up.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    await waitForDashboard(5);
  } catch {
    // best-effort — login already succeeded; downstream steps will surface any
    // dashboard-not-found condition with their own diagnostics.
  }
}

// True when the page shows a logged-in app rather than a login form / splash —
// no password field, no verification challenge, and the login affordance is
// gone. Used to short-circuit when a cached session was injected.
async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  const hasPassword = await page
    .locator('input[type="password"]')
    .count()
    .then((c) => c > 0)
    .catch(() => false);
  if (hasPassword) return false;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (VERIFICATION_CHALLENGE_RE.test(bodyText)) return false;
  // A 404 / error page is not a logged-in dashboard.
  if (/404|page not found|forgot to add the page/i.test(bodyText)) return false;
  // A bare splash with a "Sign In" button is NOT logged in.
  const hasSignIn = await page
    .getByRole('button', { name: /sign ?in|log ?in/i })
    .or(page.getByRole('link', { name: /sign ?in|log ?in/i }))
    .count()
    .then((c) => c > 0)
    .catch(() => false);
  return !hasSignIn;
}

// Number of password fields currently on the page (0 means we're not on a
// login form yet — likely a splash/marketing page that gates the form behind a
// "Sign In" button or a /login route).
async function passwordFieldCount(page: Page): Promise<number> {
  return page.locator('input[type="password"]').count().catch(() => 0);
}

// Many apps put a marketing splash at `/` and the real login form one click
// away (a "Sign In" / "Log in" button or a /login route). When the loaded page
// has no password field, try to reveal the form: first click an in-page
// sign-in affordance, then fall back to navigating common auth routes. Returns
// true once a password field is present. Best-effort and idempotent — a no-op
// when the form is already visible.
export async function revealLoginForm(page: Page, url: string): Promise<boolean> {
  if ((await passwordFieldCount(page)) > 0) return true;

  // 1) Click an in-page "Sign In" / "Log in" affordance (button or link). Skip
  //    "sign up"/"create account" so we don't land on the registration form.
  const signInControl = page
    .getByRole('button', { name: /sign ?in|log ?in/i })
    .or(page.getByRole('link', { name: /sign ?in|log ?in/i }))
    .or(page.getByText(/^\s*(sign ?in|log ?in)\s*$/i));
  if (await signInControl.count().then((c) => c > 0).catch(() => false)) {
    await signInControl.first().click().catch(() => undefined);
    await page.waitForTimeout(1200);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => undefined);
    if ((await passwordFieldCount(page)) > 0) return true;
  }

  // 2) Fall back to common auth routes on the same origin.
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return url.replace(/\/+$/, '');
    }
  })();
  for (const path of ['/login', '/sign-in', '/signin', '/auth/login', '/auth']) {
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: 'visible', timeout: 6_000 })
      .catch(() => undefined);
    if ((await passwordFieldCount(page)) > 0) return true;
  }
  return false;
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

// Social / OAuth / SSO buttons that must NEVER be treated as the form's submit
// control — clicking them navigates away to a third-party identity provider
// (Google, GitHub, Apple, …) instead of submitting the email/password the
// harness just typed. Clerk, Supabase Auth, Auth0 etc. all render these
// alongside the real submit button (e.g. "Continue with Google" next to a bare
// "Continue").
const SOCIAL_BUTTON_RE = /google|github|gitlab|apple|microsoft|facebook|twitter|discord|sso|saml|passkey|magic ?link|with email/i;

// Click the form's submit button. Filters out social/OAuth buttons by their
// visible text so a "Continue with Google" button next to a bare "Continue"
// doesn't hijack the submit.
//
// Order matters: an IN-FORM submit control is tried first because a text-named
// heuristic alone is ambiguous — apps frequently render a decorative "Sign in"
// toggle in the top nav (a tab/dropdown opener, type=button, outside the form)
// that sits BEFORE the real in-form "Sign in" submit in DOM order. Clicking the
// toggle no-ops the submit and leaves the page on the login screen (this is
// exactly why the Manus CRM failed F7/F8). So: in-form submit/named control
// first, then a page-wide type=submit, then the text-named heuristic, then any
// non-social button, then Enter.
async function submit(page: Page): Promise<void> {
  // 1) The form's OWN submit control — a type=submit button or a named button
  //    inside a <form>. This is the most reliable signal and can't match a
  //    nav-level toggle that lives outside the form.
  const inForm = page
    .locator('form button[type="submit"]')
    .or(page.locator('form').getByRole('button', { name: /log ?in|sign ?in|continue|submit|next/i }));
  const inFormCount = await inForm.count().catch(() => 0);
  for (let i = 0; i < inFormCount; i++) {
    const btn = inForm.nth(i);
    const text = await btn.innerText().catch(() => '');
    if (SOCIAL_BUTTON_RE.test(text)) continue;
    await btn.click().catch(() => undefined);
    return;
  }
  // 2) Any type=submit button on the page, skipping any whose text reads social.
  const submitTyped = page.locator('button[type="submit"]');
  const submitCount = await submitTyped.count().catch(() => 0);
  for (let i = 0; i < submitCount; i++) {
    const btn = submitTyped.nth(i);
    const text = await btn.innerText().catch(() => '');
    if (SOCIAL_BUTTON_RE.test(text)) continue;
    await btn.click().catch(() => undefined);
    return;
  }
  // 3) Text-named buttons anywhere on the page (last resort before "any button"),
  //    skipping social. Reached only when no in-form/type=submit control exists.
  const named = page.getByRole('button', { name: /log ?in|sign ?in|continue|submit|next/i });
  const namedCount = await named.count().catch(() => 0);
  for (let i = 0; i < namedCount; i++) {
    const btn = named.nth(i);
    const text = await btn.innerText().catch(() => '');
    if (SOCIAL_BUTTON_RE.test(text)) continue;
    await btn.click().catch(() => undefined);
    return;
  }
  // Any remaining non-social button.
  const all = page.getByRole('button');
  const allCount = await all.count().catch(() => 0);
  for (let i = 0; i < allCount; i++) {
    const btn = all.nth(i);
    const text = await btn.innerText().catch(() => '');
    if (SOCIAL_BUTTON_RE.test(text)) continue;
    await btn.click().catch(() => undefined);
    return;
  }
  // Fallback: press Enter in the password field.
  await page.locator('input[type="password"]').first().press('Enter').catch(() => undefined);
}

// Text that signals a post-password verification challenge (email OTP, 2FA,
// "new device" trust prompt) — common with Clerk / Auth0 / Supabase when
// signing in from a fresh browser context, which the harness does every run. We
// can't satisfy these (no inbox access), but we must NOT mistake the absent
// password field for a successful login.
const VERIFICATION_CHALLENGE_RE = /check your email|verification code|enter the code|we (?:sent|emailed)|new device|two-?factor|authenticator|one-?time (?:code|password)|verify (?:your|it'?s you)/i;

type LoginState = 'loggedIn' | 'verificationRequired' | 'stillOnLogin';

// True while the form's submit is still in flight — the button shows a
// pending/loading label ("Signing in…", "Loading…", "Please wait") and/or is
// disabled. Sampling the DOM during this window is what produced false
// `stillOnLogin` results: the password field is still mounted on the login URL
// mid-request, even though the credentials were accepted and a redirect is
// imminent. We must let this state clear before classifying.
const SUBMIT_PENDING_LABEL_RE = /signing ?in|logging ?in|loading|please wait|authenticating|verifying|submitting|…|\.\.\./i;
async function submitInFlight(page: Page): Promise<boolean> {
  const buttons = page.locator('form button, button[type="submit"]');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const disabled = await btn.isDisabled().catch(() => false);
    const text = await btn.innerText().catch(() => '');
    if (disabled || SUBMIT_PENDING_LABEL_RE.test(text)) return true;
  }
  return false;
}

// Classify the page state after submitting credentials.
//
// "No password field" is the proxy for "left the login form", but it's
// ambiguous on two axes: a verification challenge also has no password field
// (check challenge text first), AND a slow async sign-in keeps the password
// field mounted on the login URL while the request is in flight (the button
// reads "Signing in…"). A fixed-delay snapshot taken mid-request misreads that
// transient state as `stillOnLogin` and aborts the login even though it
// succeeds — this is exactly what zeroed S4 on the Anything CRM.
//
// So we POLL for a terminal state instead of sampling once: success is detected
// POSITIVELY (the dashboard mounts), and `stillOnLogin` is only concluded once
// the submit has actually quiesced (button no longer pending/disabled) with the
// password field still present.
async function classifyAfterSubmit(page: Page, url?: string): Promise<LoginState> {
  const deadline = Date.now() + 20_000;
  let sawPending = false;
  let pendingSince = 0;
  let recoveredByReload = false;
  while (Date.now() < deadline) {
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);

    // Positive success signal — the authenticated dashboard mounted.
    if (await isOnDashboard(page)) return 'loggedIn';

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (VERIFICATION_CHALLENGE_RE.test(bodyText)) return 'verificationRequired';

    const stillHasPassword = await page
      .locator('input[type="password"]')
      .count()
      .then((c) => c > 0)
      .catch(() => true);

    // Left the form without a challenge and without a recognizable dashboard
    // (e.g. an app whose post-login UI we don't positively match) — still a
    // successful login: the password field is gone.
    if (!stillHasPassword) return 'loggedIn';

    // Password field still present. If the submit is mid-flight (button shows a
    // loading label or is disabled), this is a transient state — wait it out
    // rather than declaring failure. Only once the submit has settled AND the
    // form is still showing do we conclude we never left the login screen.
    if (await submitInFlight(page)) {
      sawPending = true;
      if (pendingSince === 0) pendingSince = Date.now();
      // Some apps (Anything CRM) intermittently WEDGE the submit button on
      // "Signing in…" forever even though the auth request already set the
      // session cookie server-side — the client just never re-renders. A hard
      // reload re-reads the cookie and mounts the dashboard (the exact manual
      // recovery). Do this ONCE, only after the button has been pending a while,
      // so we don't disturb a normal in-flight submit that's about to resolve.
      if (!recoveredByReload && url && Date.now() - pendingSince > 6_000) {
        recoveredByReload = true;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
        if (await isOnDashboard(page)) return 'loggedIn';
        // After the reload the password field may be back (logged-out) or gone
        // (logged-in but unrecognized UI) — let the loop re-classify.
        pendingSince = 0;
        continue;
      }
      await page.waitForTimeout(500);
      continue;
    }
    // The submit has settled (or never showed a pending state). Give one more
    // brief grace period after observing a pending->settled transition, since a
    // redirect can fire a beat after the button re-enables.
    if (sawPending) {
      sawPending = false;
      await page.waitForTimeout(800);
      continue;
    }
    return 'stillOnLogin';
  }
  // Timed out without reaching a terminal state. Make a final positive check;
  // otherwise report still-on-login (the password form never gave way).
  if (await isOnDashboard(page)) return 'loggedIn';
  const stillHasPassword = await page
    .locator('input[type="password"]')
    .count()
    .then((c) => c > 0)
    .catch(() => true);
  return stillHasPassword ? 'stillOnLogin' : 'loggedIn';
}

// Interactive runs may resolve an email/SMS OTP challenge by asking the operator
// to read the code from the inbox and type it in. Disabled when stdin is not a
// TTY (CI / piped runs) or when BENCH_NO_INTERACTIVE is set — so an automated
// run never hangs waiting on input it can't receive.
function interactiveEnabled(): boolean {
  if (process.env['BENCH_NO_INTERACTIVE']) return false;
  return Boolean(stdin.isTTY);
}

// Ask the operator for the verification code that the app just emailed/texted.
// Returns the trimmed code, or '' if they pressed Enter to skip.
async function promptForOtp(account: Account): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // Push past any in-place progress-bar fragment with a CR + spaces + CR
    // (same no-ANSI approach progress.ts uses) so the two don't collide.
    if (stdout.isTTY) stdout.write(`\r${' '.repeat(80)}\r`);
    stdout.write(
      `\n  🔐 ${account.email} needs an email verification code (new-device check).\n` +
        `     Check that inbox, paste the code here, then press Enter (or just Enter to skip):\n`,
    );
    const answer = await rl.question('     code> ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

// Fill the verification-code challenge and submit. Handles both single-input
// ("Enter the code") and split per-digit input layouts (one <input> per digit,
// common with Clerk/OTP widgets). Returns true if a code field was found and the
// code entered.
async function fillOtp(page: Page, code: string): Promise<boolean> {
  // Split layout: several short inputs (Clerk renders one per digit, often
  // type=text inputMode=numeric with maxlength=1). pressSequentially across the
  // group lets the widget distribute digits and auto-advance.
  const otpInputs = page.locator(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[name*="otp" i], input[id*="otp" i], input[id*="code" i]',
  );
  const otpCount = await otpInputs.count().catch(() => 0);
  if (otpCount >= 2) {
    await otpInputs.first().click().catch(() => undefined);
    await otpInputs.first().pressSequentially(code, { delay: 40 }).catch(() => undefined);
    return true;
  }
  if (otpCount === 1) {
    await fillVerified(otpInputs.first(), code);
    return true;
  }
  // Generic fallback: the first visible text-ish input that isn't email/password.
  const generic = page.locator('input:not([type="password"]):not([type="email"]):not([type="hidden"])');
  if (await generic.count().then((c) => c > 0).catch(() => false)) {
    await fillVerified(generic.first(), code);
    return true;
  }
  return false;
}

// When login lands on an email/SMS OTP challenge, prompt the operator for the
// code (interactive runs only), fill it, and submit. Retries a couple of times
// so a mistyped/expired code can be re-entered. Returns the post-submit state.
async function resolveVerificationChallenge(page: Page, account: Account): Promise<LoginState> {
  if (!interactiveEnabled()) return 'verificationRequired';
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await promptForOtp(account);
    if (!code) {
      stdout.write('     ↳ skipped — leaving the verification challenge unsolved.\n');
      return 'verificationRequired';
    }
    const filled = await fillOtp(page, code);
    if (!filled) {
      stdout.write('     ↳ could not find a code input on the page; giving up.\n');
      return 'verificationRequired';
    }
    await submit(page);
    const state = await classifyAfterSubmit(page);
    if (state === 'loggedIn') {
      stdout.write('     ↳ verified ✓\n');
      return 'loggedIn';
    }
    if (state === 'verificationRequired') {
      // Still on the challenge — likely a wrong/expired code; let them retry.
      stdout.write('     ↳ code rejected or still pending; try again.\n');
      continue;
    }
    return state; // stillOnLogin / loggedIn already handled
  }
  stdout.write('     ↳ too many attempts — leaving the challenge unsolved.\n');
  return 'verificationRequired';
}

export async function login(page: Page, url: string, account: Account): Promise<LoginOutcome> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    // If the caller injected a cached authenticated session (applyCachedSession),
    // Clerk needs a moment to re-read the session cookie and mount as signed-in —
    // the page can briefly show the logged-out splash before its <Show when=
    // "signed-in"> redirect fires. settleOnDashboard waits (and reloads) for the
    // real dashboard. So when a cached session is present, let it settle FIRST and
    // accept it if it reaches the dashboard, instead of prematurely treating the
    // transitional splash as "not logged in" and re-driving the login form.
    if (hasCachedSession(account)) {
      // The cached state isn't necessarily in THIS context — F7 reuses the main
      // page, whose context never saw the original login. Inject the cookies
      // (cookies only: contexts that must keep app storage clean, like F8's
      // cross-session check, stay clean) and reload so the server session takes
      // effect before settling.
      await applyCachedSession(page.context(), account, { cookiesOnly: true }).catch(() => undefined);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      await settleOnDashboard(page, url);
      if (await isOnDashboard(page)) {
        return { ok: true };
      }
      // Cached session didn't take — fall through and log in for real.
    }
    if (await isAlreadyLoggedIn(page)) {
      await settleOnDashboard(page, url);
      return { ok: true };
    }
    // Client-side apps (React/Modelence/etc.) mount the login form after the
    // initial HTML loads. Wait for a password field to appear before deciding
    // the form is absent — without this, a fresh context can check too early and
    // spuriously fail (the form is there, just not mounted yet).
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    // Some apps gate the login form behind a marketing splash (a "Sign In"
    // button at `/` and the form at /login). Click/navigate through to it when
    // no password field is on the initial page.
    await revealLoginForm(page, url);
    const hasEmail = await fillEmail(page, account.email);
    if (!hasEmail) {
      return { ok: false, reason: 'could not locate the email field on the login screen' };
    }
    let hasPassword = await fillPassword(page, account.password);
    // Staged auth flows (Clerk, some Supabase/Auth0 setups) collect the email
    // first, then reveal the password field only after a "Continue" click. When
    // no password field is on the page yet, submit the email to advance, wait
    // for the password field to mount, then fill it.
    if (!hasPassword) {
      await submit(page);
      await page.waitForTimeout(1200);
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
      await page
        .locator('input[type="password"]')
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .catch(() => undefined);
      hasPassword = await fillPassword(page, account.password);
    }
    if (!hasPassword) {
      return { ok: false, reason: 'could not locate the password field on the login screen' };
    }
    await submit(page);
    let state = await classifyAfterSubmit(page, url);
    // Email/SMS OTP challenge: in interactive runs, ask the operator to read the
    // code from the inbox and type it in, then re-evaluate. No-op (stays
    // 'verificationRequired') in non-interactive runs.
    if (state === 'verificationRequired') {
      state = await resolveVerificationChallenge(page, account);
    }
    switch (state) {
      case 'loggedIn':
        // "Password field gone" only means we left the form — after OTP, Clerk
        // can land on a transitional /sign-in/* page or bounce back to the
        // marketing splash at `/` (which still renders the logged-out hero with
        // a "Sign In" button). Navigate to the app root and wait for the real
        // authenticated dashboard to mount, so downstream steps (create contact,
        // capture data, screenshot) run against the app, not the splash.
        await settleOnDashboard(page, url);
        // Cache the trusted session so later logins this run skip the form (and,
        // crucially, the OTP challenge) for this account.
        await cacheSession(page, account).catch(() => undefined);
        return { ok: true };
      case 'verificationRequired':
        return {
          ok: false,
          reason:
            'login blocked by an email/2FA verification challenge (the app flags the harness\'s fresh browser as a new device). Credentials were accepted but a code the harness cannot read is required.',
        };
      case 'stillOnLogin':
        return { ok: false, reason: 'still on login screen after submitting credentials' };
    }
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
    // Some apps keep the form behind a "New contact" / "Add contact" button
    // that opens a dialog or drawer — click it and wait for the form to mount.
    const opener = page.getByRole('button', { name: /new contact|add contact|add/i });
    if (!(await opener.count().then((c) => c > 0).catch(() => false))) return false;
    await opener.first().click().catch(() => undefined);
    try {
      await nameField.first().waitFor({ state: 'visible', timeout: 5_000 });
    } catch {
      return false;
    }
  }
  // Fill, then verify it stuck; if the controlled input didn't register the
  // value, fall back to typing it key-by-key (which fires React onChange).
  await fillVerified(nameField.first(), name);

  // Email field. `input[type="email"]` is the most reliable signal and is tried
  // FIRST — many forms have no <label>/name/id, only placeholders, and a
  // placeholder regex is treacherous: a common example email placeholder like
  // "jane@company.com" contains the substring "company", so a /company/ locator
  // would grab the email field (and a /email/ locator would miss it, since the
  // placeholder has no "email"). Anchoring on the input TYPE avoids both traps.
  const emailField = page
    .locator('input[type="email"]')
    .or(page.getByLabel(/e-?mail/i))
    .or(page.getByPlaceholder(/e-?mail/i));
  if (await emailField.count().then((c) => c > 0).catch(() => false)) {
    // Derive a valid email local-part — strip anything that isn't allowed (e.g.
    // spaces in "Sample Contact"), which would otherwise trip the field's email
    // validation and block the submit.
    const localPart = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^\.|\.$/g, '') || 'contact';
    // Use example.com (RFC 2606), NOT a `.test`/`.invalid` TLD: strict server-side
    // validators (Python email-validator / Pydantic EmailStr, used by FastAPI
    // backends like Emergent's) reject reserved/special-use TLDs with a 422, which
    // silently fails the seed. example.com is reserved for examples yet passes
    // those validators' deliverability/special-use checks.
    await fillVerified(emailField.first(), `${localPart}@example.com`);
  }
  // Company (and any other common contact field) — fill if present; some forms
  // require it before the submit button activates. Match by label/placeholder
  // but EXCLUDE the email input we already filled: an email placeholder such as
  // "jane@company.com" matches /company/, which would otherwise re-target the
  // email field here and leave the real company field empty (silently failing
  // the form's required-field validation, so no record is created).
  const companyField = page
    .getByLabel(/company|organization|organisation/i)
    .or(page.getByPlaceholder(/company|organization|organisation|acme/i));
  // Resolve the company target, skipping the email input if the loose locator
  // (e.g. an "jane@company.com" email placeholder) still resolves to it.
  let companyTarget: import('@playwright/test').Locator | null = null;
  const companyCount = await companyField.count().catch(() => 0);
  for (let i = 0; i < companyCount; i++) {
    const cand = companyField.nth(i);
    const type = await cand.getAttribute('type').catch(() => null);
    if (type === 'email') continue;
    companyTarget = cand;
    break;
  }
  // Fallback: if keyword matching found nothing usable, take the last non-email
  // text input in the form (company is conventionally the last field).
  if (!companyTarget) {
    const textInputs = page.locator('form input:not([type="email"]):not([type="password"]):not([type="hidden"])');
    const n = await textInputs.count().catch(() => 0);
    if (n >= 3) companyTarget = textInputs.nth(n - 1);
  }
  if (companyTarget) {
    await fillVerified(companyTarget, 'BenchCo');
  }

  // Prefer the form's real submit control. A bare name regex is ambiguous when
  // the form lives in a dialog: the "New contact" OPENER button (still on the
  // page behind the overlay) also matches, and clicking it would no-op instead
  // of submitting — so try button[type=submit] first and never match the
  // opener-style "new contact" phrasing as a submit.
  const addBtn = page
    .locator('form button[type="submit"]:visible')
    .or(page.getByRole('button', { name: /add contact|add|create|save|submit/i }));
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

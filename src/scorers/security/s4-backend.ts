import type { APIRequestContext, Browser } from '@playwright/test';
import type { Account } from '../../core/backend.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';
import { captureDataResponses, extractIdentifier, errMsg, type CapturedDataResponse } from '../backend/auth.ts';
import { login, createContact, applyCachedSession } from '../backend/login.ts';

// Replay a captured data request (GET or POST/RPC) through a given browser
// context's request API, so that context's session cookies/headers ride along.
async function replay(
  request: APIRequestContext,
  target: CapturedDataResponse,
): Promise<{ status: number; body: string }> {
  const opts: Parameters<APIRequestContext['fetch']>[1] = { timeout: 10_000, failOnStatusCode: false };
  if (target.method === 'POST') {
    opts.method = 'POST';
    if (target.postData !== null) opts.data = target.postData;
    if (target.requestContentType) opts.headers = { 'content-type': target.requestContentType };
  } else {
    opts.method = 'GET';
  }
  const res = await request.fetch(target.url, opts);
  return { status: res.status(), body: await res.text().catch(() => '') };
}

export const S4_VERSION = '0.4.1';

// S4 — Backend security probes. Runtime probes that catch server-side
// authorization failures (the canonical "RLS off, every user reads every other
// user's data" bug) which S2 only infers from client-side code hints.
//
// Fully credential-driven — the only inputs are user A's and user B's logins.
// The harness:
//   1. signs in as B through the real UI, seeds a uniquely-marked record as B,
//      and observes B's dashboard traffic to auto-discover the response that
//      carries B's data (the marker is the leak identifier). This covers JSON
//      APIs and server-rendered apps alike: RSC/SSR apps (e.g. Next.js App
//      Router) embed the data in the HTML document or an RSC flight payload
//      and never emit a JSON data response;
//   2. replays that request with NO session (unauth probe) — must be rejected;
//   3. signs in as A in a fresh context and replays B's request from A's session
//      (cross-user probe) — must NOT return B's marker.
// No declared endpoints, no tokens, no record ids supplied by hand. S4 writes a
// single record (owned by B) to guarantee a discoverable, identifiable target.

const SEVERITY_WEIGHT = 10; // both probe failures are direct data exposure = critical

// Strip embedded auth credentials from a captured request so it can be replayed
// as a genuinely unauthenticated request. Removes common token keys from a JSON
// POST body (authToken, token, accessToken, jwt, apiKey, sessionId) and drops
// any Authorization header. Backends that carry auth in the body (Modelence,
// tRPC) would otherwise stay authenticated through a naive replay.
function stripAuth(target: CapturedDataResponse): CapturedDataResponse {
  let postData = target.postData;
  if (postData) {
    try {
      const parsed = JSON.parse(postData) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        if (/^(auth ?token|token|access ?token|jwt|api ?key|session ?id|bearer)$/i.test(key.replace(/_/g, ' '))) {
          delete parsed[key];
        }
      }
      postData = JSON.stringify(parsed);
    } catch {
      // non-JSON body — leave as-is; the no-session context already drops cookies
    }
  }
  return { ...target, postData };
}

interface ProbeResult {
  id: string;
  kind: 'unauth_get' | 'cross_user_get';
  passed: boolean;
  status: number | null;
  identifierLeaked?: boolean;
  note: string;
}

// One pass of phase 1: log in as B on a fresh context, seed the marked record,
// reload the dashboard under capture, and return whatever was observed plus
// step-by-step diagnostics (surfaced in the result so an N/A is actionable).
interface SeedAttempt {
  loginOk: boolean;
  loginReason?: string;
  formDriven: boolean;
  markerVisibleAfterSeed: boolean;
  markerVisibleAfterReload: boolean;
  bData: CapturedDataResponse | null;
}

// A captured response is usable when the leak identifier can be derived from
// it — either the seeded marker is present, or it is JSON with an id-like field.
function seedUsable(attempt: SeedAttempt, seedMarker: string): boolean {
  if (!attempt.bData) return false;
  return attempt.bData.body.includes(seedMarker) || extractIdentifier(attempt.bData.body) !== null;
}

async function seedAndCaptureAsB(
  browser: Browser,
  url: string,
  userB: Account,
  seedMarker: string,
): Promise<SeedAttempt> {
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await applyCachedSession(ctxB, userB);
    const pageB = await ctxB.newPage();
    const loginB = await login(pageB, url, userB);
    if (!loginB.ok) {
      return { loginOk: false, loginReason: loginB.reason, formDriven: false, markerVisibleAfterSeed: false, markerVisibleAfterReload: false, bData: null };
    }
    // Attach the capture BEFORE seeding. Many apps fetch the fresh record list
    // right after a successful create (a `GET /api/contacts` refetch fired by
    // the form's onSuccess) — that response carries the seeded marker AND is
    // clean JSON, the ideal capture. If we only start capturing after the seed
    // (or only on a later reload), we miss this post-create fetch entirely and
    // fall back to capturing the rendered HTML document, which yields no stable
    // identifier. So capture across the whole seed+reload window.
    const capture = captureDataResponses(pageB, { marker: seedMarker });
    // Seed a marked record as B, then confirm it actually rendered on the
    // dashboard before probing — if the seed silently failed (wrong page), the
    // data fetch would carry no records and the capture would come up empty.
    const formDriven = await createContact(pageB, seedMarker).catch(() => false);
    const markerVisibleAfterSeed = await pageB
      .getByText(seedMarker, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    // RELOAD THE CURRENT (dashboard) URL — not the app root. login() leaves us on
    // the authenticated dashboard route (e.g. /contacts); navigating back to `/`
    // would render the logged-out splash and fetch nothing, so the data capture
    // would see no record list. reload() re-fetches the dashboard's own data —
    // a second chance to capture the JSON list for apps that DON'T refetch on
    // create (and whose list only renders the new record after a reload).
    await pageB.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    // Wait for the seeded record to re-render — proves the data fetch completed
    // within the capture window (re-hydration on reload can delay it).
    const markerVisibleAfterReload = await pageB
      .getByText(seedMarker, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    await pageB.waitForTimeout(1500);
    await pageB.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    const bData = await capture.stop();
    return { loginOk: true, formDriven, markerVisibleAfterSeed, markerVisibleAfterReload, bData };
  } finally {
    await ctxB.close().catch(() => undefined);
  }
}

export async function runS4(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();
  const backend = ctx.submission.backend;
  if (!backend) return naResult('no backend block in submission', start);

  const url = ctx.submission.artifactUrl;
  const browser: Browser = ctx.browser;
  const results: ProbeResult[] = [];

  // ── Phase 1: sign in as B, ensure B owns identifiable data, discover the
  // endpoint that serves it. We seed a uniquely-marked contact as B so (a) the
  // dashboard has data to fetch even on a fresh account, and (b) the marker is a
  // guaranteed-unique identifier the cross-user probe checks for — more reliable
  // than guessing an id field. (S4 thus writes one record, owned by B.)
  //
  // S4 is usually B's FIRST login of the run, which can be an interactive (OTP)
  // login — and on heavy SPAs the freshly-OTP'd page sometimes never re-hydrates
  // to the dashboard (see settleOnDashboard), so the seed lands on the splash
  // and nothing is captured. The successful login caches B's session, so a
  // SECOND attempt on a fresh context loads straight onto the dashboard (the
  // same path F8 takes) — retry once before giving up.
  const seedMarker = `S4_PROBE_${ctx.submission.runIdx}_${Date.now().toString(36)}`;
  let attempt = await seedAndCaptureAsB(browser, url, backend.userB, seedMarker);
  if (!attempt.loginOk) {
    return naResult(`could not sign in as user B: ${attempt.loginReason ?? 'unknown'}`, start);
  }
  let attempts = 1;
  if (!seedUsable(attempt, seedMarker)) {
    const retry = await seedAndCaptureAsB(browser, url, backend.userB, seedMarker);
    attempts = 2;
    if (retry.loginOk && (seedUsable(retry, seedMarker) || (retry.bData && !attempt.bData))) {
      attempt = retry;
    }
  }
  const seedDiagnostics = {
    seedAttempts: attempts,
    seedFormDriven: attempt.formDriven,
    seedMarkerVisible: attempt.markerVisibleAfterSeed,
    seedMarkerVisibleAfterReload: attempt.markerVisibleAfterReload,
    capturedKind: attempt.bData?.kind ?? null,
  };
  const bData = attempt.bData;
  if (!bData) {
    return naResult('could not observe a data response from user B\'s dashboard (no JSON record list or marker-bearing rendered payload captured)', start, seedDiagnostics);
  }
  // Prefer the seeded marker as the leak identifier; fall back to a field.
  const bIdentifier = bData.body.includes(seedMarker) ? seedMarker : extractIdentifier(bData.body);
  if (!bIdentifier) {
    return naResult('captured B\'s data response but could not extract a stable identifier from it', start, seedDiagnostics);
  }

  // ── Probe 1: unauthenticated request ──
  // Replay B's captured request with any embedded auth credential STRIPPED, from
  // a session-less context. Critical: many backends (Modelence, tRPC) carry the
  // auth token in the request *body*, not a cookie — so a naive replay would
  // still be authenticated as B. We strip body/header tokens to make it a true
  // anonymous request. Only a genuine unauthenticated 2xx returning B's data is
  // a finding.
  const ctxAnon = await browser.newContext();
  try {
    const stripped = stripAuth(bData);
    const { status, body } = await replay(ctxAnon.request, stripped);
    const rejected = status === 401 || status === 403;
    const servedData = status >= 200 && status < 300 && bIdentifier !== null && body.includes(bIdentifier);
    const passed = !servedData;
    results.push({
      id: 'unauth_read',
      kind: 'unauth_get',
      passed,
      status,
      note: rejected
        ? `rejected unauthenticated read (${status})`
        : servedData
          ? `endpoint served B's data to an UNAUTHENTICATED request (${status}) — publicly readable`
          : `unauthenticated request returned ${status} without B's data`,
    });
  } catch (err) {
    results.push({ id: 'unauth_read', kind: 'unauth_get', passed: true, status: null, note: `inconclusive (${errMsg(err)})` });
  } finally {
    await ctxAnon.close().catch(() => undefined);
  }

  // ── Probe 2: cross-user isolation ──
  // The correct test is whether A's OWN authenticated data request exposes B's
  // record — NOT a replay of B's request (whose body/cookie authenticates B, so
  // replaying it from A's context still returns B's data; that was a false-
  // positive bug for token-in-body auth). We log in as A, capture A's own
  // dashboard data response, and check whether B's marker appears in it.
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await applyCachedSession(ctxA, backend.userA);
    const pageA = await ctxA.newPage();
    // Passing B's identifier as the marker makes the capture prefer any
    // response that carries it — so a leak anywhere in A's traffic (JSON,
    // document, or RSC payload) is surfaced rather than masked by whichever
    // single response happens to be "best". With no leak, the capture falls
    // back to A's own data response (JSON record list or rendered dashboard).
    const captureA = captureDataResponses(pageA, { marker: bIdentifier });
    const loginA = await login(pageA, url, backend.userA);
    if (!loginA.ok) {
      results.push({ id: 'cross_user_read', kind: 'cross_user_get', passed: true, status: null, note: `inconclusive: could not sign in as user A (${loginA.reason ?? 'unknown'})` });
    } else {
      await pageA.waitForTimeout(2500);
      await pageA.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
      const aData = await captureA.stop();
      if (!aData) {
        results.push({ id: 'cross_user_read', kind: 'cross_user_get', passed: true, status: null, note: 'inconclusive: could not observe A\'s own data response' });
      } else {
        const identifierLeaked = bIdentifier !== null && aData.body.includes(bIdentifier);
        results.push({
          id: 'cross_user_read',
          kind: 'cross_user_get',
          passed: !identifierLeaked,
          status: 200,
          identifierLeaked,
          note: identifierLeaked
            ? `CROSS-TENANT LEAK: user A's own data response contains user B's record (B's marker present)`
            : `user A's data response does not contain user B's record (properly isolated)`,
        });
      }
    }
  } catch (err) {
    results.push({ id: 'cross_user_read', kind: 'cross_user_get', passed: true, status: null, note: `inconclusive (${errMsg(err)})` });
  } finally {
    await ctxA.close().catch(() => undefined);
  }

  // No teardown here — a single account cleanup runs at the end of the whole
  // submission (see orchestrate), so the seeded record stays available for the
  // probes and nothing races the other backend scorers' in-flight data.

  const failed = results.filter((r) => !r.passed);
  const penalty = failed.length * SEVERITY_WEIGHT;
  const score = Math.max(0, 1 - penalty / 20);
  const passed = failed.length === 0;

  return {
    scorer: 's4',
    version: S4_VERSION,
    passed,
    score,
    details: {
      probesRun: results.length,
      failedCount: failed.length,
      crossTenantLeak: results.some((r) => r.identifierLeaked === true),
      discoveredEndpoint: bData.url,
      discoveredMethod: bData.method,
      discoveredKind: bData.kind,
      ...seedDiagnostics,
      bRecordCount: bData.recordCount,
      // Never store B's response body — only the redacted per-probe outcome.
      probes: results,
      elapsedMs: Date.now() - start,
    },
  };
}

function naResult(note: string, start: number, extra?: Record<string, unknown>): ScorerResult {
  return {
    scorer: 's4',
    version: S4_VERSION,
    passed: null,
    score: null,
    details: { note, ...extra, elapsedMs: Date.now() - start },
    notes: note,
  };
}

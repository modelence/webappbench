import type { Page } from '@playwright/test';

// Runtime helpers for the backend track. The track authenticates exclusively
// through the real UI (see login.ts) — there is no programmatic token mode. S4
// discovers a user's data endpoint by observing the responses their authenticated
// dashboard fetches, then replays that request as another user.

const FETCH_TIMEOUT_MS = 10_000;

export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A data-bearing API response captured from an authenticated page. Records
// enough of the request to replay it as another user — including the method and
// POST body, since many backends (Modelence, GraphQL, tRPC) fetch data via POST
// RPC rather than GET.
export interface CapturedDataResponse {
  url: string;
  method: string;
  // The request body to replay (for POST/RPC reads). null for GET.
  postData: string | null;
  // Content-type of the original request (so the replay matches it).
  requestContentType: string | null;
  // Number of records the response body carried (array length, or nested array).
  recordCount: number;
  // The raw response body text (for extracting an identifying value).
  body: string;
}

interface Capture {
  url: string;
  method: string;
  postData: string | null;
  requestContentType: string | null;
  bodyPromise: Promise<string | null>;
}

// Attach a response collector to a page. Captures JSON responses to GET and POST
// requests so the caller can later pick the one that looks like the user's data.
// POST is included because RPC/GraphQL data layers read via POST. Returns a
// stop() that resolves the best candidate (largest record array).
export function captureDataResponses(page: Page): { stop: () => Promise<CapturedDataResponse | null> } {
  const captures: Capture[] = [];

  const onResponse = (response: import('@playwright/test').Response): void => {
    const ct = response.headers()['content-type'] ?? '';
    if (!/application\/json|text\/json/i.test(ct)) return;
    const req = response.request();
    const method = req.method();
    if (method !== 'GET' && method !== 'POST') return;
    const url = response.url();
    // Skip obvious non-data endpoints (auth, login, session bootstrap, static).
    if (/\/(auth|token|login|signin|sign-in|session|_system|config|health|favicon)\b/i.test(url)) return;
    captures.push({
      url,
      method,
      postData: req.postData(),
      requestContentType: req.headers()['content-type'] ?? null,
      bodyPromise: response.text().catch(() => null),
    });
  };

  page.on('response', onResponse);

  return {
    stop: async (): Promise<CapturedDataResponse | null> => {
      page.off('response', onResponse);
      let best: CapturedDataResponse | null = null;
      for (const c of captures) {
        const body = await c.bodyPromise;
        if (!body) continue;
        const count = recordCount(body);
        if (count > 0 && (!best || count > best.recordCount)) {
          best = {
            url: c.url,
            method: c.method,
            postData: c.postData,
            requestContentType: c.requestContentType,
            recordCount: count,
            body,
          };
        }
      }
      return best;
    },
  };
}

// How many records a JSON body carries. Handles a top-level array, or the
// largest array found among top-level object values (e.g. { data: [...] }).
function recordCount(body: string): number {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') {
      let max = 0;
      for (const v of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) max = Math.max(max, v.length);
      }
      return max;
    }
    return 0;
  } catch {
    return 0;
  }
}

// Pull a stable identifying value out of a captured data response — used as the
// marker that must NOT appear in another user's response. Prefers an `id`-like
// field of the first record; falls back to the longest string value.
export function extractIdentifier(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const records = Array.isArray(parsed)
      ? parsed
      : Object.values((parsed ?? {}) as Record<string, unknown>).find((v) => Array.isArray(v)) as unknown[] | undefined;
    const first = records?.[0];
    if (first && typeof first === 'object') {
      const rec = first as Record<string, unknown>;
      // Prefer a unique-ish id field.
      for (const key of ['id', '_id', 'uuid', 'contactId', 'email']) {
        const v = rec[key];
        if (typeof v === 'string' && v.length >= 3) return v;
        if (typeof v === 'number') return String(v);
      }
      // Fall back to the longest string value in the record.
      const strings = Object.values(rec).filter((v): v is string => typeof v === 'string' && v.length >= 3);
      if (strings.length) return strings.sort((a, b) => b.length - a.length)[0]!;
    }
  } catch {
    // not JSON or unexpected shape
  }
  return null;
}

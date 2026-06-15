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

// How a captured response carries the user's data:
//   json     — a JSON API/RPC response (replayable, record-countable)
//   document — a server-rendered HTML page (RSC/SSR apps embed data here)
//   rsc      — a React Server Components flight payload (text/x-component),
//              fetched on client-side navigations and Server Action responses
export type CapturedKind = 'json' | 'document' | 'rsc';

// A data-bearing response captured from an authenticated page. Records enough
// of the request to replay it as another user — including the method and POST
// body, since many backends (Modelence, GraphQL, tRPC) fetch data via POST RPC
// rather than GET. Server-rendered apps (Next.js App Router / RSC) never emit a
// JSON data response at all, so HTML documents and RSC payloads are captured
// too and matched by a caller-supplied marker instead of record counting.
export interface CapturedDataResponse {
  url: string;
  method: string;
  // The request body to replay (for POST/RPC reads). null for GET.
  postData: string | null;
  // Content-type of the original request (so the replay matches it).
  requestContentType: string | null;
  // Number of records the response body carried. Only meaningful for `json`
  // captures; for rendered captures it is 1 when the marker was found, else 0.
  recordCount: number;
  // The raw response body text (for extracting an identifying value).
  body: string;
  kind: CapturedKind;
}

interface Capture {
  url: string;
  method: string;
  postData: string | null;
  requestContentType: string | null;
  kind: CapturedKind;
  bodyPromise: Promise<string | null>;
}

// Obvious non-data endpoints (auth, login, session bootstrap, static).
const SKIP_URL = /\/(auth|token|login|signin|sign-in|signup|sign-up|session|_system|config|health|favicon)\b/i;

function classifyResponse(contentType: string, resourceType: string): CapturedKind | null {
  if (/application\/json|text\/json/i.test(contentType)) return 'json';
  if (/text\/x-component/i.test(contentType)) return 'rsc';
  if (/text\/html/i.test(contentType) && resourceType === 'document') return 'document';
  return null;
}

// Attach a response collector to a page. Captures JSON responses to GET and
// POST requests (POST because RPC/GraphQL data layers read via POST), plus
// rendered payloads (HTML documents, RSC flight responses) for apps that fetch
// data server-side and never expose a JSON endpoint. Returns a stop() that
// resolves the best candidate: a marker-bearing response when `marker` is
// given, else the largest JSON record array, else the largest rendered body.
export function captureDataResponses(
  page: Page,
  opts?: { marker?: string },
): { stop: () => Promise<CapturedDataResponse | null> } {
  const marker = opts?.marker;
  const captures: Capture[] = [];

  const onResponse = (response: import('@playwright/test').Response): void => {
    const ct = response.headers()['content-type'] ?? '';
    const req = response.request();
    const kind = classifyResponse(ct, req.resourceType());
    if (!kind) return;
    const method = req.method();
    if (method !== 'GET' && method !== 'POST') return;
    const url = response.url();
    if (SKIP_URL.test(url)) return;
    captures.push({
      url,
      method,
      postData: req.postData(),
      requestContentType: req.headers()['content-type'] ?? null,
      kind,
      bodyPromise: response.text().catch(() => null),
    });
  };

  page.on('response', onResponse);

  return {
    stop: async (): Promise<CapturedDataResponse | null> => {
      page.off('response', onResponse);
      const resolved: CapturedDataResponse[] = [];
      for (const c of captures) {
        const body = await c.bodyPromise;
        if (!body) continue;
        const count = c.kind === 'json'
          ? recordCount(body)
          : (marker !== undefined && body.includes(marker) ? 1 : 0);
        resolved.push({
          url: c.url,
          method: c.method,
          postData: c.postData,
          requestContentType: c.requestContentType,
          recordCount: count,
          body,
          kind: c.kind,
        });
      }
      return pickBestCapture(resolved, marker);
    },
  };
}

// Selection order: a marker-bearing response is the strongest signal that this
// is the user's data (JSON preferred — it is precisely replayable). Without a
// marker match, fall back to the largest JSON record list (pre-RSC behavior),
// then to the largest rendered payload (SSR apps with no JSON data traffic).
function pickBestCapture(all: CapturedDataResponse[], marker?: string): CapturedDataResponse | null {
  const withMarker = marker !== undefined ? all.filter((c) => c.body.includes(marker)) : [];
  const jsonMarked = withMarker.filter((c) => c.kind === 'json');
  if (jsonMarked.length > 0) return maxBy(jsonMarked, (c) => c.recordCount);
  if (withMarker.length > 0) return maxBy(withMarker, (c) => c.body.length);
  const jsonWithRecords = all.filter((c) => c.kind === 'json' && c.recordCount > 0);
  if (jsonWithRecords.length > 0) return maxBy(jsonWithRecords, (c) => c.recordCount);
  const rendered = all.filter((c) => c.kind !== 'json');
  if (rendered.length > 0) return maxBy(rendered, (c) => c.body.length);
  return null;
}

function maxBy<T>(items: T[], score: (item: T) => number): T {
  return items.reduce((best, item) => (score(item) > score(best) ? item : best));
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

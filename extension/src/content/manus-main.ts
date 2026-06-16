// MAIN-world interceptor for Manus (manus.im), injected at document_start. Must
// stay import-free. Manus meters each build through the Connect-RPC endpoint
// POST https://api.manus.im/session.v1.SessionService/GetSession, authenticated
// with a Bearer token the page holds in memory (not in localStorage). We can't
// read that token from the ISOLATED content script, so this MAIN-world script
// wraps window.fetch and XMLHttpRequest to (a) capture the Bearer token from the
// page's own api.manus.im requests and (b) remember the latest GetSession
// response. On COLLECT the content script asks us for a session; we replay
// GetSession with the captured token (in the page's own origin, so the request
// behaves exactly like the app's) and fall back to the buffered response if the
// replay fails.

(() => {
  const REQUEST_TYPE = 'WAB_MANUS_GET_SESSION';
  const RESPONSE_TYPE = 'WAB_MANUS_SESSION';
  const API_ORIGIN = 'https://api.manus.im';
  const GET_SESSION_PATH = '/session.v1.SessionService/GetSession';
  const GET_SESSION_RE = /\/session\.v1\.SessionService\/GetSession/;

  let authToken: string | null = null;
  let latestSession: unknown = null;

  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return (input as Request).url ?? '';
  }

  function readHeaderValue(headers: unknown, name: string): string | null {
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.get(name);
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === name) {
          return typeof pair[1] === 'string' ? pair[1] : null;
        }
      }
      return null;
    }
    if (typeof headers === 'object') {
      for (const key of Object.keys(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === name) {
          const value = (headers as Record<string, unknown>)[key];
          return typeof value === 'string' ? value : null;
        }
      }
    }
    return null;
  }

  function rememberToken(value: string | null): void {
    if (value && /^Bearer\s+.+/i.test(value)) authToken = value;
  }

  function captureRequestAuth(input: RequestInfo | URL, init?: RequestInit): void {
    try {
      if (!urlOf(input).includes('api.manus.im')) return;
      let auth = readHeaderValue(init?.headers, 'authorization');
      if (!auth && typeof Request !== 'undefined' && input instanceof Request) {
        auth = input.headers.get('authorization');
      }
      rememberToken(auth);
    } catch {
      // never break the page's own fetch
    }
  }

  function rememberSession(bodyText: string): void {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed && typeof parsed === 'object' && (parsed as { session?: unknown }).session) {
        latestSession = parsed;
      }
    } catch {
      // not the JSON we expected; ignore
    }
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captureRequestAuth(input, init);
    const response = await originalFetch(input, init);
    try {
      if (GET_SESSION_RE.test(urlOf(input))) {
        response
          .clone()
          .text()
          .then(rememberSession)
          .catch(() => {});
      }
    } catch {
      // best-effort
    }
    return response;
  };

  // --- XMLHttpRequest (belt-and-suspenders; connect-web uses fetch) ---
  interface TrackedXHR extends XMLHttpRequest {
    __wabUrl?: string;
  }
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSetHeader = xhrProto.setRequestHeader;
  xhrProto.open = function (this: TrackedXHR, method: string, url: string | URL, ...rest: unknown[]) {
    this.__wabUrl = typeof url === 'string' ? url : url.href;
    this.addEventListener('load', () => {
      try {
        if (
          this.__wabUrl &&
          GET_SESSION_RE.test(this.__wabUrl) &&
          typeof this.responseText === 'string'
        ) {
          rememberSession(this.responseText);
        }
      } catch {
        // best-effort
      }
    });
    // @ts-expect-error — forwarding the original variadic signature verbatim.
    return originalOpen.call(this, method, url, ...rest);
  };
  xhrProto.setRequestHeader = function (this: TrackedXHR, name: string, value: string) {
    try {
      if (
        name.toLowerCase() === 'authorization' &&
        this.__wabUrl &&
        this.__wabUrl.includes('api.manus.im')
      ) {
        rememberToken(value);
      }
    } catch {
      // best-effort
    }
    return originalSetHeader.call(this, name, value);
  };

  // Replay GetSession in the page's own context (so CORS/cookies behave exactly
  // as they do for the app), returning the freshest figures. Falls back to the
  // buffered response on any failure.
  async function fetchSession(sessionUid: string): Promise<{ session: unknown; error?: string }> {
    if (!authToken) {
      if (latestSession) return { session: latestSession };
      return { session: null, error: 'Not signed in to Manus (no auth token captured yet)' };
    }
    try {
      const response = await originalFetch(`${API_ORIGIN}${GET_SESSION_PATH}`, {
        method: 'POST',
        headers: {
          authorization: authToken,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: JSON.stringify({ sessionUid }),
      });
      if (!response.ok) {
        if (latestSession) return { session: latestSession };
        const hint =
          response.status === 401 || response.status === 403
            ? ' — make sure you are signed in to Manus'
            : '';
        return { session: null, error: `GetSession failed: HTTP ${response.status}${hint}` };
      }
      const data: unknown = await response.json();
      latestSession = data;
      return { session: data };
    } catch (error: unknown) {
      if (latestSession) return { session: latestSession };
      const message = error instanceof Error ? error.message : String(error);
      return { session: null, error: `GetSession failed: ${message}` };
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { type?: string }).type !== REQUEST_TYPE
    ) {
      return;
    }
    const sessionUid = (data as { sessionUid?: unknown }).sessionUid;
    void fetchSession(typeof sessionUid === 'string' ? sessionUid : '').then((result) => {
      window.postMessage(
        { type: RESPONSE_TYPE, session: result.session, error: result.error ?? null },
        window.location.origin,
      );
    });
  });
})();

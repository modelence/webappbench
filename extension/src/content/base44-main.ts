// MAIN-world interceptor for base44, injected at document_start. Must stay
// import-free. Wraps window.fetch to remember the auth-related headers the
// page sends to its own /api/ endpoints, so the isolated-world content script
// can replay them when it fetches the conversation (works whether base44
// authenticates via cookies or bearer tokens).

(() => {
  const AUTH_REQUEST_TYPE = 'WAB_GET_AUTH_HEADERS';
  const AUTH_RESPONSE_TYPE = 'WAB_AUTH_HEADERS';
  // Forwarding cookies is the browser's job; capture only headers an SPA sets
  // explicitly per request.
  const CAPTURED_HEADER_PATTERN = /^(authorization|x-[a-z0-9-]+|api[-_]?key)$/i;

  let capturedHeaders: Record<string, string> = {};

  function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        result[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        if (key !== undefined && value !== undefined) result[key] = value;
      }
    } else {
      Object.assign(result, headers);
    }
    return result;
  }

  function captureFrom(input: RequestInfo | URL, init?: RequestInit): void {
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/')) return;
      const fromRequest =
        typeof input === 'object' && input instanceof Request
          ? headersToObject(input.headers)
          : {};
      const fromInit = headersToObject(init?.headers);
      const merged = { ...fromRequest, ...fromInit };
      const interesting: Record<string, string> = {};
      for (const [key, value] of Object.entries(merged)) {
        if (CAPTURED_HEADER_PATTERN.test(key)) interesting[key] = value;
      }
      if (Object.keys(interesting).length > 0) {
        capturedHeaders = interesting;
      }
    } catch {
      // Capture is best-effort; never break the page's own requests.
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    captureFrom(input, init);
    return originalFetch(input, init);
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      (data as { type?: string }).type === AUTH_REQUEST_TYPE
    ) {
      window.postMessage(
        { type: AUTH_RESPONSE_TYPE, headers: capturedHeaders },
        window.location.origin,
      );
    }
  });
})();

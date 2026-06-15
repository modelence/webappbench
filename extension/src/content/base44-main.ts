// MAIN-world interceptor for base44, injected at document_start. Must stay
// import-free. Wraps window.fetch AND XMLHttpRequest to remember the
// auth-related headers the page sends to its own /api/ endpoints, so the
// isolated-world content script can replay them when it fetches the
// conversation. Base44 authenticates with a bearer token set per request
// (often via axios/XHR, which a fetch-only wrapper would miss), so both
// transports are intercepted.

(() => {
  const AUTH_REQUEST_TYPE = 'WAB_GET_AUTH_HEADERS';
  const AUTH_RESPONSE_TYPE = 'WAB_AUTH_HEADERS';
  // Headers an SPA sets explicitly per request and that gate the API. Cookies
  // are forwarded by the browser, so they are not captured here.
  const CAPTURED_HEADER_PATTERN = /^(authorization|x-[a-z0-9-]+|api[-_]?key)$/i;

  let capturedHeaders: Record<string, string> = {};

  function mergeInteresting(source: Record<string, string>): void {
    const interesting: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string' && CAPTURED_HEADER_PATTERN.test(key)) {
        interesting[key] = value;
      }
    }
    if (Object.keys(interesting).length > 0) {
      capturedHeaders = { ...capturedHeaders, ...interesting };
    }
  }

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

  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (urlOf(input).includes('/api/')) {
        const fromRequest = input instanceof Request ? headersToObject(input.headers) : {};
        mergeInteresting({ ...fromRequest, ...headersToObject(init?.headers) });
      }
    } catch {
      // Capture is best-effort; never break the page's own requests.
    }
    return originalFetch(input, init);
  };

  // --- XMLHttpRequest (axios and other XHR-based clients) ---
  interface TrackedXHR extends XMLHttpRequest {
    __wabUrl?: string;
    __wabHeaders?: Record<string, string>;
  }
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSetHeader = xhrProto.setRequestHeader;
  const originalSend = xhrProto.send;

  xhrProto.open = function (this: TrackedXHR, method: string, url: string | URL, ...rest: unknown[]) {
    this.__wabUrl = typeof url === 'string' ? url : url.href;
    this.__wabHeaders = {};
    // @ts-expect-error — forwarding the original variadic signature verbatim.
    return originalOpen.call(this, method, url, ...rest);
  };

  xhrProto.setRequestHeader = function (this: TrackedXHR, name: string, value: string) {
    if (this.__wabHeaders) this.__wabHeaders[name] = value;
    return originalSetHeader.call(this, name, value);
  };

  xhrProto.send = function (this: TrackedXHR, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      if ((this.__wabUrl ?? '').includes('/api/') && this.__wabHeaders) {
        mergeInteresting(this.__wabHeaders);
      }
    } catch {
      // best-effort
    }
    return originalSend.call(this, body);
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

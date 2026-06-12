// MAIN-world interceptor for Bolt, injected at document_start. Must stay
// import-free. The Bolt project URL uses a slug (/~/sb1-...), not the numeric
// chat id the API is keyed by, so the content script can't build the
// /api/chats/{id} URL from the path. Instead, wrap window.fetch AND
// XMLHttpRequest to capture the page's own GET /api/chats/{id} response body as
// it loads, and buffer the latest one for the content script to collect.

(() => {
  const REQUEST_TYPE = 'WAB_BOLT_GET_CONVERSATION';
  const RESPONSE_TYPE = 'WAB_BOLT_CONVERSATION';
  const CHAT_API = /\/api\/chats\/\d+/;

  let latestChat: unknown = null;

  function rememberIfChat(url: string, bodyText: string): void {
    if (!CHAT_API.test(url)) return;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
        latestChat = parsed;
      }
    } catch {
      // not the JSON we expected; ignore
    }
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (CHAT_API.test(url)) {
        // Clone so the page still consumes the body normally.
        response
          .clone()
          .text()
          .then((text) => rememberIfChat(url, text))
          .catch(() => {});
      }
    } catch {
      // never break the page's own fetch
    }
    return response;
  };

  // --- XMLHttpRequest ---
  interface TrackedXHR extends XMLHttpRequest {
    __wabUrl?: string;
  }
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  xhrProto.open = function (this: TrackedXHR, method: string, url: string | URL, ...rest: unknown[]) {
    this.__wabUrl = typeof url === 'string' ? url : url.href;
    this.addEventListener('load', () => {
      try {
        if (this.__wabUrl && CHAT_API.test(this.__wabUrl) && typeof this.responseText === 'string') {
          rememberIfChat(this.__wabUrl, this.responseText);
        }
      } catch {
        // best-effort
      }
    });
    // @ts-expect-error — forwarding the original variadic signature verbatim.
    return originalOpen.call(this, method, url, ...rest);
  };

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
    window.postMessage({ type: RESPONSE_TYPE, conversation: latestChat }, window.location.origin);
  });
})();

// MAIN-world interceptor for Emergent (app.emergent.sh), injected at
// document_start. Must stay import-free. The chat URL is just "/chat" — it
// carries no job id — so the content script can't build the trajectory API URL
// from the path. The page itself polls
// GET https://api.emergent.sh/trajectories/v0/stream?job_id=<uuid>, so we wrap
// window.fetch AND XMLHttpRequest to remember the latest job_id the page asks
// for, and hand it to the content script on request.

(() => {
  const REQUEST_TYPE = 'WAB_EMERGENT_GET_JOB_ID';
  const RESPONSE_TYPE = 'WAB_EMERGENT_JOB_ID';
  const JOB_ID_RE = /\/trajectories\/[^?]*\bjob_id=([0-9a-f-]{16,})/i;

  let latestJobId: string | null = null;

  function rememberFromUrl(url: string): void {
    const match = JOB_ID_RE.exec(url);
    if (match?.[1]) latestJobId = match[1];
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      rememberFromUrl(url);
    } catch {
      // never break the page's own fetch
    }
    return originalFetch(input, init);
  };

  // --- XMLHttpRequest ---
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  xhrProto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      rememberFromUrl(typeof url === 'string' ? url : url.href);
    } catch {
      // best-effort
    }
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
    window.postMessage({ type: RESPONSE_TYPE, jobId: latestJobId }, window.location.origin);
  });
})();

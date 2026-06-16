// Content script for Anything (anything.com, ISOLATED world). Must stay
// import-free. Anything keys each build by an opaque slug in the URL
// (/build/<slug>) that is NOT the projectGroup id the GraphQL API needs, and
// meters each chat turn through POST https://www.anything.com/api/graphql,
// authenticated with an `authorization` JWT the page also mirrors into
// localStorage["authToken"]. On COLLECT we ask the MAIN-world interceptor
// (anything-main.ts) — which sniffs the real projectGroupId + auth token from
// the page's own GraphQL traffic — to replay GetProjectGroupRevisionsForChat and
// hand the per-revision usage to anything-parse.ts. Wrapped in an IIFE to avoid
// global-scope collisions with other content scripts.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

const REQUEST_TYPE = 'WAB_ANYTHING_GET_REVISIONS';
const RESPONSE_TYPE = 'WAB_ANYTHING_REVISIONS';

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function findChatInput(): HTMLTextAreaElement | HTMLElement | null {
  const editable = Array.from(
    document.querySelectorAll<HTMLElement>('[contenteditable="true"]'),
  ).filter(isVisible);
  if (editable.length > 0) {
    return editable.reduce((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height > ar.width * ar.height ? b : a;
    });
  }
  const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(
    isVisible,
  );
  if (textareas.length > 0) {
    return textareas.reduce((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height > ar.width * ar.height ? b : a;
    });
  }
  return null;
}

function fillPrompt(text: string): { ok: true } | { ok: false; error: string } {
  const input = findChatInput();
  if (!input) {
    return { ok: false, error: 'No visible chat input found on this page' };
  }
  input.focus();
  if (input instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  }
  return { ok: true };
}

interface RevisionsResult {
  projectGroupId: string | null;
  revisions: unknown[] | null;
  error: string | null;
}

// Ask the MAIN-world interceptor to replay the revisions query for the current
// build. We let it pick the projectGroupId it sniffed from the page (more
// reliable than anything derivable from the opaque /build/<slug> URL).
function requestRevisions(timeoutMs = 15000): Promise<RevisionsResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({
        projectGroupId: null,
        revisions: null,
        error: 'timed out waiting for the Anything build data',
      });
    }, timeoutMs);
    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data: unknown = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { type?: string }).type === RESPONSE_TYPE
      ) {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        const message = data as {
          projectGroupId?: unknown;
          revisions?: unknown;
          error?: unknown;
        };
        resolve({
          projectGroupId:
            typeof message.projectGroupId === 'string' ? message.projectGroupId : null,
          revisions: Array.isArray(message.revisions) ? message.revisions : null,
          error: typeof message.error === 'string' ? message.error : null,
        });
      }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: REQUEST_TYPE }, window.location.origin);
  });
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  const { projectGroupId, revisions, error } = await requestRevisions();
  if (!revisions) {
    return {
      ok: false,
      error:
        error ??
        'Could not read the build usage — let the build finish and reload the page, then retry.',
    };
  }
  return {
    ok: true,
    // The opaque /build/<slug> is the stable identifier the user sees; fall back
    // to the resolved projectGroupId when the path has no slug.
    appId: window.location.pathname.split('/').filter(Boolean).pop() ?? projectGroupId ?? 'unknown',
    conversation: { projectGroupId, revisions },
  };
}

chrome.runtime.onMessage.addListener(
  (request: AnyRequest, _sender, sendResponse: (response: unknown) => void) => {
    if (request.type === 'FILL_PROMPT') {
      sendResponse(fillPrompt(request.text));
      return false;
    }
    if (request.type === 'COLLECT') {
      void collectConversation().then(sendResponse);
      return true; // async — we round-trip to the MAIN world
    }
    return false;
  },
);
})();

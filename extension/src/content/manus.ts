// Content script for Manus (manus.im, ISOLATED world). Must stay import-free.
// Manus keys each build by the sessionUid in the URL (/app/<sessionUid>) and
// meters it through POST api.manus.im/session.v1.SessionService/GetSession,
// authenticated with a Bearer token the page keeps in memory. We can't read
// that token here, so on COLLECT we ask the MAIN-world interceptor
// (manus-main.ts) to replay GetSession for the current session and hand the
// `{ session: {...} }` response to manus-parse.ts. Wrapped in an IIFE to avoid
// global-scope collisions with other content scripts.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

const REQUEST_TYPE = 'WAB_MANUS_GET_SESSION';
const RESPONSE_TYPE = 'WAB_MANUS_SESSION';

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

// The build's sessionUid is the last path segment of /app/<sessionUid>.
function extractSessionUid(): string | null {
  const match = window.location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

function requestSession(
  sessionUid: string,
  timeoutMs = 15000,
): Promise<{ session: unknown; error: string | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({ session: null, error: 'timed out waiting for the Manus session data' });
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
        const message = data as { session?: unknown; error?: unknown };
        resolve({
          session: message.session ?? null,
          error: typeof message.error === 'string' ? message.error : null,
        });
      }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: REQUEST_TYPE, sessionUid }, window.location.origin);
  });
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  const sessionUid = extractSessionUid();
  if (!sessionUid) {
    return {
      ok: false,
      error: 'Open a Manus build (manus.im/app/<id>) before collecting.',
    };
  }
  const { session, error } = await requestSession(sessionUid);
  if (!session) {
    return {
      ok: false,
      error:
        error ??
        'Could not read the session usage — let the build finish and reload the page, then retry.',
    };
  }
  return { ok: true, appId: sessionUid, conversation: session };
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

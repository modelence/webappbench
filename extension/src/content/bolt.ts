// Content script for Bolt (ISOLATED world). Must stay import-free. Bolt exposes
// the chat over a REST endpoint (GET https://bolt.new/api/chats/{id}), but the
// project URL uses a slug (/~/sb1-...) rather than the numeric chat id, so we
// can't always build the API URL from the path. On COLLECT we therefore prefer
// the conversation captured by the MAIN-world interceptor (bolt-main.ts) from
// the page's own request; if that's unavailable, we fall back to discovering
// the numeric chat id from the page and fetching it directly. Wrapped in an
// IIFE to avoid global-scope name collisions with other content scripts.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

const REQUEST_TYPE = 'WAB_BOLT_GET_CONVERSATION';
const RESPONSE_TYPE = 'WAB_BOLT_CONVERSATION';

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function findChatInput(): HTMLTextAreaElement | HTMLElement | null {
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
  const editable = Array.from(
    document.querySelectorAll<HTMLElement>('[contenteditable="true"]'),
  ).filter(isVisible);
  return editable[0] ?? null;
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

// Discover the numeric chat id the /api/chats/{id} endpoint is keyed by. The
// project URL uses a slug (/~/sb1-...), so the id isn't in the path — scan the
// page's inline scripts/JSON for an "/api/chats/{digits}" reference or a
// `"chatId": <digits>` / `"id": <digits>` field near a chat payload.
function extractChatId(): string | null {
  const fromPath = window.location.pathname.match(/chats?\/(\d+)/i);
  if (fromPath?.[1]) return fromPath[1];
  const fromQuery = new URLSearchParams(window.location.search).get('chatId');
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

  const html = document.documentElement.innerHTML;
  const apiRef = html.match(/\/api\/chats\/(\d+)/);
  if (apiRef?.[1]) return apiRef[1];
  const chatIdField = html.match(/["']chatId["']\s*:\s*["']?(\d{6,})/);
  if (chatIdField?.[1]) return chatIdField[1];
  return null;
}

function requestBufferedConversation(timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
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
        resolve((data as { conversation?: unknown }).conversation ?? null);
      }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: REQUEST_TYPE }, window.location.origin);
  });
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  // 1. Prefer the conversation the page already loaded (captured in MAIN world).
  const buffered = await requestBufferedConversation();
  if (buffered) {
    return { ok: true, appId: extractChatId() ?? '', conversation: buffered };
  }

  // 2. Fall back to fetching by the discovered numeric chat id.
  const chatId = extractChatId();
  if (!chatId) {
    return {
      ok: false,
      error:
        'Could not capture the chat — open the build\'s chat and let it load (the conversation must have loaded since the page opened), then retry',
    };
  }
  const url = `${window.location.origin}/api/chats/${chatId}`;
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? ' — make sure you are signed in to bolt.new'
          : '';
      return { ok: false, error: `Chat request failed: HTTP ${response.status}${hint}` };
    }
    const conversation: unknown = await response.json();
    return { ok: true, appId: chatId, conversation };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Chat request failed: ${message}` };
  }
}

chrome.runtime.onMessage.addListener(
  (request: AnyRequest, _sender, sendResponse: (response: unknown) => void) => {
    if (request.type === 'FILL_PROMPT') {
      sendResponse(fillPrompt(request.text));
      return false;
    }
    if (request.type === 'COLLECT') {
      void collectConversation().then(sendResponse);
      return true; // async response
    }
    return false;
  },
);
})();

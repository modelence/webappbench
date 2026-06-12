// Content script for Modelence (ISOLATED world). Must stay import-free. Unlike
// base44, Modelence has no on-demand conversation endpoint — the chat arrives
// over a Socket.IO WebSocket. The MAIN-world interceptor (modelence-main.ts)
// buffers the latest `liveQueryData` chat payload; this script fills the chat
// input and, on COLLECT, asks the interceptor for that buffered payload.
// Wrapped in an IIFE so its top-level names don't collide with other
// isolated-world content scripts sharing the same global script scope.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

const REQUEST_TYPE = 'WAB_MODELENCE_GET_CONVERSATION';
const RESPONSE_TYPE = 'WAB_MODELENCE_CONVERSATION';

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

function extractChatId(): string | undefined {
  // Modelence chat URLs carry the chat id as a path segment or query param;
  // fall back to letting the interceptor return its most recent chat.
  const fromQuery = new URLSearchParams(window.location.search).get('chatId');
  if (fromQuery) return fromQuery;
  const match = window.location.pathname.match(/chat[s]?\/([a-f0-9]{24})/i);
  return match?.[1];
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
    window.postMessage({ type: REQUEST_TYPE, chatId: extractChatId() }, window.location.origin);
  });
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  const conversation = await requestBufferedConversation();
  if (!conversation) {
    return {
      ok: false,
      error:
        'No chat data captured yet — open the agent chat and let it load (the run must have streamed at least once since the page opened), then retry',
    };
  }
  const appId = extractChatId() ?? '';
  return { ok: true, appId, conversation };
}

chrome.runtime.onMessage.addListener(
  (request: AnyRequest, _sender, sendResponse: (response: unknown) => void) => {
    if (request.type === 'FILL_PROMPT') {
      sendResponse(fillPrompt(request.text));
      return false;
    }
    if (request.type === 'COLLECT') {
      void collectConversation().then(sendResponse);
      return true;
    }
    return false;
  },
);
})();

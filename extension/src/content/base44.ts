// Content script for base44 (ISOLATED world). Must stay import-free: MV3
// content scripts are loaded as classic scripts, not ES modules. All metric
// computation happens in the popup; this script only fills the chat input and
// returns the raw conversation JSON.

type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

const AUTH_REQUEST_TYPE = 'WAB_GET_AUTH_HEADERS';
const AUTH_RESPONSE_TYPE = 'WAB_AUTH_HEADERS';

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function findChatInput(): HTMLTextAreaElement | HTMLElement | null {
  const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(
    isVisible,
  );
  if (textareas.length > 0) {
    // Prefer the largest visible textarea — the chat/creation box dominates.
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
    // React tracks the input through its own value setter; bypass the wrapper
    // so the change is registered as if the user typed it.
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

function extractAppId(): string | null {
  const match = window.location.pathname.match(/\/apps\/([a-z0-9]+)/i);
  return match?.[1] ?? null;
}

function requestCapturedAuthHeaders(timeoutMs = 500): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({});
    }, timeoutMs);
    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data: unknown = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { type?: string }).type === AUTH_RESPONSE_TYPE
      ) {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        const headers = (data as { headers?: Record<string, string> }).headers;
        resolve(headers ?? {});
      }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: AUTH_REQUEST_TYPE }, window.location.origin);
  });
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  const appId = extractAppId();
  if (!appId) {
    return {
      ok: false,
      error: `Could not find an app id in the URL (${window.location.pathname}); open the app editor page`,
    };
  }
  const url = `${window.location.origin}/api/apps/${appId}/chat/full-conversation?limit=100`;
  const capturedHeaders = await requestCapturedAuthHeaders();
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: capturedHeaders,
    });
    if (!response.ok) {
      return { ok: false, error: `Conversation request failed: HTTP ${response.status}` };
    }
    const conversation: unknown = await response.json();
    return { ok: true, appId, conversation };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Conversation request failed: ${message}` };
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

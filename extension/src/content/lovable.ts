// Content script for Lovable (ISOLATED world). Must stay import-free. Lovable
// renders client-side but, on reload, the server embeds the project
// conversation into the page as Next.js RSC flight chunks
// (self.__next_f.push([1, "<chunk>"])). Those chunks include assistant
// messages with `thinking_time_ms` (duration) and `cost_credits` (spend).
// This script fills the chat input and, on COLLECT, reassembles the flight
// text from the inline scripts and returns it for the popup to parse.
// Wrapped in an IIFE so its top-level names don't collide with other
// isolated-world content scripts sharing the same global script scope.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

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

function extractProjectId(): string {
  const match = window.location.pathname.match(/projects\/([0-9a-f-]{36})/i);
  return match?.[1] ?? '';
}

// Reassemble the Next.js flight stream from the inline scripts. Each emits
// self.__next_f.push([1, "<chunk>"]); concatenating the chunk strings in DOM
// order reproduces the streamed flight text.
function readFlightText(): string {
  const parts: string[] = [];
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (!text.includes('__next_f')) continue;
    // Match push([1, "<chunk>"]) and push([1,"<chunk>", ...]) forms.
    const re = /self\.__next_f\.push\(\[\s*1\s*,\s*"((?:\\.|[^"\\])*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const encoded = m[1];
      if (encoded === undefined) continue;
      try {
        // The captured group is a JS string literal body; decode escapes.
        parts.push(JSON.parse(`"${encoded}"`) as string);
      } catch {
        // Skip a chunk that doesn't decode cleanly.
      }
    }
  }
  return parts.join('');
}

function collectConversation():
  | { ok: true; appId: string; conversation: unknown }
  | { ok: false; error: string } {
  const flight = readFlightText();
  if (!flight || !/thinking_time_ms|cost_credits/.test(flight)) {
    return {
      ok: false,
      error:
        'No build data found in the page — reload the Lovable project so it re-embeds the conversation, then retry',
    };
  }
  return { ok: true, appId: extractProjectId(), conversation: { flight } };
}

chrome.runtime.onMessage.addListener(
  (request: AnyRequest, _sender, sendResponse: (response: unknown) => void) => {
    if (request.type === 'FILL_PROMPT') {
      sendResponse(fillPrompt(request.text));
      return false;
    }
    if (request.type === 'COLLECT') {
      sendResponse(collectConversation());
      return false;
    }
    return false;
  },
);
})();

// Content script for v0.app (ISOLATED world). Must stay import-free. Like
// Replit, v0 exposes per-run "Worked for X" summary cards in the chat feed.
// Each is a Radix accordion trigger; expanding it reveals label/value rows
// including "Credits used" (a credit count that is 1:1 with USD) and "Model
// used". There's no API/socket payload — the data is only in the DOM — so this
// script clicks each summary open and scrapes the rows by their text labels
// (class names are hashed/unstable). Wrapped in an IIFE to avoid global-scope
// name collisions with other isolated-world content scripts.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

interface RunSummary {
  seconds: number | null;
  credits: number | null;
  model: string | null;
}

const CREDITS_PATTERN = /(\d+(?:\.\d+)?)\s*credits?/i;

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 1500, stepMs = 80): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

// "Worked for 4m 54s" / "4m 54s" / "Worked for 50 seconds" → total seconds.
function parseSeconds(text: string): number | null {
  const t = text.toLowerCase();
  let total = 0;
  let matched = false;
  const hr = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (hr?.[1]) {
    total += parseFloat(hr[1]) * 3600;
    matched = true;
  }
  const min = t.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
  if (min?.[1]) {
    total += parseFloat(min[1]) * 60;
    matched = true;
  }
  const sec = t.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/);
  if (sec?.[1]) {
    total += parseFloat(sec[1]);
    matched = true;
  }
  return matched ? total : null;
}

// The expanded panel rows are `<span>label</span><span>value</span>` pairs in a
// justify-between flex row. Find the row whose label matches and return its
// value text.
function valueForLabel(card: Element, label: string): string | null {
  const labelLc = label.toLowerCase();
  const spans = Array.from(card.querySelectorAll('span'));
  for (const node of spans) {
    if ((node.textContent ?? '').trim().toLowerCase() === labelLc) {
      const row = node.parentElement;
      if (!row) continue;
      const value = Array.from(row.querySelectorAll('span')).find(
        (n) => n !== node && (n.textContent ?? '').trim().length > 0,
      );
      if (value?.textContent) return value.textContent.trim();
    }
  }
  return null;
}

// A summary card is the accordion trigger button whose label contains
// "Worked for …".
function findSummaryButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('button')).filter((b) =>
    /worked for\s+\S/i.test(b.textContent ?? ''),
  );
}

function readSummary(card: Element, triggerText: string): RunSummary {
  const credits = valueForLabel(card, 'Credits used');
  const model = valueForLabel(card, 'Model used');
  // Duration lives in the trigger ("Worked for 4m 54s"), not the panel.
  const seconds = parseSeconds(triggerText);
  const creditMatch = (credits ?? '').match(CREDITS_PATTERN);
  return {
    seconds,
    credits: creditMatch?.[1] ? parseFloat(creditMatch[1]) : null,
    model: model ?? null,
  };
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  const buttons = findSummaryButtons();
  if (buttons.length === 0) {
    return {
      ok: false,
      error:
        'No "Worked for…" summary found — let v0 finish a run so the summary card appears, then retry',
    };
  }

  const summaries: RunSummary[] = [];
  for (const button of buttons) {
    const triggerText = button.textContent ?? '';

    // The "Credits used"/"Model used" rows live in the Radix content region,
    // which is a SIBLING of the trigger (not a descendant). The trigger's
    // aria-controls points at that region's id; fall back to the accordion
    // item wrapper that contains both.
    const regionId = button.getAttribute('aria-controls');
    const panel = (): Element | null =>
      (regionId && document.getElementById(regionId)) ||
      button.closest('[data-state]')?.parentElement?.querySelector('[role="region"]') ||
      null;
    // Read across the trigger AND its panel.
    const cardText = (): string => `${triggerText} ${panel()?.textContent ?? ''}`;

    // Expand if collapsed — the content region only renders the rows once open.
    if (button.getAttribute('aria-expanded') !== 'true') {
      button.click();
      await waitFor(() => CREDITS_PATTERN.test(cardText()));
    }

    const region = panel();
    summaries.push(readSummary(region ?? button, triggerText));
  }

  const totalSeconds = summaries.reduce((sum, s) => sum + (s.seconds ?? 0), 0);
  const totalCredits = summaries.reduce((sum, s) => sum + (s.credits ?? 0), 0);
  const anySeconds = summaries.some((s) => s.seconds !== null);
  const anyCredits = summaries.some((s) => s.credits !== null);
  const model = summaries.map((s) => s.model).find((m) => m) ?? null;

  const match = window.location.pathname.match(/chat\/([^/?#]+)/);
  const appId = match?.[1] ?? '';

  return {
    ok: true,
    appId,
    conversation: {
      durationSeconds: anySeconds ? totalSeconds : null,
      credits: anyCredits ? totalCredits : null,
      model,
      runCount: summaries.length,
    },
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
      return true; // async — we click + wait
    }
    return false;
  },
);
})();

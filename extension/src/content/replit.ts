// Content script for Replit (ISOLATED world). Must stay import-free. Replit's
// Agent exposes per-run "Worked for X seconds" summary cards in the chat feed.
// Each card is a collapsed button; expanding it reveals a "Time worked" value
// and an "Agent Usage" dollar amount. There's no API/socket payload to read —
// the data lives only in the DOM — so this script clicks each summary open and
// scrapes the label/value rows. CSS-module class names are hashed and unstable,
// so we match on the visible text labels instead.
// Wrapped in an IIFE to avoid global-scope name collisions with other
// isolated-world content scripts.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

interface RunSummary {
  seconds: number | null;
  usd: number | null;
}

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

// Poll `check` until it returns true or the timeout elapses (content renders
// asynchronously after an expand click).
async function waitFor(check: () => boolean, timeoutMs = 1500, stepMs = 80): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

// "Worked for 50 seconds" / "Time worked: 50 seconds" → 50. Also handles
// minutes ("Worked for 2 minutes 5 seconds" / "1 min 30 sec").
function parseSeconds(text: string): number | null {
  const t = text.toLowerCase();
  let total = 0;
  let matched = false;
  const minMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m\b)/);
  if (minMatch?.[1]) {
    total += parseFloat(minMatch[1]) * 60;
    matched = true;
  }
  const secMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s\b)/);
  if (secMatch?.[1]) {
    total += parseFloat(secMatch[1]);
    matched = true;
  }
  return matched ? total : null;
}

function parseUsd(text: string): number | null {
  const m = text.match(/\$\s*(\d+(?:\.\d+)?)/);
  return m?.[1] ? parseFloat(m[1]) : null;
}

// Find the value text paired with a given label inside an expanded summary
// card. The card lays out each metric as a horizontal row: a label on the left,
// a value on the right. The label and value can be nested at different depths
// (e.g. "Agent Usage" sits next to a chevron in its own sub-div, while the
// "$0.14" value is in a sibling sub-div), so we locate the label node, climb to
// the smallest ancestor that *also* contains a value matching `wantPattern`,
// then return the matched value. CSS-module classes are hashed, so we rely on
// text + structure only.
function valueForLabel(card: Element, label: string, wantPattern: RegExp): string | null {
  const labelLc = label.toLowerCase();
  const candidates = Array.from(card.querySelectorAll('span, div')).filter(
    (n) => (n.textContent ?? '').trim().toLowerCase() === labelLc,
  );
  for (const labelNode of candidates) {
    // Climb ancestors until one contains a value matching the pattern that
    // isn't the label itself.
    let ancestor: Element | null = labelNode.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth++) {
      const valueNode = Array.from(ancestor.querySelectorAll('span, div')).find((n) => {
        const text = (n.textContent ?? '').trim();
        return !n.contains(labelNode) && !labelNode.contains(n) && wantPattern.test(text);
      });
      if (valueNode?.textContent) {
        const m = valueNode.textContent.match(wantPattern);
        return (m ? m[0] : valueNode.textContent).trim();
      }
      ancestor = ancestor.parentElement;
    }
  }
  return null;
}

// The "Agent Usage" row is a nested expandable (label + chevron). Return the
// clickable ancestor of the label so we can open it to reveal the $ figure.
function findAgentUsageToggle(card: Element): HTMLElement | null {
  const labelNode = Array.from(card.querySelectorAll('span, div')).find(
    (n) => (n.textContent ?? '').trim().toLowerCase() === 'agent usage',
  );
  if (!labelNode) return null;
  // Prefer an explicit interactive ancestor; otherwise click the row that pairs
  // the label with a chevron svg.
  const interactive = labelNode.closest<HTMLElement>(
    'button, [role="button"], [data-react-aria-pressable], [tabindex]',
  );
  if (interactive) return interactive;
  let el: Element | null = labelNode.parentElement;
  for (let i = 0; el && i < 4; i++) {
    if (el.querySelector('svg')) return el as HTMLElement;
    el = el.parentElement;
  }
  return labelNode.parentElement as HTMLElement | null;
}

// A summary card is the button whose label contains "Worked for ... second(s)".
function findSummaryButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('button')).filter((b) =>
    /worked for\s+\d/i.test(b.textContent ?? ''),
  );
}

const TIME_PATTERN = /\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)/i;
const USD_PATTERN = /\$\s*\d+(?:\.\d+)?/;

function readSummary(card: Element): RunSummary {
  const text = card.textContent ?? '';
  // Prefer the labelled "Time worked" / "Agent Usage" rows; fall back to the
  // card text (the collapsed button shows "Worked for…", and there's only one
  // dollar figure per card).
  const timeWorked = valueForLabel(card, 'Time worked', TIME_PATTERN);
  const agentUsage = valueForLabel(card, 'Agent Usage', USD_PATTERN);
  return {
    seconds: parseSeconds(timeWorked ?? text),
    usd: parseUsd(agentUsage ?? text),
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
        'No "Worked for…" summary found — let the Agent finish a run so the summary card appears, then retry',
    };
  }

  const summaries: RunSummary[] = [];
  for (const button of buttons) {
    // The card root wraps the button AND its (initially empty) detail panel.
    // Prefer the EndOfRunSummary root; fall back to climbing two levels.
    const root =
      button.closest<HTMLElement>('[class*="EndOfRunSummary"]') ??
      button.parentElement?.parentElement ??
      button.parentElement ??
      button;
    const card = () => root;

    // 1. Expand the outer card; the detail panel ("Time worked" / "Agent
    //    Usage") is empty until then and renders asynchronously after the click.
    if (!/time worked/i.test(card().textContent ?? '')) {
      button.click();
      await waitFor(() => /time worked/i.test(card().textContent ?? ''));
    }

    // 2. "Agent Usage" has its own nested toggle; the dollar value only renders
    //    once it's expanded. If no "$" is present, click the Agent Usage row.
    if (!USD_PATTERN.test(card().textContent ?? '')) {
      const usageToggle = findAgentUsageToggle(card());
      if (usageToggle) {
        usageToggle.click();
        await waitFor(() => USD_PATTERN.test(card().textContent ?? ''));
      }
    }

    summaries.push(readSummary(card()));
  }

  // Sum across all runs in the conversation (one card per Agent run).
  const totalSeconds = summaries.reduce((sum, s) => sum + (s.seconds ?? 0), 0);
  const totalUsd = summaries.reduce((sum, s) => sum + (s.usd ?? 0), 0);
  const anySeconds = summaries.some((s) => s.seconds !== null);
  const anyUsd = summaries.some((s) => s.usd !== null);

  const match = window.location.pathname.match(/@[^/]+\/([^/?#]+)/);
  const appId = match?.[1] ?? '';

  return {
    ok: true,
    appId,
    conversation: {
      durationSeconds: anySeconds ? totalSeconds : null,
      usd: anyUsd ? totalUsd : null,
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

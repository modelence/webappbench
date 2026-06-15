// Content script for Emergent (app.emergent.sh, ISOLATED world). Must stay
// import-free. Emergent streams its agent run as Server-Sent-Events from
// GET https://api.emergent.sh/trajectories/v0/stream?job_id=<uuid> (Bearer
// auth). On COLLECT we discover the active job_id (preferring the one captured
// by the MAIN-world interceptor from the page's own request, falling back to
// localStorage), read the Supabase access token the page stored in
// localStorage, replay the full trajectory stream, and hand the raw step items
// to emergent-parse.ts. Wrapped in an IIFE to avoid global-scope collisions.

(() => {
type FillRequest = { type: 'FILL_PROMPT'; text: string };
type CollectRequest = { type: 'COLLECT' };
type AnyRequest = FillRequest | CollectRequest;

const REQUEST_TYPE = 'WAB_EMERGENT_GET_JOB_ID';
const RESPONSE_TYPE = 'WAB_EMERGENT_JOB_ID';
const API_ORIGIN = 'https://api.emergent.sh';
const STREAM_TIMEOUT_MS = 15000;

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

// Supabase persists the session as localStorage["sb-<ref>-auth-token"], a JSON
// blob with an `access_token`. The API expects it as a Bearer token.
function readAccessToken(): string | null {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
    try {
      const value = localStorage.getItem(key);
      if (!value) continue;
      const parsed: unknown = JSON.parse(value);
      const token = (parsed as { access_token?: unknown })?.access_token;
      if (typeof token === 'string' && token.length > 0) return token;
    } catch {
      // not the blob we expected; keep scanning
    }
  }
  return null;
}

// Ask the MAIN-world interceptor for the job_id it saw the page request.
function requestCapturedJobId(timeoutMs = 1000): Promise<string | null> {
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
        const jobId = (data as { jobId?: unknown }).jobId;
        resolve(typeof jobId === 'string' && jobId.length > 0 ? jobId : null);
      }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: REQUEST_TYPE }, window.location.origin);
  });
}

// Fallback: the active build's job id is the first entry of the persisted
// recent-jobs cache (localStorage["persist:recentJobsCache"].recentTabs).
function readJobIdFromStorage(): string | null {
  try {
    const raw = localStorage.getItem('persist:recentJobsCache');
    if (!raw) return null;
    const cache: unknown = JSON.parse(raw);
    const recentTabs = (cache as { recentTabs?: unknown })?.recentTabs;
    const list: unknown = typeof recentTabs === 'string' ? JSON.parse(recentTabs) : recentTabs;
    if (Array.isArray(list) && typeof list[0] === 'string' && list[0].length > 0) {
      return list[0];
    }
  } catch {
    // malformed cache; ignore
  }
  return null;
}

async function resolveJobId(): Promise<string | null> {
  return (await requestCapturedJobId()) ?? readJobIdFromStorage();
}

interface TrajectoryItem {
  id?: string;
  request_id?: string;
  traj_payload?: unknown;
}

// Replay the full trajectory SSE stream and collect every `data: { trajectories:
// { data: [...] } }` item. The stream backlog ends with a
// `{ "status": "no_stream_found" }` frame (then it idles waiting for live
// updates), so we stop there — or on timeout / EOF.
async function fetchTrajectoryItems(
  jobId: string,
  token: string,
): Promise<{ ok: true; items: TrajectoryItem[] } | { ok: false; error: string }> {
  const url = `${API_ORIGIN}/trajectories/v0/stream?job_id=${encodeURIComponent(jobId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? ' — make sure you are signed in to Emergent'
          : '';
      return { ok: false, error: `Trajectory request failed: HTTP ${response.status}${hint}` };
    }
    if (!response.body) {
      return { ok: false, error: 'Trajectory stream returned no body' };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reachedEnd = false;
    while (!reachedEnd) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"no_stream_found"')) reachedEnd = true;
    }
    void reader.cancel().catch(() => {});

    const items: TrajectoryItem[] = [];
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      try {
        const frame: unknown = JSON.parse(trimmed.slice(5).trim());
        const data = (frame as { trajectories?: { data?: unknown } })?.trajectories?.data;
        if (Array.isArray(data)) items.push(...(data as TrajectoryItem[]));
      } catch {
        // partial / non-JSON frame; skip
      }
    }

    if (items.length === 0) {
      return {
        ok: false,
        error: 'No trajectory steps returned — let the agent finish its run, then retry',
      };
    }
    return { ok: true, items };
  } catch (error: unknown) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    const message = aborted ? 'timed out reading the stream' : String(error);
    return { ok: false, error: `Trajectory request failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function collectConversation(): Promise<
  { ok: true; appId: string; conversation: unknown } | { ok: false; error: string }
> {
  const jobId = await resolveJobId();
  if (!jobId) {
    return {
      ok: false,
      error:
        'Could not determine the build job — open the build chat and let it load (so the page requests its trajectory), then retry',
    };
  }
  const token = readAccessToken();
  if (!token) {
    return { ok: false, error: 'Not signed in to Emergent (no access token found)' };
  }

  const result = await fetchTrajectoryItems(jobId, token);
  if (!result.ok) return result;

  return { ok: true, appId: jobId, conversation: { jobId, items: result.items } };
}

chrome.runtime.onMessage.addListener(
  (request: AnyRequest, _sender, sendResponse: (response: unknown) => void) => {
    if (request.type === 'FILL_PROMPT') {
      sendResponse(fillPrompt(request.text));
      return false;
    }
    if (request.type === 'COLLECT') {
      void collectConversation().then(sendResponse);
      return true; // async — we fetch + read the stream
    }
    return false;
  },
);
})();

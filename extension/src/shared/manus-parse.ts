import type { ConversationMetrics } from './types.js';

// Manus (manus.im) exposes the per-build metering through its Connect-RPC
// endpoint POST https://api.manus.im/session.v1.SessionService/GetSession
// (body {"sessionUid": "<id>"}). The content script (manus.ts) replays that
// request via the MAIN-world interceptor and hands the `{ session: {...} }`
// response here.
//
// The session object carries exactly the two numbers the Manus UI shows under
// the "usage" panel:
//   - costedCredits: the build's "Credits used" (e.g. 175). Manus credits price
//     out at ~$0.01 each (e.g. Starter $19 / 1,900 credits), so cost ≈ credits
//     × $0.01. The rate is overridable in the popup.
//   - usage.cumulativeRuntimeMs: the agent-loop "Time worked" in milliseconds
//     (e.g. "510713" → ~511s). This is the builder-reported execution time and
//     is what the UI labels "Time worked" — it excludes time the run spent
//     blocked on the human, so it is shorter than the createdAt→lastMessage
//     wall-clock span (which we still expose as wallClockSeconds).
//
// Derived metrics:
//   - duration       = cumulativeRuntimeMs / 1000 (the "Time worked" figure)
//   - wallClockSeconds = (lastMessageTime − createdAt) / 1000
//   - credits        = costedCredits (cost = credits × rate applied by popup)

interface ManusUsage {
  commandsRun?: string | number;
  filesCreated?: string | number;
  cumulativeRuntimeMs?: string | number;
}

interface ManusSession {
  uid?: string;
  title?: string;
  costedCredits?: string | number;
  usage?: ManusUsage;
  createdAt?: string;
  updatedAt?: string;
  lastMessageTime?: string;
}

interface ManusPayload {
  session?: ManusSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Accept either the `{ session: {...} }` GetSession envelope or a bare session.
function extractSession(payload: unknown): ManusSession {
  if (!isRecord(payload)) {
    throw new Error('Unexpected Manus payload: not an object');
  }
  const envelope = payload as ManusPayload;
  if (isRecord(envelope.session)) return envelope.session as ManusSession;
  // A bare session object exposes its own identifying fields.
  if ('costedCredits' in payload || 'usage' in payload || 'uid' in payload) {
    return payload as ManusSession;
  }
  throw new Error('Unexpected Manus payload: missing "session"');
}

// Manus serializes large integers as strings (proto int64), so usage figures
// and costedCredits can arrive as either a number or a numeric string.
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function parseManusConversation(
  payload: unknown,
  options: { promptText?: string } = {},
): ConversationMetrics {
  const session = extractSession(payload);

  const runtimeMs = num(session.usage?.cumulativeRuntimeMs);
  const duration = runtimeMs === null ? null : Math.max(0, runtimeMs / 1000);

  const credits = num(session.costedCredits);

  if (duration === null && credits === null) {
    throw new Error(
      'No usage found for this Manus session — open the finished build and let it load, then retry',
    );
  }

  const createdMs = parseMs(session.createdAt);
  const lastMs = parseMs(session.lastMessageTime) ?? parseMs(session.updatedAt);
  const wallClockSeconds =
    createdMs !== null && lastMs !== null ? Math.max(0, (lastMs - createdMs) / 1000) : duration;

  const commandsRun = num(session.usage?.commandsRun);

  return {
    promptText: options.promptText ?? null,
    promptSubmittedAt: createdMs !== null ? new Date(createdMs).toISOString() : null,
    completedAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
    duration,
    wallClockSeconds,
    credits,
    // Manus exposes no LLM model name or token counts in the session payload.
    model: null,
    tokens: null,
    assistantMessageCount: commandsRun ?? 0,
  };
}

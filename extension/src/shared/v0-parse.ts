import type { ConversationMetrics } from './types.js';

// v0's content script scrapes the "Worked for X" summary cards from the DOM
// (no API/socket payload), expands them, and sums the time and the "Credits
// used" count across runs. v0 credits are denominated 1:1 with USD ("a $1
// credit equals $1 USD"), so cost = credits × 1 via the builder's $1 rate.

interface V0Payload {
  durationSeconds?: number | null;
  credits?: number | null;
  model?: string | null;
  runCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseV0Conversation(
  payload: unknown,
  _options: { promptText?: string } = {},
): ConversationMetrics {
  if (!isRecord(payload)) {
    throw new Error('Unexpected v0 payload');
  }
  const data = payload as V0Payload;
  const duration =
    typeof data.durationSeconds === 'number' && data.durationSeconds >= 0
      ? data.durationSeconds
      : null;
  const credits = typeof data.credits === 'number' && data.credits >= 0 ? data.credits : null;

  if (duration === null && credits === null) {
    throw new Error('No duration or credits found in the v0 summary');
  }

  return {
    promptText: null,
    promptSubmittedAt: null,
    completedAt: null,
    duration,
    wallClockSeconds: duration,
    credits,
    model: typeof data.model === 'string' ? data.model : null,
    tokens: null,
    assistantMessageCount: typeof data.runCount === 'number' ? data.runCount : 0,
  };
}

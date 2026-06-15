import type { ConversationMetrics } from './types.js';

// Replit's content script scrapes the "Worked for X seconds" summary cards from
// the DOM (there's no API/socket payload), expands them, and sums the time and
// the "Agent Usage" dollar figure across the conversation's runs. The Agent
// Usage value is already a USD amount, so this parser carries it through as
// `credits` with the builder's rate fixed at 1 ($1/"credit") — the popup then
// computes cost = credits × 1 = the scraped dollars.

interface ReplitPayload {
  durationSeconds?: number | null;
  usd?: number | null;
  runCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseReplitConversation(
  payload: unknown,
  _options: { promptText?: string } = {},
): ConversationMetrics {
  if (!isRecord(payload)) {
    throw new Error('Unexpected Replit payload');
  }
  const data = payload as ReplitPayload;
  const duration =
    typeof data.durationSeconds === 'number' && data.durationSeconds >= 0
      ? data.durationSeconds
      : null;
  // Carry the scraped USD through the cost pipeline as a $1-rate "credit".
  const usd = typeof data.usd === 'number' && data.usd >= 0 ? data.usd : null;

  if (duration === null && usd === null) {
    throw new Error('No duration or usage found in the Replit summary');
  }

  return {
    promptText: null,
    promptSubmittedAt: null,
    completedAt: null,
    duration,
    wallClockSeconds: duration,
    credits: usd,
    model: null,
    tokens: null,
    assistantMessageCount: typeof data.runCount === 'number' ? data.runCount : 0,
  };
}

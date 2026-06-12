import type { ConversationMetrics } from './types.js';

// Bolt exposes the chat via GET https://bolt.new/api/chats/{chatId}, returning
// { messages: [...] }. Per the benchmark convention, Bolt's build duration is
// the wall-clock between the FIRST message (the user prompt) and the SECOND
// message (the assistant's build response) — measured from their `createdAt`
// timestamps. Messages after the build (e.g. a publish/deploy turn) are
// ignored: we only ever look at the first two. Bolt's payload carries no cost
// signal, so cost stays null.

interface RawMessage {
  role?: string;
  content?: string;
  input?: string;
  createdAt?: string;
}

interface RawChat {
  model?: string;
  agent?: string;
  messages?: RawMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseBoltConversation(
  payload: unknown,
  _options: { promptText?: string } = {},
): ConversationMetrics {
  if (!isRecord(payload) || !Array.isArray((payload as RawChat).messages)) {
    throw new Error('Unexpected Bolt payload: missing "messages" array');
  }
  const chat = payload as RawChat;
  const messages = chat.messages ?? [];

  // First message = user prompt; second = assistant build response.
  const first = messages[0];
  const second = messages[1];
  if (!first || first.role !== 'user') {
    throw new Error('Bolt chat does not start with a user message');
  }
  if (!second || second.role !== 'assistant') {
    throw new Error('No assistant response after the prompt in the Bolt chat');
  }

  const startDate = parseDate(first.createdAt);
  const endDate = parseDate(second.createdAt);
  if (!startDate || !endDate) {
    throw new Error('Bolt messages are missing createdAt timestamps');
  }
  const duration = Math.max(0, (endDate.getTime() - startDate.getTime()) / 1000);

  return {
    promptText: first.input ?? first.content ?? null,
    promptSubmittedAt: startDate.toISOString(),
    completedAt: endDate.toISOString(),
    duration,
    wallClockSeconds: duration,
    credits: null, // no cost signal in the Bolt payload
    model: chat.model ?? null,
    tokens: null,
    assistantMessageCount: 1,
  };
}

import type { ConversationMetrics } from './types.js';

interface RawStep {
  duration?: number;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  duration?: number;
  steps?: RawStep[];
  date?: string;
  status?: string;
}

interface RawChat {
  chatId?: string;
  selectedModelId?: string;
  messages?: RawMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === 'string' ? part.text : '',
      )
      .join('');
  }
  return '';
}

function findPromptIndex(messages: RawMessage[], promptText?: string): number {
  const target = promptText?.trim();
  if (target) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'user' && textOfContent(m.content).trim() === target) return i;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * Extract duration metrics from a Modelence `liveQueryData` chat payload.
 *
 * Scope: the last user message (or the one matching `promptText`) and the
 * assistant messages that follow it, up to the next user message. Each
 * assistant message carries a top-level `duration` in milliseconds that is
 * already the sum of its own steps; the turn's duration is the sum of those.
 * User messages have no `duration`.
 *
 * Cost/tokens are not derivable from this frame — Modelence does not include
 * per-message output-token counts — so `credits`, `tokens`, and downstream
 * cost stay null.
 */
export function parseModelenceConversation(
  payload: unknown,
  options: { promptText?: string } = {},
): ConversationMetrics {
  if (!isRecord(payload) || !Array.isArray((payload as RawChat).messages)) {
    throw new Error('Unexpected Modelence payload: missing "messages" array');
  }
  const chat = payload as RawChat;
  const messages = chat.messages ?? [];

  const promptIdx = findPromptIndex(messages, options.promptText);
  if (promptIdx === -1) {
    throw new Error('No user message found in the conversation');
  }
  const promptMessage = messages[promptIdx];

  const assistantSlice: RawMessage[] = [];
  for (let i = promptIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') break;
    if (m.role === 'assistant') assistantSlice.push(m);
  }

  let durationMs: number | null = null;
  for (const m of assistantSlice) {
    if (typeof m.duration === 'number') {
      durationMs = (durationMs ?? 0) + m.duration;
    }
  }

  const promptDate = parseDate(promptMessage?.date);
  const lastAssistant = assistantSlice[assistantSlice.length - 1];
  const completedDate = parseDate(lastAssistant?.date);
  const wallClockSeconds =
    promptDate && completedDate
      ? Math.max(0, (completedDate.getTime() - promptDate.getTime()) / 1000)
      : null;

  return {
    promptText: promptMessage ? textOfContent(promptMessage.content) : null,
    promptSubmittedAt: promptDate ? promptDate.toISOString() : null,
    completedAt: completedDate ? completedDate.toISOString() : null,
    duration: durationMs === null ? null : durationMs / 1000,
    wallClockSeconds,
    credits: null,
    model: chat.selectedModelId ?? null,
    tokens: null,
    assistantMessageCount: assistantSlice.length,
  };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

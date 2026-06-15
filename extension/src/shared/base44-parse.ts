import type { ConversationMetrics, TokenTotals } from './types.js';

interface RawUsage {
  credits_charged?: number | null;
}

interface RawLoopUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
}

interface RawMessage {
  role?: string;
  content?: string | null;
  usage?: RawUsage | null;
  metadata?: { created_date?: string } | null;
  additional_message_params?: {
    agent_loop_elapsed_seconds?: number;
    agent_loop_total_usage?: RawLoopUsage;
  } | null;
}

interface RawConversation {
  model?: string;
  messages?: RawMessage[];
}

// Base44 timestamps look like "2026-06-11T19:13:02.404000" — microsecond
// precision, no timezone designator, but the values are UTC.
export function parseBase44Date(value: string | undefined): Date | null {
  if (!value) return null;
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value)
    ? value
    : `${value.replace(/(\.\d{3})\d+$/, '$1')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function findPromptIndex(messages: RawMessage[], promptText?: string): number {
  const target = promptText?.trim();
  if (target) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'user' && (m.content ?? '').trim() === target) return i;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function sumTokens(messages: RawMessage[]): TokenTotals | null {
  const totals: TokenTotals = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
  let found = false;
  for (const m of messages) {
    const usage = m.additional_message_params?.agent_loop_total_usage;
    if (!usage) continue;
    found = true;
    totals.promptTokens += usage.prompt_tokens ?? 0;
    totals.completionTokens += usage.completion_tokens ?? 0;
    totals.reasoningTokens += usage.reasoning_tokens ?? 0;
    totals.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    totals.totalTokens += usage.total_tokens ?? 0;
  }
  return found ? totals : null;
}

/**
 * Extract duration/cost metrics from a base44 `full-conversation` payload.
 *
 * Scope: the last user message (or the one matching `promptText`) and the
 * assistant messages that follow it, up to the next user message.
 * `agent_loop_elapsed_seconds`, `agent_loop_total_usage`, and
 * `credits_charged` each appear once per agent loop on its final assistant
 * message, so summing across the slice handles multi-loop turns.
 */
export function parseBase44Conversation(
  payload: unknown,
  options: { promptText?: string } = {},
): ConversationMetrics {
  if (!isRecord(payload) || !Array.isArray((payload as RawConversation).messages)) {
    throw new Error('Unexpected conversation payload: missing "messages" array');
  }
  const conversation = payload as RawConversation;
  const messages = conversation.messages ?? [];

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

  let credits: number | null = null;
  let duration: number | null = null;
  for (const m of assistantSlice) {
    const charged = m.usage?.credits_charged;
    if (typeof charged === 'number') credits = (credits ?? 0) + charged;
    const elapsed = m.additional_message_params?.agent_loop_elapsed_seconds;
    if (typeof elapsed === 'number') duration = (duration ?? 0) + elapsed;
  }

  const promptDate = parseBase44Date(promptMessage?.metadata?.created_date);
  const lastAssistant = assistantSlice[assistantSlice.length - 1];
  const completedDate = parseBase44Date(lastAssistant?.metadata?.created_date);
  const wallClockSeconds =
    promptDate && completedDate
      ? Math.max(0, (completedDate.getTime() - promptDate.getTime()) / 1000)
      : null;

  return {
    promptText: promptMessage?.content ?? null,
    promptSubmittedAt: promptDate ? promptDate.toISOString() : null,
    completedAt: completedDate ? completedDate.toISOString() : null,
    duration,
    wallClockSeconds,
    credits,
    model: conversation.model ?? null,
    tokens: sumTokens(assistantSlice),
    assistantMessageCount: assistantSlice.length,
  };
}

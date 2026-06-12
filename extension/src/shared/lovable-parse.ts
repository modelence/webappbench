import type { ConversationMetrics } from './types.js';

// Lovable renders client-side and streams the project conversation into the
// page as Next.js RSC flight chunks (self.__next_f.push([1, "<chunk>"])). On a
// page reload those chunks carry the message history, where assistant messages
// include `thinking_time_ms` (build duration) and `cost_credits` (spend). The
// flight format is not a single JSON document — it's many "<id>:<json>\n" rows
// across concatenated chunks — so rather than parse the flight protocol we scan
// the reassembled text for the message objects we care about.

interface LovableMessage {
  role?: string;
  content?: unknown;
  thinkingTimeMs?: number;
  costCredits?: number;
  createdAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk an arbitrary decoded RSC value and collect every object that looks like
 * a Lovable chat message — i.e. carries `thinking_time_ms` or `cost_credits`.
 * Lovable's flight payload nests these inside arrays/objects whose exact shape
 * isn't contractual, so we recurse rather than assume a path.
 */
function collectMessages(value: unknown, out: LovableMessage[], depth = 0): void {
  if (depth > 12 || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  const hasThinking = typeof value['thinking_time_ms'] === 'number';
  const hasCost = typeof value['cost_credits'] === 'number';
  const role = typeof value['role'] === 'string' ? (value['role'] as string) : undefined;
  if (hasThinking || hasCost || (role && 'content' in value)) {
    out.push({
      role,
      content: value['content'],
      thinkingTimeMs:
        typeof value['thinking_time_ms'] === 'number'
          ? (value['thinking_time_ms'] as number)
          : undefined,
      costCredits:
        typeof value['cost_credits'] === 'number' ? (value['cost_credits'] as number) : undefined,
      createdAt:
        typeof value['created_at'] === 'string'
          ? (value['created_at'] as string)
          : typeof value['createdAt'] === 'string'
            ? (value['createdAt'] as string)
            : undefined,
    });
  }

  for (const child of Object.values(value)) collectMessages(child, out, depth + 1);
}

/**
 * Decode the concatenated Next.js flight text into message objects. Each row is
 * "<hexid>:<json>\n"; we parse each row's JSON tail independently (rows that
 * aren't JSON, e.g. module refs like `I[...]`, are skipped) and harvest
 * messages from whatever decodes.
 */
function messagesFromFlight(flight: string): LovableMessage[] {
  const out: LovableMessage[] = [];
  const seen = new Set<LovableMessage>();
  for (const line of flight.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const tail = line.slice(colon + 1).trim();
    if (!tail || (tail[0] !== '[' && tail[0] !== '{')) continue;
    try {
      const parsed: unknown = JSON.parse(tail);
      const before = out.length;
      collectMessages(parsed, out);
      for (let i = before; i < out.length; i++) {
        const m = out[i];
        if (m) seen.add(m);
      }
    } catch {
      // Row wasn't valid JSON on its own (flight refs, partial strings); skip.
    }
  }
  return out;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  if (isRecord(content) && typeof content['text'] === 'string') return content['text'] as string;
  return '';
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface LovablePayload {
  // Reassembled Next.js flight text (joined self.__next_f chunks).
  flight: string;
  model?: string | null;
}

/**
 * Extract duration/cost metrics from Lovable's RSC flight payload.
 *
 * Duration = sum of `thinking_time_ms` across the messages (ms → s).
 * Cost = sum of `cost_credits` (converted to USD by the popup at the builder
 * rate). The flight rarely scopes cleanly to a single turn, so when a
 * `promptText` is given we keep only messages at/after the matching user
 * message; otherwise we sum across all harvested messages.
 */
export function parseLovableConversation(
  payload: unknown,
  options: { promptText?: string } = {},
): ConversationMetrics {
  if (!isRecord(payload) || typeof (payload as { flight?: unknown }).flight !== 'string') {
    throw new Error('Unexpected Lovable payload: missing flight text');
  }
  const { flight, model } = payload as unknown as LovablePayload;
  let messages = messagesFromFlight(flight);
  if (messages.length === 0) {
    throw new Error('No Lovable messages found in the page — reload the project and retry');
  }

  // Optional scoping to the run that matches the applied prompt.
  const target = options.promptText?.trim();
  if (target) {
    const idx = messages.findIndex(
      (m) => m.role === 'user' && textOfContent(m.content).trim() === target,
    );
    if (idx !== -1) messages = messages.slice(idx);
  }

  let durationMs: number | null = null;
  let credits: number | null = null;
  for (const m of messages) {
    if (typeof m.thinkingTimeMs === 'number') durationMs = (durationMs ?? 0) + m.thinkingTimeMs;
    if (typeof m.costCredits === 'number') credits = (credits ?? 0) + m.costCredits;
  }

  const dates = messages
    .map((m) => parseDate(m.createdAt))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;
  const wallClockSeconds =
    first && last ? Math.max(0, (last.getTime() - first.getTime()) / 1000) : null;

  const firstUser = messages.find((m) => m.role === 'user');

  return {
    promptText: firstUser ? textOfContent(firstUser.content) : null,
    promptSubmittedAt: first ? first.toISOString() : null,
    completedAt: last ? last.toISOString() : null,
    duration: durationMs === null ? null : durationMs / 1000,
    wallClockSeconds,
    credits,
    model: model ?? null,
    tokens: null,
    assistantMessageCount: messages.filter((m) => m.role === 'assistant').length,
  };
}

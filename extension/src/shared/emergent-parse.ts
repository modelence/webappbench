import type { ConversationMetrics, TokenTotals } from './types.js';

// Emergent (app.emergent.sh) streams its agent run as a Server-Sent-Events
// "trajectory": GET https://api.emergent.sh/trajectories/v0/stream?job_id=...
// replays every step as `data: {"trajectories": {"data": [ <item>, ... ]}}`.
// The content script (emergent.ts) collects those `data` items and hands them
// here as `{ items: [...] }`.
//
// Each item carries a `traj_payload` with the per-LLM-call metering:
//   - total_tokens / prompt_tokens / completion_tokens / cache_* tokens
//   - acc_cost: the run's *cumulative* "Credits Spent" — this is exactly the
//     number the Emergent UI shows under Run Details → Credits Spent (e.g. its
//     final value 9.41995904 renders as "9.4200"). It is denominated in
//     subscription credits ($20 / 100 = $0.20 each), NOT USD.
//   - timestamp: when the step completed (ISO 8601)
//   - request_id / full_model_name / step_num
//
// IMPORTANT: the stream emits the SAME LLM call as several trajectory items
// (one message is split into text + tool-call fragments, each a separate `id`
// sharing one `request_id` and carrying identical token/cost numbers). We must
// therefore dedupe by `request_id` before summing, or tokens double-count.
//
// Derived metrics:
//   - tokens   = sum of the per-call token fields over distinct request_ids
//   - credits  = the final (max) acc_cost = "Credits Spent" for the job. The
//     builder applies a $0.20/credit rate so cost = credits × $0.20.
//   - duration = wall-clock span of the *implementation* only. A run can open
//     with a clarification turn (the agent's `ask_human`, which then waits on
//     the human) and can close with a separate deploy turn hours later. Both
//     are excluded from duration: we span the first→last build step, dropping
//     leading `ask_human` steps and any deployment step. Tokens/credits still
//     cover every step (the clarification's cost is part of "Credits Spent").

interface TrajPayload {
  request_id?: string;
  timestamp?: string;
  step_num?: number;
  acc_cost?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  full_model_name?: string;
  // Used to scope the duration window to implementation steps.
  function_name?: string;
  action?: string;
}

interface TrajectoryItem {
  id?: string;
  request_id?: string;
  traj_payload?: TrajPayload;
}

interface EmergentPayload {
  items?: TrajectoryItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Accept either the `{ items: [...] }` wrapper or a bare array of items.
function extractItems(payload: unknown): TrajectoryItem[] {
  if (Array.isArray(payload)) return payload as TrajectoryItem[];
  if (isRecord(payload) && Array.isArray((payload as EmergentPayload).items)) {
    return (payload as EmergentPayload).items as TrajectoryItem[];
  }
  throw new Error('Unexpected Emergent payload: missing trajectory "items" array');
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// A clarification question the agent poses before (or between) building — the
// turn then blocks on the human, so it must not count toward build time.
function isClarification(call: TrajPayload): boolean {
  return call.function_name === 'ask_human';
}

// A deploy turn (often hours after the build finished). Excluded from duration.
function isDeployment(call: TrajPayload): boolean {
  const action = (call.action ?? '').toLowerCase();
  const fn = (call.function_name ?? '').toLowerCase();
  return action.startsWith('deployment') || fn.includes('deploy');
}

export function parseEmergentConversation(
  payload: unknown,
  options: { promptText?: string } = {},
): ConversationMetrics {
  const items = extractItems(payload);

  // Keep the first payload seen per request_id — duplicate fragments carry
  // identical metering, so the first wins.
  const byRequest = new Map<string, TrajPayload>();
  for (const item of items) {
    const payloadPart = item.traj_payload;
    if (!payloadPart) continue;
    const requestId = item.request_id ?? payloadPart.request_id;
    if (!requestId || byRequest.has(requestId)) continue;
    byRequest.set(requestId, payloadPart);
  }

  const calls = [...byRequest.values()];
  if (calls.length === 0) {
    throw new Error('No Emergent trajectory steps found — let the agent finish, then retry');
  }

  const tokens: TokenTotals = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0, // Emergent's payload carries no separate reasoning count.
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };

  // Tokens, credits and models cover EVERY step (including the clarification).
  let maxAccCost: number | null = null;
  const models = new Set<string>();
  for (const call of calls) {
    tokens.promptTokens += num(call.prompt_tokens);
    tokens.completionTokens += num(call.completion_tokens);
    tokens.cacheReadTokens += num(call.cache_read_input_tokens);
    tokens.cacheCreationTokens += num(call.cache_creation_input_tokens);
    tokens.totalTokens += num(call.total_tokens);

    // acc_cost is cumulative "Credits Spent"; the final (max) value is the job
    // total. Take the max rather than assume step ordering.
    if (typeof call.acc_cost === 'number' && Number.isFinite(call.acc_cost)) {
      maxAccCost = maxAccCost === null ? call.acc_cost : Math.max(maxAccCost, call.acc_cost);
    }

    if (call.full_model_name) models.add(call.full_model_name);
  }

  // Duration spans implementation steps only — drop leading clarification
  // questions and any deploy step. Fall back to all steps if that leaves none.
  const implementation = calls.filter((c) => !isClarification(c) && !isDeployment(c));
  const windowSteps = implementation.length > 0 ? implementation : calls;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const call of windowSteps) {
    const ms = parseMs(call.timestamp);
    if (ms === null) continue;
    firstMs = firstMs === null ? ms : Math.min(firstMs, ms);
    lastMs = lastMs === null ? ms : Math.max(lastMs, ms);
  }

  const duration =
    firstMs !== null && lastMs !== null ? Math.max(0, (lastMs - firstMs) / 1000) : null;

  return {
    promptText: options.promptText ?? null,
    promptSubmittedAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
    completedAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
    duration,
    wallClockSeconds: duration,
    // Round to 4 dp to match the "Credits Spent" figure the Emergent UI shows.
    credits: maxAccCost === null ? null : Math.round(maxAccCost * 1e4) / 1e4,
    model: models.size > 0 ? [...models].join(', ') : null,
    tokens,
    assistantMessageCount: calls.length,
  };
}

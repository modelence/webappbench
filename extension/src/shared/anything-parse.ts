import type { ConversationMetrics } from './types.js';

// Anything (anything.com, formerly Create) builds web/mobile apps through a
// GraphQL API at POST https://www.anything.com/api/graphql. Each chat turn is a
// "ProjectGroupRevision" and the page meters it with exactly the two numbers the
// build UI shows when you click a message's timestamp:
//   - generationDurationMs: the agent-loop "Generated in" time, in ms (e.g.
//     102944 → "1m 43s"). This is the builder-reported execution time.
//   - totalCredits: the build's credit charge in RAW units. The UI divides by
//     10,000,000 to show the credit label (e.g. 1819870000 → "182"). Anything
//     prices credits at $0.0012 each ($24 / 20,000 on Pro), so cost ≈ displayed
//     credits × $0.0012. The rate is overridable in the popup.
//
// The content script (anything.ts) replays GetProjectGroupRevisionsForChat via
// the MAIN-world interceptor (anything-main.ts, which sniffs the projectGroupId
// + auth token from the page's own GraphQL traffic) and hands the
// `{ projectGroupId, revisions: [...] }` payload here. A build can span several
// chat turns (the initial prompt + follow-ups), so we sum generationDurationMs
// and totalCredits across every non-refunded revision in the thread.
//
// Derived metrics:
//   - duration        = Σ generationDurationMs / 1000
//   - credits         = Σ totalCredits / 10,000,000 (the displayed credit count;
//                       cost = credits × rate applied by the popup)
//   - wallClockSeconds = (newest revision createdAt − oldest createdAt) / 1000
//   - promptText      = the oldest (first) user turn's chat.content

// One displayed credit = this many raw `totalCredits` units (1819870000 → 182).
const RAW_CREDITS_PER_DISPLAYED = 10_000_000;

interface AnythingRevision {
  id?: string;
  action?: string;
  status?: string;
  createdAt?: string;
  generationDurationMs?: number | string | null;
  totalCredits?: number | string | null;
  refundedAt?: string | null;
  chat?: { id?: string; content?: string } | null;
}

interface AnythingPayload {
  projectGroupId?: string;
  revisions?: AnythingRevision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractRevisions(payload: unknown): AnythingRevision[] {
  if (!isRecord(payload)) {
    throw new Error('Unexpected Anything payload: not an object');
  }
  const revisions = (payload as AnythingPayload).revisions;
  if (Array.isArray(revisions)) return revisions as AnythingRevision[];
  throw new Error('Unexpected Anything payload: missing "revisions"');
}

// totalCredits and generationDurationMs can arrive as a number or a numeric
// string (GraphQL serializes the large credit int64 as a string).
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function parseAnythingConversation(
  payload: unknown,
  options: { promptText?: string } = {},
): ConversationMetrics {
  const revisions = extractRevisions(payload);

  // A refunded revision was reverted and not charged, so it contributes neither
  // duration nor credits to the build total.
  const billable = revisions.filter((r) => !r.refundedAt);

  let durationMsTotal = 0;
  let hasDuration = false;
  let rawCreditsTotal = 0;
  let hasCredits = false;
  const createdMsValues: number[] = [];

  for (const revision of billable) {
    const durMs = num(revision.generationDurationMs);
    if (durMs !== null) {
      durationMsTotal += Math.max(0, durMs);
      hasDuration = true;
    }
    const rawCredits = num(revision.totalCredits);
    if (rawCredits !== null) {
      rawCreditsTotal += Math.max(0, rawCredits);
      hasCredits = true;
    }
    const createdMs = parseMs(revision.createdAt);
    if (createdMs !== null) createdMsValues.push(createdMs);
  }

  if (!hasDuration && !hasCredits) {
    throw new Error(
      'No usage found for this Anything build — open the finished build chat and let it load, then retry',
    );
  }

  const duration = hasDuration ? durationMsTotal / 1000 : null;
  const credits = hasCredits ? rawCreditsTotal / RAW_CREDITS_PER_DISPLAYED : null;

  const firstMs = createdMsValues.length > 0 ? Math.min(...createdMsValues) : null;
  const lastMs = createdMsValues.length > 0 ? Math.max(...createdMsValues) : null;
  const wallClockSeconds =
    firstMs !== null && lastMs !== null && lastMs > firstMs ? (lastMs - firstMs) / 1000 : duration;

  // The oldest revision is the original user prompt for this thread; prefer the
  // explicit promptText option, fall back to the captured chat content.
  const oldest =
    billable.length > 0
      ? billable.reduce((a, b) => {
          const am = parseMs(a.createdAt) ?? Infinity;
          const bm = parseMs(b.createdAt) ?? Infinity;
          return bm < am ? b : a;
        })
      : undefined;
  const capturedPrompt =
    typeof oldest?.chat?.content === 'string' && oldest.chat.content.length > 0
      ? oldest.chat.content
      : null;

  return {
    promptText: options.promptText ?? capturedPrompt,
    promptSubmittedAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
    completedAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
    duration,
    wallClockSeconds,
    credits,
    // Anything exposes no LLM model name; per-revision token counts
    // (generation.totalInputTokens/...) are admin-only, so we can't read them.
    model: null,
    tokens: null,
    assistantMessageCount: billable.length,
  };
}

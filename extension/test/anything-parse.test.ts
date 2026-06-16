import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseAnythingConversation } from '../src/shared/anything-parse.js';
import { getBuilder } from '../src/shared/builders.js';

// Mirrors the real GetProjectGroupRevisionsForChat response: the content script
// hands the `{ projectGroupId, revisions: [...] }` payload (revisions newest
// first) to the parser. Figures below were captured live from a finished build
// — generationDurationMs 102944 → "1m 43s", totalCredits 1819870000 → "182"
// (the build UI's credit label = raw ÷ 10,000,000). totalCredits is a numeric
// STRING (GraphQL serializes the credit int64 as a string).
const SAMPLE = {
  projectGroupId: 'c6b6e1f8-4c90-430f-b861-575b7c2e7770',
  revisions: [
    {
      id: 'bb53bc69-4bfb-42d7-a7fc-061bac5d7a4d',
      action: 'CHAT',
      status: 'VALID',
      createdAt: '2026-06-16T04:38:18.230Z',
      generationDurationMs: 102944,
      totalCredits: '1819870000',
      refundedAt: null,
      chat: { id: 'chat-1', content: 'Build a multi-user CRM called "Rolodex"' },
    },
  ],
};

test('duration is the agent-loop "Generated in" time (generationDurationMs)', () => {
  const metrics = parseAnythingConversation(SAMPLE);
  // 102944 ms → 102.944 s ("1m 43s").
  assert.equal(metrics.duration, 102.944);
});

test('credits is the build credit label (totalCredits ÷ 10,000,000)', () => {
  const metrics = parseAnythingConversation(SAMPLE);
  // 1819870000 / 10,000,000 = 181.987 → the UI rounds this to "182".
  assert.equal(metrics.credits, 181.987);
});

test('cost works out to credits × $0.0012', () => {
  const builder = getBuilder('anything');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 0.0012);
  const metrics = parseAnythingConversation(SAMPLE);
  // 181.987 credits × $0.0012 ≈ $0.2184.
  assert.ok(metrics.credits !== null);
  assert.ok(Math.abs(metrics.credits * builder.creditToUsd - 0.2183844) < 1e-9);
});

test('sums duration and credits across multiple chat turns', () => {
  const metrics = parseAnythingConversation({
    projectGroupId: 'pg',
    revisions: [
      {
        id: 'r2',
        action: 'CHAT',
        createdAt: '2026-06-16T05:00:00.000Z',
        generationDurationMs: 40000,
        totalCredits: '500000000',
        refundedAt: null,
      },
      {
        id: 'r1',
        action: 'CHAT',
        createdAt: '2026-06-16T04:38:18.230Z',
        generationDurationMs: 102944,
        totalCredits: '1819870000',
        refundedAt: null,
      },
    ],
  });
  assert.equal(metrics.duration, 142.944); // (102944 + 40000) / 1000
  assert.equal(metrics.credits, 231.987); // (1819870000 + 500000000) / 10,000,000
  assert.equal(metrics.assistantMessageCount, 2);
});

test('skips refunded revisions (not charged, not run-billed)', () => {
  const metrics = parseAnythingConversation({
    projectGroupId: 'pg',
    revisions: [
      {
        id: 'refunded',
        action: 'CHAT',
        createdAt: '2026-06-16T05:00:00.000Z',
        generationDurationMs: 99999,
        totalCredits: '900000000',
        refundedAt: '2026-06-16T05:01:00.000Z',
      },
      {
        id: 'kept',
        action: 'CHAT',
        createdAt: '2026-06-16T04:38:18.230Z',
        generationDurationMs: 102944,
        totalCredits: '1819870000',
        refundedAt: null,
      },
    ],
  });
  assert.equal(metrics.duration, 102.944);
  assert.equal(metrics.credits, 181.987);
  assert.equal(metrics.assistantMessageCount, 1);
});

test('wallClockSeconds spans oldest → newest revision createdAt', () => {
  const metrics = parseAnythingConversation({
    projectGroupId: 'pg',
    revisions: [
      { id: 'r2', createdAt: '2026-06-16T04:40:00.000Z', generationDurationMs: 1000, totalCredits: '0' },
      { id: 'r1', createdAt: '2026-06-16T04:38:18.230Z', generationDurationMs: 1000, totalCredits: '0' },
    ],
  });
  // 04:40:00.000 − 04:38:18.230 = 101.77 s.
  assert.equal(metrics.wallClockSeconds, 101.77);
  assert.equal(metrics.promptSubmittedAt, '2026-06-16T04:38:18.230Z');
  assert.equal(metrics.completedAt, '2026-06-16T04:40:00.000Z');
});

test('prompt text falls back to the oldest turn\'s captured chat content', () => {
  const metrics = parseAnythingConversation(SAMPLE);
  assert.equal(metrics.promptText, 'Build a multi-user CRM called "Rolodex"');
});

test('explicit promptText option overrides the captured content', () => {
  const metrics = parseAnythingConversation(SAMPLE, { promptText: 'override' });
  assert.equal(metrics.promptText, 'override');
});

test('exposes no model or token signal (tokens are admin-only)', () => {
  const metrics = parseAnythingConversation(SAMPLE);
  assert.equal(metrics.model, null);
  assert.equal(metrics.tokens, null);
});

test('tolerates totalCredits / generationDurationMs as numbers too', () => {
  const metrics = parseAnythingConversation({
    projectGroupId: 'pg',
    revisions: [{ id: 'r', createdAt: '2026-06-16T04:38:18.230Z', generationDurationMs: 102944, totalCredits: 1819870000 }],
  });
  assert.equal(metrics.duration, 102.944);
  assert.equal(metrics.credits, 181.987);
});

test('throws when no revision carries usage', () => {
  assert.throws(
    () => parseAnythingConversation({ projectGroupId: 'pg', revisions: [{ id: 'r' }] }),
    /No usage found/,
  );
});

test('throws on a malformed payload', () => {
  assert.throws(() => parseAnythingConversation(null), /not an object/);
  assert.throws(() => parseAnythingConversation({}), /missing "revisions"/);
});

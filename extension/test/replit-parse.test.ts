import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseReplitConversation } from '../src/shared/replit-parse.js';
import { getBuilder } from '../src/shared/builders.js';

test('maps the scraped Replit summary to metrics', () => {
  const metrics = parseReplitConversation({ durationSeconds: 50, usd: 0.14, runCount: 1 });
  assert.equal(metrics.duration, 50);
  assert.equal(metrics.wallClockSeconds, 50);
  // USD passes through as `credits` for the cost pipeline.
  assert.equal(metrics.credits, 0.14);
  assert.equal(metrics.assistantMessageCount, 1);
});

test('Replit cost passes through at a $1 rate (USD reported directly)', () => {
  const builder = getBuilder('replit');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 1);
  const metrics = parseReplitConversation({ durationSeconds: 50, usd: 0.14 });
  assert.ok(metrics.credits !== null);
  // 0.14 × $1 = $0.14.
  assert.equal(Math.round(metrics.credits * builder.creditToUsd * 100) / 100, 0.14);
});

test('sums across multiple Agent runs (content script pre-summed)', () => {
  const metrics = parseReplitConversation({ durationSeconds: 130, usd: 0.37, runCount: 3 });
  assert.equal(metrics.duration, 130);
  assert.equal(metrics.credits, 0.37);
  assert.equal(metrics.assistantMessageCount, 3);
});

test('tolerates a missing cost (duration only)', () => {
  const metrics = parseReplitConversation({ durationSeconds: 22, usd: null });
  assert.equal(metrics.duration, 22);
  assert.equal(metrics.credits, null);
});

test('tolerates a missing duration (cost only)', () => {
  const metrics = parseReplitConversation({ durationSeconds: null, usd: 0.5 });
  assert.equal(metrics.duration, null);
  assert.equal(metrics.credits, 0.5);
});

test('throws when neither duration nor cost is present', () => {
  assert.throws(() => parseReplitConversation({ durationSeconds: null, usd: null }), /No duration/);
  assert.throws(() => parseReplitConversation(null), /Unexpected/);
});

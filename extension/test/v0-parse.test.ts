import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseV0Conversation } from '../src/shared/v0-parse.js';
import { getBuilder } from '../src/shared/builders.js';

test('maps the scraped v0 summary to metrics', () => {
  const metrics = parseV0Conversation({
    durationSeconds: 294, // 4m 54s
    credits: 1.85,
    model: 'v0 Max',
    runCount: 1,
  });
  assert.equal(metrics.duration, 294);
  assert.equal(metrics.wallClockSeconds, 294);
  assert.equal(metrics.credits, 1.85);
  assert.equal(metrics.model, 'v0 Max');
  assert.equal(metrics.assistantMessageCount, 1);
});

test('v0 credits are 1:1 with USD ($1/credit)', () => {
  const builder = getBuilder('v0');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 1);
  const metrics = parseV0Conversation({ durationSeconds: 294, credits: 1.85 });
  assert.ok(metrics.credits !== null);
  // 1.85 × $1 = $1.85.
  assert.equal(Math.round(metrics.credits * builder.creditToUsd * 100) / 100, 1.85);
});

test('sums across multiple v0 runs (content script pre-summed)', () => {
  const metrics = parseV0Conversation({ durationSeconds: 600, credits: 4.2, runCount: 3 });
  assert.equal(metrics.duration, 600);
  assert.equal(metrics.credits, 4.2);
  assert.equal(metrics.assistantMessageCount, 3);
});

test('tolerates a missing credit value (duration only)', () => {
  const metrics = parseV0Conversation({ durationSeconds: 120, credits: null });
  assert.equal(metrics.duration, 120);
  assert.equal(metrics.credits, null);
});

test('throws when neither duration nor credits is present', () => {
  assert.throws(() => parseV0Conversation({ durationSeconds: null, credits: null }), /No duration/);
  assert.throws(() => parseV0Conversation(null), /Unexpected/);
});

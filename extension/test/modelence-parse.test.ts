import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseModelenceConversation } from '../src/shared/modelence-parse.js';
import { getBuilder } from '../src/shared/builders.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

async function loadFixture(): Promise<unknown> {
  const raw = await readFile(join(fixturesDir, 'modelence-conversation.json'), 'utf8');
  return JSON.parse(raw) as unknown;
}

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return { role: 'assistant', content: '', date: undefined, ...overrides };
}

test('sums assistant message durations from the captured Modelence chat', async () => {
  const metrics = parseModelenceConversation(await loadFixture());

  // Single assistant message with top-level duration 371462ms → 371.462s.
  assert.equal(metrics.duration, 371.462);
  assert.equal(metrics.model, 'claude-opus-4-7');
  assert.equal(metrics.assistantMessageCount, 1);
  assert.equal(metrics.credits, null); // no cost signal in the frame
  assert.equal(metrics.tokens, null);
  assert.equal(metrics.promptSubmittedAt, '2026-06-09T07:45:55.367Z');
  assert.equal(metrics.completedAt, '2026-06-09T07:52:06.829Z');
  assert.ok(metrics.wallClockSeconds !== null);
});

test('Modelence builder has no credit rate (duration only)', () => {
  const builder = getBuilder('modelence');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, null);
});

test('sums duration across multiple assistant messages in one turn', () => {
  const payload = {
    selectedModelId: 'claude-opus-4-7',
    messages: [
      message({ role: 'user', content: 'p', date: '2026-06-09T10:00:00.000Z' }),
      message({ duration: 1000, date: '2026-06-09T10:00:30.000Z' }),
      message({ duration: 2500, date: '2026-06-09T10:01:00.000Z' }),
    ],
  };
  const metrics = parseModelenceConversation(payload);
  assert.equal(metrics.duration, 3.5);
  assert.equal(metrics.assistantMessageCount, 2);
});

test('scopes to the last user message', () => {
  const payload = {
    messages: [
      message({ role: 'user', content: 'first', date: '2026-06-09T10:00:00.000Z' }),
      message({ duration: 9000, date: '2026-06-09T10:01:00.000Z' }),
      message({ role: 'user', content: 'second', date: '2026-06-09T11:00:00.000Z' }),
      message({ duration: 1500, date: '2026-06-09T11:00:10.000Z' }),
    ],
  };
  const metrics = parseModelenceConversation(payload);
  assert.equal(metrics.duration, 1.5);
  assert.equal(metrics.promptText, 'second');
});

test('returns null duration when no assistant message carries one', () => {
  const payload = {
    messages: [
      message({ role: 'user', content: 'p', date: '2026-06-09T10:00:00.000Z' }),
      message({ content: 'done', date: '2026-06-09T10:00:05.000Z' }),
    ],
  };
  const metrics = parseModelenceConversation(payload);
  assert.equal(metrics.duration, null);
});

test('throws on malformed payloads', () => {
  assert.throws(() => parseModelenceConversation(null), /messages/);
  assert.throws(() => parseModelenceConversation({}), /messages/);
  assert.throws(() => parseModelenceConversation({ messages: [] }), /user message/);
});

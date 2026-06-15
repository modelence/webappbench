import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseBase44Conversation, parseBase44Date } from '../src/shared/base44-parse.js';
import { getBuilder } from '../src/shared/builders.js';

// Compiled test lives in dist/test/, fixtures stay in test/fixtures/.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

async function loadFixture(): Promise<unknown> {
  const raw = await readFile(join(fixturesDir, 'full-conversation.json'), 'utf8');
  return JSON.parse(raw) as unknown;
}

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return { role: 'assistant', content: '', usage: null, metadata: null, ...overrides };
}

test('parses the captured base44 conversation', async () => {
  const metrics = parseBase44Conversation(await loadFixture());

  assert.equal(metrics.duration, 110.494);
  assert.equal(metrics.credits, 1.2);
  assert.equal(metrics.model, 'anthropic/claude-opus-4-6');
  assert.equal(metrics.assistantMessageCount, 5);
  assert.equal(metrics.promptSubmittedAt, '2026-06-11T19:13:02.404Z');
  assert.equal(metrics.completedAt, '2026-06-11T19:14:51.075Z');
  assert.ok(metrics.wallClockSeconds !== null);
  assert.ok(Math.abs(metrics.wallClockSeconds - 108.671) < 0.001);
  assert.ok(metrics.tokens);
  assert.equal(metrics.tokens.totalTokens, 376100);
  assert.equal(metrics.tokens.promptTokens, 369746);
  assert.equal(metrics.tokens.completionTokens, 6354);
  assert.equal(metrics.tokens.cacheCreationTokens, 16483);
  assert.equal(metrics.tokens.cacheReadTokens, 353256);
});

test('converts credits to USD at the base44 registry rate', async () => {
  const metrics = parseBase44Conversation(await loadFixture());
  const builder = getBuilder('base44');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 0.2); // $0.20/credit, base44 monthly billing baseline
  assert.ok(metrics.credits !== null);
  // 1.2 credits × $0.20 = $0.24
  assert.equal(Math.round(metrics.credits * builder.creditToUsd * 100) / 100, 0.24);
});

test('scopes metrics to the last user message', () => {
  const payload = {
    model: 'm',
    messages: [
      message({ role: 'user', content: 'first prompt', metadata: { created_date: '2026-06-11T10:00:00.000000' } }),
      message({
        usage: { credits_charged: 9 },
        metadata: { created_date: '2026-06-11T10:01:00.000000' },
        additional_message_params: { agent_loop_elapsed_seconds: 60 },
      }),
      message({ role: 'user', content: 'second prompt', metadata: { created_date: '2026-06-11T11:00:00.000000' } }),
      message({
        usage: { credits_charged: 2 },
        metadata: { created_date: '2026-06-11T11:00:30.000000' },
        additional_message_params: { agent_loop_elapsed_seconds: 30 },
      }),
    ],
  };
  const metrics = parseBase44Conversation(payload);
  assert.equal(metrics.credits, 2);
  assert.equal(metrics.duration, 30);
  assert.equal(metrics.wallClockSeconds, 30);
  assert.equal(metrics.promptText, 'second prompt');
});

test('matches a specific prompt text when provided', () => {
  const payload = {
    messages: [
      message({ role: 'user', content: 'target prompt', metadata: { created_date: '2026-06-11T10:00:00.000000' } }),
      message({
        usage: { credits_charged: 1.5 },
        metadata: { created_date: '2026-06-11T10:02:00.000000' },
        additional_message_params: { agent_loop_elapsed_seconds: 120 },
      }),
      message({ role: 'user', content: 'follow-up tweak', metadata: { created_date: '2026-06-11T10:10:00.000000' } }),
      message({ usage: { credits_charged: 0.3 }, metadata: { created_date: '2026-06-11T10:10:20.000000' } }),
    ],
  };
  const metrics = parseBase44Conversation(payload, { promptText: 'target prompt' });
  assert.equal(metrics.credits, 1.5);
  assert.equal(metrics.duration, 120);
  assert.equal(metrics.assistantMessageCount, 1);
});

test('returns null credits and duration when usage is absent', () => {
  const payload = {
    messages: [
      message({ role: 'user', content: 'p', metadata: { created_date: '2026-06-11T10:00:00.000000' } }),
      message({ usage: { credits_charged: null } }),
    ],
  };
  const metrics = parseBase44Conversation(payload);
  assert.equal(metrics.credits, null);
  assert.equal(metrics.duration, null);
  assert.equal(metrics.wallClockSeconds, null);
  assert.equal(metrics.tokens, null);
});

test('throws on malformed payloads', () => {
  assert.throws(() => parseBase44Conversation(null), /messages/);
  assert.throws(() => parseBase44Conversation({}), /messages/);
  assert.throws(() => parseBase44Conversation({ messages: [] }), /user message/);
  assert.throws(
    () => parseBase44Conversation({ messages: [message({ role: 'assistant' })] }),
    /user message/,
  );
});

test('normalizes base44 microsecond timestamps as UTC', () => {
  assert.equal(parseBase44Date('2026-06-11T19:13:02.404000')?.toISOString(), '2026-06-11T19:13:02.404Z');
  assert.equal(parseBase44Date('2026-06-11T19:13:02Z')?.toISOString(), '2026-06-11T19:13:02.000Z');
  assert.equal(parseBase44Date('not a date'), null);
  assert.equal(parseBase44Date(undefined), null);
});

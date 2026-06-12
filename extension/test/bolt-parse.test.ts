import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseBoltConversation } from '../src/shared/bolt-parse.js';
import { getBuilder } from '../src/shared/builders.js';

// Mirrors GET https://bolt.new/api/chats/{id}: duration is the gap between the
// first (user) and second (assistant) message's createdAt.
const SAMPLE = {
  agent: 'claude-code',
  model: 'standard',
  messages: [
    {
      id: 'zv0jKMl0S1QVW3BO',
      role: 'user',
      content: 'Build a CRM called Rolodex',
      input: 'Build a CRM called Rolodex',
      createdAt: '2026-06-12T07:53:36.163Z',
    },
    {
      id: '77d25956',
      role: 'assistant',
      content: 'Build succeeds. Rolodex CRM is complete.',
      createdAt: '2026-06-12T07:57:01.608Z',
    },
    {
      id: 'after-publish',
      role: 'user',
      content: 'publish',
      createdAt: '2026-06-12T08:10:00.000Z',
    },
  ],
};

test('duration is the gap between the first and second message', () => {
  const metrics = parseBoltConversation(SAMPLE);
  // 07:57:01.608 − 07:53:36.163 = 205.445 s.
  assert.equal(metrics.duration, 205.445);
  assert.equal(metrics.promptSubmittedAt, '2026-06-12T07:53:36.163Z');
  assert.equal(metrics.completedAt, '2026-06-12T07:57:01.608Z');
  assert.equal(metrics.model, 'standard');
  assert.equal(metrics.credits, null); // no cost signal
  assert.equal(metrics.assistantMessageCount, 1);
});

test('ignores messages after the build (publish turn)', () => {
  const metrics = parseBoltConversation(SAMPLE);
  // The 3rd message (publish, 08:10) must not affect duration.
  assert.equal(metrics.completedAt, '2026-06-12T07:57:01.608Z');
});

test('Bolt builder has no credit rate (duration only)', () => {
  const builder = getBuilder('bolt');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, null);
});

test('uses input as the prompt text, falling back to content', () => {
  const metrics = parseBoltConversation(SAMPLE);
  assert.equal(metrics.promptText, 'Build a CRM called Rolodex');
});

test('throws when the chat does not start with a user message', () => {
  assert.throws(
    () =>
      parseBoltConversation({
        messages: [{ role: 'assistant', createdAt: '2026-06-12T07:57:01.608Z' }],
      }),
    /start with a user message/,
  );
});

test('throws when there is no assistant response', () => {
  assert.throws(
    () => parseBoltConversation({ messages: [{ role: 'user', createdAt: '2026-06-12T07:53:36.163Z' }] }),
    /No assistant response/,
  );
});

test('throws on missing timestamps', () => {
  assert.throws(
    () =>
      parseBoltConversation({
        messages: [
          { role: 'user', content: 'p' },
          { role: 'assistant', content: 'done' },
        ],
      }),
    /missing createdAt/,
  );
});

test('throws on a malformed payload', () => {
  assert.throws(() => parseBoltConversation(null), /messages/);
  assert.throws(() => parseBoltConversation({}), /messages/);
});

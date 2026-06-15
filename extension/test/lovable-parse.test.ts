import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseLovableConversation } from '../src/shared/lovable-parse.js';
import { getBuilder } from '../src/shared/builders.js';

// Build a Next.js flight blob the way Lovable streams it: "<id>:<json>\n" rows.
// The message array is embedded inside one row's JSON, mirroring the real
// page where it's nested deep in the RSC tree.
function flightWith(messages: unknown): string {
  const rows = [
    '0:["$","$1","c",{"children":"app shell"}]',
    `8:${JSON.stringify({ project: { id: 'de73ebcc', messages } })}`,
    '9:I[12345,["chunk.js"],"ChatPanel"]',
  ];
  return rows.join('\n');
}

const SAMPLE_MESSAGES = [
  { role: 'user', content: 'Build a CRM called Rolodex', created_at: '2026-06-12T10:00:00.000Z' },
  {
    role: 'assistant',
    content: 'Building it now',
    thinking_time_ms: 42000,
    cost_credits: 2,
    created_at: '2026-06-12T10:00:50.000Z',
  },
  {
    role: 'assistant',
    content: 'Added auth',
    thinking_time_ms: 18000,
    cost_credits: 1,
    created_at: '2026-06-12T10:01:30.000Z',
  },
];

test('sums thinking_time_ms and cost_credits from the Lovable flight payload', () => {
  const metrics = parseLovableConversation({ flight: flightWith(SAMPLE_MESSAGES) });

  // (42000 + 18000) ms → 60s.
  assert.equal(metrics.duration, 60);
  // 2 + 1 credits.
  assert.equal(metrics.credits, 3);
  assert.equal(metrics.assistantMessageCount, 2);
  assert.equal(metrics.promptText, 'Build a CRM called Rolodex');
  assert.equal(metrics.promptSubmittedAt, '2026-06-12T10:00:00.000Z');
  assert.equal(metrics.completedAt, '2026-06-12T10:01:30.000Z');
});

test('Lovable credits convert to USD at $0.25/credit', () => {
  const builder = getBuilder('lovable');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 0.25);
  const metrics = parseLovableConversation({ flight: flightWith(SAMPLE_MESSAGES) });
  assert.ok(metrics.credits !== null);
  // 3 credits × $0.25 = $0.75.
  assert.equal(Math.round(metrics.credits * builder.creditToUsd * 100) / 100, 0.75);
});

test('scopes to the applied prompt when provided', () => {
  const messages = [
    { role: 'user', content: 'first prompt', created_at: '2026-06-12T09:00:00.000Z' },
    { role: 'assistant', content: 'a', thinking_time_ms: 5000, cost_credits: 9, created_at: '2026-06-12T09:00:10.000Z' },
    { role: 'user', content: 'second prompt', created_at: '2026-06-12T10:00:00.000Z' },
    { role: 'assistant', content: 'b', thinking_time_ms: 3000, cost_credits: 1, created_at: '2026-06-12T10:00:05.000Z' },
  ];
  const metrics = parseLovableConversation(
    { flight: flightWith(messages) },
    { promptText: 'second prompt' },
  );
  assert.equal(metrics.duration, 3);
  assert.equal(metrics.credits, 1);
  assert.equal(metrics.promptText, 'second prompt');
});

test('handles flight chunks split across rows (only complete-JSON rows parse)', () => {
  // A message row plus an unrelated module-ref row that must be skipped.
  const flight = [
    'a:I[999,["x.js"],"Thing"]',
    `b:${JSON.stringify([{ messages: [{ role: 'assistant', thinking_time_ms: 7000, cost_credits: 4 }] }])}`,
  ].join('\n');
  const metrics = parseLovableConversation({ flight });
  assert.equal(metrics.duration, 7);
  assert.equal(metrics.credits, 4);
});

test('throws when the flight has no message data', () => {
  assert.throws(
    () => parseLovableConversation({ flight: '0:["$","$1","c",{}]\n1:I[1,["a.js"]]' }),
    /No Lovable messages/,
  );
});

test('throws on a payload without flight text', () => {
  assert.throws(() => parseLovableConversation(null), /flight/);
  assert.throws(() => parseLovableConversation({}), /flight/);
});

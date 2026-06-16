import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseManusConversation } from '../src/shared/manus-parse.js';
import { getBuilder } from '../src/shared/builders.js';

// Mirrors the real POST /session.v1.SessionService/GetSession response: the
// content script hands the whole `{ session: {...} }` envelope to the parser.
// Note int64 fields (costedCredits, usage.*) arrive as numeric STRINGS, while
// costedCredits itself came through as a number — the parser tolerates both.
const SAMPLE = {
  session: {
    uid: 'XgSVIKtX6xrOGPgZ4Hsj4X',
    title: 'Build a Multi-User CRM with Authentication and Data Isolation',
    lastMessageTime: '2026-06-15T17:03:32.781Z',
    status: 'SESSION_STATUS_STOPPED',
    createdAt: '2026-06-15T16:54:18.302Z',
    updatedAt: '2026-06-15T17:03:32.782Z',
    agentTaskMode: 'AGENT_TASK_MODE_HIGH_EFFORT',
    costedCredits: 175,
    usage: { commandsRun: '30', filesCreated: '1', cumulativeRuntimeMs: '510713' },
  },
};

test('duration is the agent-loop "Time worked" (cumulativeRuntimeMs)', () => {
  const metrics = parseManusConversation(SAMPLE);
  // 510713 ms → 510.713 s.
  assert.equal(metrics.duration, 510.713);
});

test('credits is the build\'s "Credits used" (costedCredits)', () => {
  const metrics = parseManusConversation(SAMPLE);
  assert.equal(metrics.credits, 175);
});

test('wallClockSeconds spans createdAt → lastMessageTime', () => {
  const metrics = parseManusConversation(SAMPLE);
  // 17:03:32.781 − 16:54:18.302 = 554.479 s (longer than time-worked because it
  // includes the stretch the run was blocked waiting on the human).
  assert.equal(metrics.wallClockSeconds, 554.479);
  assert.equal(metrics.promptSubmittedAt, '2026-06-15T16:54:18.302Z');
  assert.equal(metrics.completedAt, '2026-06-15T17:03:32.781Z');
});

test('exposes no model or token signal', () => {
  const metrics = parseManusConversation(SAMPLE);
  assert.equal(metrics.model, null);
  assert.equal(metrics.tokens, null);
});

test('reports commandsRun as the activity count', () => {
  const metrics = parseManusConversation(SAMPLE);
  assert.equal(metrics.assistantMessageCount, 30);
});

test('tolerates costedCredits as a numeric string', () => {
  const metrics = parseManusConversation({
    session: { ...SAMPLE.session, costedCredits: '175' },
  });
  assert.equal(metrics.credits, 175);
});

test('accepts a bare session object as well as the envelope', () => {
  const metrics = parseManusConversation(SAMPLE.session);
  assert.equal(metrics.credits, 175);
  assert.equal(metrics.duration, 510.713);
});

test('carries the prompt text through from options', () => {
  const metrics = parseManusConversation(SAMPLE, { promptText: 'Build Rolodex' });
  assert.equal(metrics.promptText, 'Build Rolodex');
});

test('falls back to updatedAt when lastMessageTime is missing', () => {
  const session = { ...SAMPLE.session };
  delete (session as { lastMessageTime?: string }).lastMessageTime;
  const metrics = parseManusConversation({ session });
  assert.equal(metrics.completedAt, '2026-06-15T17:03:32.782Z');
});

test('Manus bills credits at ~$0.01', () => {
  const builder = getBuilder('manus');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 0.01);
});

test('throws when the session carries no usage at all', () => {
  assert.throws(
    () => parseManusConversation({ session: { uid: 'x' } }),
    /No usage found/,
  );
});

test('throws on a malformed payload', () => {
  assert.throws(() => parseManusConversation(null), /Unexpected Manus payload/);
  assert.throws(() => parseManusConversation({}), /missing "session"/);
});

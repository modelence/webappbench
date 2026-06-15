import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseEmergentConversation } from '../src/shared/emergent-parse.js';
import { getBuilder } from '../src/shared/builders.js';

// Mirrors the SSE payload from GET /trajectories/v0/stream: the content script
// flattens every `data: { trajectories: { data: [...] } }` frame into `items`.
// Note `req-1` appears TWICE (the same LLM call split into text + tool-call
// fragments, sharing one request_id and identical metering) — it must be
// counted once.
const SAMPLE = {
  jobId: '624881b2-ae31-4cd7-8421-eec135b4a810',
  items: [
    {
      id: 'frag-a-0',
      request_id: 'req-1',
      traj_payload: {
        request_id: 'req-1',
        step_num: 1,
        timestamp: '2026-06-15T13:35:00.000Z',
        acc_cost: 0.5,
        total_tokens: 100,
        prompt_tokens: 80,
        completion_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        full_model_name: 'claude-opus-4-7',
      },
    },
    {
      id: 'frag-a-1',
      request_id: 'req-1', // duplicate fragment of the same call
      traj_payload: {
        request_id: 'req-1',
        step_num: 1,
        timestamp: '2026-06-15T13:35:00.000Z',
        acc_cost: 0.5,
        total_tokens: 100,
        prompt_tokens: 80,
        completion_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        full_model_name: 'claude-opus-4-7',
      },
    },
    {
      id: 'frag-b-0',
      request_id: 'req-2',
      traj_payload: {
        request_id: 'req-2',
        step_num: 2,
        timestamp: '2026-06-15T13:45:00.000Z',
        acc_cost: 1.5, // cumulative — this is the run total
        total_tokens: 200,
        prompt_tokens: 150,
        completion_tokens: 50,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 30,
        full_model_name: 'gemini-3.1-pro-preview',
      },
    },
  ],
};

test('dedupes by request_id and sums tokens once per LLM call', () => {
  const metrics = parseEmergentConversation(SAMPLE);
  assert.ok(metrics.tokens);
  assert.equal(metrics.tokens.totalTokens, 300); // 100 (once) + 200
  assert.equal(metrics.tokens.promptTokens, 230);
  assert.equal(metrics.tokens.completionTokens, 70);
  assert.equal(metrics.tokens.cacheReadTokens, 170);
  assert.equal(metrics.tokens.cacheCreationTokens, 40);
  assert.equal(metrics.tokens.reasoningTokens, 0);
  assert.equal(metrics.assistantMessageCount, 2);
});

test('duration is the span between the first and last step timestamp', () => {
  const metrics = parseEmergentConversation(SAMPLE);
  // 13:45:00 − 13:35:00 = 600 s.
  assert.equal(metrics.duration, 600);
  assert.equal(metrics.wallClockSeconds, 600);
  assert.equal(metrics.promptSubmittedAt, '2026-06-15T13:35:00.000Z');
  assert.equal(metrics.completedAt, '2026-06-15T13:45:00.000Z');
});

// A realistic run: leading clarification (ask_human, the agent then waits on
// the human) + two build steps + a deploy turn hours later.
const TURN_SAMPLE = {
  jobId: 'job',
  items: [
    {
      request_id: 'ask',
      traj_payload: {
        request_id: 'ask',
        function_name: 'ask_human',
        timestamp: '2026-06-15T13:34:00.000Z',
        acc_cost: 0.3,
        total_tokens: 50,
        prompt_tokens: 40,
        completion_tokens: 10,
      },
    },
    {
      request_id: 'b1',
      traj_payload: {
        request_id: 'b1',
        function_name: 'create_file',
        timestamp: '2026-06-15T13:36:00.000Z',
        acc_cost: 1.0,
        total_tokens: 100,
        prompt_tokens: 80,
        completion_tokens: 20,
        full_model_name: 'claude-opus-4-7',
      },
    },
    {
      request_id: 'b2',
      traj_payload: {
        request_id: 'b2',
        function_name: 'create_file',
        timestamp: '2026-06-15T13:44:00.000Z',
        acc_cost: 2.0,
        total_tokens: 200,
        prompt_tokens: 150,
        completion_tokens: 50,
        full_model_name: 'claude-opus-4-7',
      },
    },
    {
      request_id: 'dep',
      traj_payload: {
        request_id: 'dep',
        action: 'deployment_initiated',
        timestamp: '2026-06-15T16:46:00.000Z',
      },
    },
  ],
};

test('duration excludes the leading clarification turn and the trailing deploy', () => {
  const metrics = parseEmergentConversation(TURN_SAMPLE);
  // First build step 13:36:00 → last build step 13:44:00 = 480 s. The 13:34
  // ask_human and the 16:46 deploy are both excluded.
  assert.equal(metrics.duration, 480);
  assert.equal(metrics.promptSubmittedAt, '2026-06-15T13:36:00.000Z');
  assert.equal(metrics.completedAt, '2026-06-15T13:44:00.000Z');
});

test('tokens and credits still include the clarification turn', () => {
  const metrics = parseEmergentConversation(TURN_SAMPLE);
  assert.equal(metrics.tokens?.totalTokens, 350); // 50 (ask) + 100 + 200
  assert.equal(metrics.credits, 2.0); // final acc_cost
});

test('credits is the final (max) acc_cost = the job\'s "Credits Spent"', () => {
  const metrics = parseEmergentConversation(SAMPLE);
  assert.equal(metrics.credits, 1.5);
});

test('credits rounds to 4 dp to match the UI "Credits Spent" figure', () => {
  // The real run\'s final acc_cost 9.41995904 renders as "9.4200" in the UI.
  const metrics = parseEmergentConversation({
    items: [
      {
        request_id: 'r',
        traj_payload: { request_id: 'r', timestamp: '2026-06-15T13:35:00.000Z', acc_cost: 9.41995904, total_tokens: 1 },
      },
    ],
  });
  assert.equal(metrics.credits, 9.42);
});

test('reports every distinct model used', () => {
  const metrics = parseEmergentConversation(SAMPLE);
  assert.equal(metrics.model, 'claude-opus-4-7, gemini-3.1-pro-preview');
});

test('accepts a bare items array as well as the wrapper', () => {
  const metrics = parseEmergentConversation(SAMPLE.items);
  assert.equal(metrics.tokens?.totalTokens, 300);
  assert.equal(metrics.duration, 600);
});

test('carries the prompt text through from options', () => {
  const metrics = parseEmergentConversation(SAMPLE, { promptText: 'Build Rolodex' });
  assert.equal(metrics.promptText, 'Build Rolodex');
});

test('Emergent bills subscription credits at $0.20', () => {
  const builder = getBuilder('emergent');
  assert.ok(builder);
  assert.equal(builder.creditToUsd, 0.2);
});

test('throws on a payload with no trajectory items', () => {
  assert.throws(() => parseEmergentConversation({ items: [] }), /No Emergent trajectory steps/);
});

test('throws on a malformed payload', () => {
  assert.throws(() => parseEmergentConversation(null), /items/);
  assert.throws(() => parseEmergentConversation({}), /items/);
});

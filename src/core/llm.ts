import OpenAI from 'openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

let _client: OpenAI | null = null;

export function getLlmClient(): OpenAI {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set. Add it to .env to enable LLM-based scorers.');
  }
  if (!_client) {
    _client = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey,
      // Bound each request so a hung provider (e.g. an OpenRouter upstream that
      // accepts the request then never streams content) fails fast instead of
      // blocking a scorer for minutes. The SDK retries the timed-out/5xx call.
      timeout: 90_000,
      maxRetries: 2,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/modelence/benchmark',
        'X-Title': 'AI Sitebuilder Benchmark',
      },
    });
  }
  return _client;
}

// Default judge model. gpt-5.5 is the reliable primary — gemini-2.5-pro was
// observed returning empty 200s for minutes on large multi-image vision payloads
// via OpenRouter, so it's demoted to the fallback. (V1 still runs BOTH as a
// diverse pair for the visual-quality verdict.)
export const DEFAULT_JUDGE_MODEL = 'openai/gpt-5.5';

// Vision-capable fallback used when the primary judge model keeps returning
// empty/erroring. gemini-2.5-pro is a strong second opinion for the same image
// inputs. Override either via env (OPENROUTER_MODEL for the primary).
export const FALLBACK_JUDGE_MODEL = 'google/gemini-2.5-pro';

type ChatMessages = Parameters<OpenAI['chat']['completions']['create']>[0]['messages'];

export interface JudgeCompletion {
  raw: string;
  usage: OpenAI.Completions.CompletionUsage | null;
  model: string;
}

// One model, `attempts` tries. Resolves to a non-empty completion or null if
// every try came back empty / errored (so the caller can fall back).
async function tryModel(
  client: OpenAI,
  model: string,
  maxTokens: number,
  messages: ChatMessages,
  attempts: number,
): Promise<JudgeCompletion | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await client.chat.completions.create({ model, max_tokens: maxTokens, messages });
      const raw = response.choices[0]?.message?.content ?? '';
      if (raw.trim()) return { raw, usage: response.usage ?? null, model };
    } catch {
      // network/5xx/timeout — fall through to the next attempt
    }
  }
  return null;
}

// Call a chat model for a JSON-returning judge. Retries on empty 200s (a case
// the SDK's own retry doesn't catch — it's not an error status), and FALLS BACK
// to a second vision-capable model when the primary keeps coming up empty. This
// keeps f4/v1/c7 from dropping to N/A when one provider has a bad spell.
// Parsing/validation stays with the caller (each judge has its own schema).
export async function createJudgeCompletion(
  client: OpenAI,
  params: { model: string; maxTokens?: number; messages: ChatMessages; fallbackModel?: string | null },
  attemptsPerModel = 2,
): Promise<JudgeCompletion> {
  const maxTokens = params.maxTokens ?? 4096;
  const primary = await tryModel(client, params.model, maxTokens, params.messages, attemptsPerModel);
  if (primary) return primary;

  // Fall back to a different model (unless explicitly disabled or it IS the primary).
  const fallback = params.fallbackModel === null
    ? null
    : (params.fallbackModel ?? FALLBACK_JUDGE_MODEL);
  if (fallback && fallback !== params.model) {
    const alt = await tryModel(client, fallback, maxTokens, params.messages, attemptsPerModel);
    if (alt) return alt;
  }
  throw new Error(
    `Judge models returned no usable content (primary=${params.model}${fallback && fallback !== params.model ? `, fallback=${fallback}` : ''})`,
  );
}

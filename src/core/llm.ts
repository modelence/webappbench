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
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/modelence/benchmark',
        'X-Title': 'AI Sitebuilder Benchmark',
      },
    });
  }
  return _client;
}

export const DEFAULT_JUDGE_MODEL = 'google/gemini-2.5-pro';

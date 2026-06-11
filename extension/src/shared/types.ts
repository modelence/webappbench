export interface BuilderDef {
  id: string;
  label: string;
  // Hostnames (suffix match) where this builder's content script is active.
  hosts: readonly string[];
  // Retail USD price of one platform credit; overridable in popup settings.
  creditToUsd: number;
  creditRateNote: string;
}

export interface PromptEntry {
  id: string;
  tier: number;
  prompt: string;
}

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface ConversationMetrics {
  promptText: string | null;
  promptSubmittedAt: string | null;
  completedAt: string | null;
  // Builder-reported agent-loop execution time, seconds (summed across loops).
  duration: number | null;
  // Last assistant timestamp minus user prompt timestamp, seconds.
  wallClockSeconds: number | null;
  credits: number | null;
  model: string | null;
  tokens: TokenTotals | null;
  assistantMessageCount: number;
}

export interface CollectedRun {
  id: string;
  builder: string;
  promptId: string;
  appId: string;
  appliedAt: string | null;
  collectedAt: string;
  promptSubmittedAt: string | null;
  duration: number | null;
  wallClockSeconds: number | null;
  credits: number | null;
  creditToUsd: number;
  cost: number | null;
  model: string | null;
  tokens: TokenTotals | null;
}

export interface PendingRun {
  builder: string;
  promptId: string;
  promptText: string;
  appliedAt: string;
}

export type ContentRequest =
  | { type: 'FILL_PROMPT'; text: string }
  | { type: 'COLLECT' };

export type ContentResponse =
  | { ok: true; appId?: string; conversation?: unknown }
  | { ok: false; error: string };

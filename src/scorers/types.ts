import type { Browser, Page } from '@playwright/test';
import type { ArtifactPaths } from '../core/artifact.ts';
import type { Submission } from '../core/submission.ts';
import type { Prompt } from '../core/types.ts';

export interface ScorerContext {
  submission: Submission;
  prompt: Prompt;
  paths: ArtifactPaths;
  page: Page;
  browser: Browser;
  sourceDir?: string;  // extracted source directory — present only when user supplied a ZIP
}

export interface ScorerResult {
  scorer: string;
  version: string;
  passed: boolean | null;
  score: number | null;
  details: Record<string, unknown>;
  notes?: string;
}

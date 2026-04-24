import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  artifactPaths,
  prepareArtifactDir,
  writeJson,
  writePromptJson,
  type ArtifactPaths,
} from './artifact.ts';
import { loadPrompt } from '../prompts/schema.ts';
import { ALL_TOOLS } from './types.ts';
import { isoWeek } from './version.ts';
import type { Prompt, ToolName, UserReportedCost, UserReportedTiming } from './types.ts';

export const submissionSchema = z.object({
  tool: z.enum(ALL_TOOLS as unknown as [ToolName, ...ToolName[]]),
  toolVersion: z.string().min(1),
  promptId: z.string().regex(/^[a-z0-9-]+$/),
  runIdx: z.number().int().nonnegative(),
  artifactUrl: z.string().url(),
  submittedAt: z.string().datetime(),
  userReportedTiming: z
    .object({
      promptSubmittedAt: z.string().datetime().optional(),
      firstRenderAt: z.string().datetime().optional(),
      workingBuildAt: z.string().datetime().optional(),
    })
    .optional(),
  userReportedCost: z
    .object({
      credits: z.number().nonnegative().optional(),
      usdEstimate: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    })
    .optional(),
});

export type Submission = z.infer<typeof submissionSchema>;

export async function readSubmission(path: string): Promise<Submission> {
  const text = await readFile(path, 'utf8');
  return submissionSchema.parse(JSON.parse(text));
}

export interface SubmissionInit {
  tool: ToolName;
  toolVersion: string;
  promptId: string;
  runIdx?: number;
  artifactUrl: string;
  userReportedTiming?: UserReportedTiming;
  userReportedCost?: UserReportedCost;
}

export function buildSubmission(init: SubmissionInit): Submission {
  return submissionSchema.parse({
    tool: init.tool,
    toolVersion: init.toolVersion,
    promptId: init.promptId,
    runIdx: init.runIdx ?? 0,
    artifactUrl: init.artifactUrl,
    submittedAt: new Date().toISOString(),
    userReportedTiming: init.userReportedTiming,
    userReportedCost: init.userReportedCost,
  });
}

export interface CreateSubmissionOptions {
  tool: ToolName;
  promptId: string;
  runIdx?: number;
  url: string;
  toolVersion?: string;
  timing?: UserReportedTiming;
  cost?: UserReportedCost;
  corpusDir: string;
  artifactsRoot: string;
}

export interface CreateSubmissionResult {
  submission: Submission;
  prompt: Prompt;
  paths: ArtifactPaths;
}

export async function createSubmissionArtifact(
  opts: CreateSubmissionOptions,
): Promise<CreateSubmissionResult> {
  const prompt = await loadPrompt(join(opts.corpusDir, `${opts.promptId}.yaml`));
  const submission = buildSubmission({
    tool: opts.tool,
    toolVersion: opts.toolVersion ?? isoWeek(),
    promptId: opts.promptId,
    runIdx: opts.runIdx ?? 0,
    artifactUrl: opts.url,
    userReportedTiming: opts.timing,
    userReportedCost: opts.cost,
  });
  const paths = artifactPaths(
    opts.artifactsRoot,
    opts.tool,
    opts.promptId,
    opts.runIdx ?? 0,
  );
  await prepareArtifactDir(paths);
  await writeJson(paths.submission, submission);
  await writePromptJson(paths, prompt);
  return { submission, prompt, paths };
}

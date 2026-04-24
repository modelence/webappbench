import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ALL_TOOLS } from './types.ts';
import type { ToolName } from './types.ts';

const entrySchema = z.object({
  tool: z.enum(ALL_TOOLS as unknown as [ToolName, ...ToolName[]]),
  prompt: z.string().regex(/^[a-z0-9-]+$/, 'prompt must be kebab-case'),
  url: z.string().url(),
  runIdx: z.number().int().nonnegative().default(0),
  toolVersion: z.string().optional(),
  promptSubmittedAt: z.string().datetime().optional(),
  firstRenderAt: z.string().datetime().optional(),
  workingBuildAt: z.string().datetime().optional(),
  credits: z.number().nonnegative().optional(),
  usd: z.number().nonnegative().optional(),
  note: z.string().optional(),
});

export type SubmissionConfigEntry = z.infer<typeof entrySchema>;

export const configSchema = z.object({
  schema: z.literal(1),
  runs: z.array(entrySchema).min(1),
});

export type SubmissionConfig = z.infer<typeof configSchema>;

export async function loadConfig(path: string): Promise<SubmissionConfig> {
  const text = await readFile(path, 'utf8');
  const parsed = parseYaml(text);
  const validated = configSchema.parse(parsed);
  assertNoDuplicates(validated.runs);
  return validated;
}

function assertNoDuplicates(runs: SubmissionConfigEntry[]): void {
  const seen = new Set<string>();
  for (const r of runs) {
    const key = `${r.tool}/${r.prompt}/${r.runIdx}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate config entry: ${key}`);
    }
    seen.add(key);
  }
}

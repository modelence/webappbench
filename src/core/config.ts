import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { TOOL_NAME_PATTERN } from './types.ts';

const entrySchema = z.object({
  tool: z.string().regex(TOOL_NAME_PATTERN, 'tool must be lowercase kebab-case'),
  prompt: z.string().regex(/^[a-z0-9-]+$/, 'prompt must be kebab-case'),
  url: z.string().url(),
  source: z.string().optional(),  // local path to .zip of the generated source code
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

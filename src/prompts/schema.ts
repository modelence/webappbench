import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Prompt } from '../core/types.ts';

const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  locator: z.string().min(1),
  assert: z.string().min(1),
  custom: z.string().optional(),
});

const verbatimConstraintSchema = z.object({
  type: z.enum(['exact_copy', 'hex_value', 'structural']),
  value: z.string().min(1),
  where: z.string().min(1),
});

const seoCheckSchema = z.enum([
  'title',
  'meta_description',
  'canonical',
  'og_tags',
  'twitter_card',
  'json_ld',
  'lang',
  'heading_hierarchy',
  'robots_txt',
  'sitemap_xml',
]);

export const promptSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string().min(20),
  must_have: z.array(acceptanceCriterionSchema).default([]),
  should_have: z.array(acceptanceCriterionSchema).default([]),
  verbatim_constraints: z.array(verbatimConstraintSchema).default([]),
  seo_applicable: z.array(seoCheckSchema).default([]),
});

export type PromptYaml = z.infer<typeof promptSchema>;

export function normalizePrompt(raw: PromptYaml): Prompt {
  return {
    id: raw.id,
    tier: raw.tier,
    prompt: raw.prompt,
    mustHave: raw.must_have,
    shouldHave: raw.should_have,
    verbatimConstraints: raw.verbatim_constraints,
    seoApplicable: raw.seo_applicable,
  };
}

export async function loadPrompt(path: string): Promise<Prompt> {
  const text = await readFile(path, 'utf8');
  const parsed = parseYaml(text);
  const validated = promptSchema.parse(parsed);
  return normalizePrompt(validated);
}

export async function loadCorpus(dir: string): Promise<Prompt[]> {
  const entries = await readdir(dir);
  const yamlFiles = entries.filter((f) => extname(f) === '.yaml' || extname(f) === '.yml');
  const prompts = await Promise.all(yamlFiles.map((f) => loadPrompt(join(dir, f))));
  const ids = new Set<string>();
  for (const p of prompts) {
    if (ids.has(p.id)) {
      throw new Error(`Duplicate prompt id: ${p.id}`);
    }
    ids.add(p.id);
  }
  return prompts.sort((a, b) => a.id.localeCompare(b.id));
}

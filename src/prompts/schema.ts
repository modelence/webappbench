import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Prompt } from '../core/types.ts';

const setupActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evaluate'), expr: z.string().min(1) }),
  z.object({ kind: z.literal('fill'), locator: z.string().min(1), value: z.string() }),
  z.object({ kind: z.literal('click'), locator: z.string().min(1) }),
  z.object({ kind: z.literal('press'), locator: z.string().min(1), key: z.string().min(1) }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('waitFor'), locator: z.string().min(1) }),
  z.object({ kind: z.literal('revealLoginForm') }),
  // Sign in using the submission's `backend` credentials (default: user A).
  // A no-op that leaves the criterion failing when the submission carries no
  // backend block, so auth-gated criteria simply don't pass on non-backend runs
  // rather than erroring the whole scorer.
  z.object({ kind: z.literal('login'), account: z.enum(['a', 'b']).optional() }),
  z.object({ kind: z.literal('logout') }),
]);

const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  locator: z.string().min(1),
  assert: z.string().min(1),
  custom: z.string().optional(),
  setup: z.array(setupActionSchema).optional(),
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

const checklistItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'checklist item id must be snake_case'),
  label: z.string().min(1),
  description: z.string().min(1),
});

const checklistConfigSchema = z.object({
  extra: z.array(checklistItemSchema).default([]),
  placeholder_copy: z.boolean().default(false),
}).default({ extra: [], placeholder_copy: false });

// Backend probe declarations (YAML, snake_case). Normalized to the camelCase
// BackendProbe type in core/backend.ts. Read-only probes only — the union admits
// no write/delete/escalation kind by construction. Consumed by the planned S4
// scorer; absent ⇒ S4 is N/A for the prompt. See docs/s4-backend-security-plan.md.
const backendProbeYamlSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unauth_get'),
    id: z.string().min(1),
    path: z.string().min(1),
    expect_status: z.array(z.number().int()).nonempty(),
  }),
  z.object({
    kind: z.literal('cross_user_get'),
    id: z.string().min(1),
    path: z.string().min(1),
    expect_status: z.array(z.number().int()).nonempty(),
    forbid_body_contains: z.string().min(1),
  }),
]);

export const promptSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string().min(20),
  must_have: z.array(acceptanceCriterionSchema).default([]),
  should_have: z.array(acceptanceCriterionSchema).default([]),
  verbatim_constraints: z.array(verbatimConstraintSchema).default([]),
  seo_applicable: z.array(seoCheckSchema).default([]),
  visual_checklist: checklistConfigSchema,
  functional_checklist: checklistConfigSchema,
  backend_probes: z.array(backendProbeYamlSchema).default([]),
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
    visualChecklist: {
      extra: raw.visual_checklist.extra,
      placeholderCopy: raw.visual_checklist.placeholder_copy,
    },
    functionalChecklist: {
      extra: raw.functional_checklist.extra,
      placeholderCopy: raw.functional_checklist.placeholder_copy,
    },
    backendProbes: raw.backend_probes.map((p) =>
      p.kind === 'unauth_get'
        ? { kind: p.kind, id: p.id, path: p.path, expectStatus: p.expect_status }
        : {
            kind: p.kind,
            id: p.id,
            path: p.path,
            expectStatus: p.expect_status,
            forbidBodyContains: p.forbid_body_contains,
          },
    ),
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

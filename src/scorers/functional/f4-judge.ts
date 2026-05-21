import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getLlmClient, DEFAULT_JUDGE_MODEL } from '../../core/llm.ts';
import { writeJson } from '../../core/artifact.ts';
import type { ChecklistConfig, ChecklistItem } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const F4_VERSION = '0.3.0';

// Functional-intent criteria. Distinct from V1 (visual quality) — these ask whether
// the page actually does what the prompt asked for, beyond what F2's deterministic
// checks can verify.
const FUNCTIONAL_DEFAULTS: ChecklistItem[] = [
  { id: 'intent_match',         label: 'Intent match',         description: 'Does the page satisfy the user-facing purpose described in the prompt?' },
  { id: 'feature_completeness', label: 'Feature completeness', description: 'Are all named features/sections present and recognizable, not just stubbed?' },
  { id: 'content_relevance',    label: 'Content relevance',    description: 'Is the actual copy on-topic for the described product, not generic placeholder?' },
  { id: 'flow_coherence',       label: 'Flow coherence',       description: 'Does the page tell a coherent story matching the prompt (hero → features → CTA, etc.)?' },
];

interface CriterionScore {
  id: string;
  score: number;        // 1..5
  rationale: string;
}

interface JudgeOutput {
  criteria: CriterionScore[];
  missing_features?: string[];
  overall_notes?: string;
}

interface ScreenshotEntry {
  name: string;
  caption: string;
}

// Order matters: the judge reads them in this order alongside the caption text.
// scrolled-viewport is the canonical sticky-evidence image — the viewport is
// scrolled 800px down, so any element rendered at the top of this image is
// proven sticky/fixed (and any element absent from the top has scrolled away).
const SCREENSHOTS: ScreenshotEntry[] = [
  { name: 'initial', caption: 'Full-page screenshot at the top of the document (scroll = 0).' },
  { name: 'viewport-mobile', caption: 'Viewport-sized capture at mobile width (360x800).' },
  { name: 'scrolled-viewport', caption: 'Viewport-sized capture AFTER scrolling 800px down. Any element visible at the top of this image is sticky or fixed; any element described in the prompt as "sticky" but absent from the top here is NOT sticky.' },
  { name: 'mid-scroll', caption: 'Viewport-sized capture scrolled to roughly the middle of the page.' },
];

const SYSTEM_PROMPT = `You are evaluating whether an AI-generated webpage satisfies the FUNCTIONAL intent of the user's prompt.

You are NOT scoring visual design quality (a separate scorer handles that). You are scoring whether the page actually delivers what was asked for: the right features, the right content, the right purpose.

IMPORTANT: Respond ONLY with valid JSON matching this schema exactly:
{
  "criteria": [
    { "id": "<criterion_id>", "score": <1-5>, "rationale": "<one sentence>" }
  ],
  "missing_features": ["<feature explicitly named in prompt but absent from page>", ...],
  "overall_notes": "<optional 1-2 sentences>"
}

Score scale:
1 = Wrong page entirely / does not satisfy the prompt
2 = Partially satisfies, major features missing or misinterpreted
3 = Satisfies the basic intent, some gaps
4 = Satisfies the intent well, minor gaps
5 = Fully satisfies all stated requirements

Be calibrated: a prompt that asks for a "landing page with hero, three features, testimonials, CTA" should score 5 only if all four named sections are clearly present.`;

export async function runF4(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();

  const screenshots = await loadCaptionedScreenshots(ctx.paths.screenshots);
  if (screenshots.length === 0) {
    return {
      scorer: 'f4',
      version: F4_VERSION,
      passed: null,
      score: null,
      details: { note: 'No screenshots found — score submission first to capture them', elapsedMs: 0 },
    };
  }

  let client: ReturnType<typeof getLlmClient>;
  try {
    client = getLlmClient();
  } catch (err) {
    return {
      scorer: 'f4',
      version: F4_VERSION,
      passed: null,
      score: null,
      details: { note: err instanceof Error ? err.message : String(err), elapsedMs: 0 },
    };
  }

  const model = process.env['OPENROUTER_MODEL'] ?? DEFAULT_JUDGE_MODEL;

  const criteria = buildCriteria(ctx.prompt.functionalChecklist);
  const criteriaList = criteria.map(
    (c) => `- ${c.id}: ${c.label} — ${c.description}`,
  ).join('\n');

  const namedFeatures = [
    ...ctx.prompt.mustHave.map((c) => c.id),
    ...ctx.prompt.shouldHave.map((c) => c.id),
  ];
  const namedFeaturesBlock = namedFeatures.length > 0
    ? `\nFeatures named in the acceptance criteria (each should be visibly present):\n${namedFeatures.map((f) => `  - ${f}`).join('\n')}\n`
    : '';

  const userText = `Tool: ${ctx.submission.tool}
Prompt id: ${ctx.prompt.id}

Original prompt given to the sitebuilder:
"""
${ctx.prompt.prompt.trim()}
"""
${namedFeaturesBlock}
Score each of the following criteria from 1 to 5:
${criteriaList}

If any feature explicitly named in the prompt is absent from the screenshots, list it in "missing_features".

Respond with JSON only.`;

  try {
    const imageContent = screenshots.flatMap((s) => [
      { type: 'text' as const, text: `Screenshot: ${s.name}. ${s.caption}` },
      {
        type: 'image_url' as const,
        image_url: { url: `data:image/png;base64,${s.base64}`, detail: 'low' as const },
      },
    ]);

    const response = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [{ type: 'text', text: userText }, ...imageContent],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    let judgeOutput: JudgeOutput;
    try {
      judgeOutput = parseJudgeOutput(raw);
    } catch (err) {
      await writeJson(join(ctx.paths.root, 'f4-judge.json'), {
        model,
        raw,
        parseError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await writeJson(join(ctx.paths.root, 'f4-judge.json'), { model, raw, parsed: judgeOutput });

    const scored = judgeOutput.criteria
      .map((c) => ({ ...c, score: Number(c.score) }))
      .filter((c) => c.score >= 1 && c.score <= 5);
    const meanScore = scored.length > 0
      ? scored.reduce((s, c) => s + c.score, 0) / scored.length
      : null;
    const normalised = meanScore !== null ? (meanScore - 1) / 4 : null;

    return {
      scorer: 'f4',
      version: F4_VERSION,
      passed: normalised !== null ? normalised >= 0.5 : null,
      score: normalised,
      details: {
        model,
        meanRaw: meanScore !== null ? Number(meanScore.toFixed(2)) : null,
        criteria: scored,
        criteriaTotal: criteria.length,
        criteriaExtras: ctx.prompt.functionalChecklist.extra.length,
        missingFeatures: judgeOutput.missing_features ?? [],
        overallNotes: judgeOutput.overall_notes ?? null,
        screenshotsUsed: screenshots.length,
        usage: response.usage ?? null,
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'f4',
      version: F4_VERSION,
      passed: null,
      score: null,
      details: {
        model,
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// Builds the per-prompt criteria list: F4 defaults plus any prompt-specific
// extras from prompt.functional_checklist.extra. The placeholder_copy flag
// from ChecklistConfig is visual-only and ignored here.
function buildCriteria(config: ChecklistConfig): ChecklistItem[] {
  const list: ChecklistItem[] = [...FUNCTIONAL_DEFAULTS, ...config.extra];

  const byId = new Map<string, ChecklistItem>();
  for (const item of list) byId.set(item.id, item);
  return [...byId.values()];
}

async function loadCaptionedScreenshots(
  screenshotsDir: string,
): Promise<Array<{ name: string; caption: string; base64: string }>> {
  const out: Array<{ name: string; caption: string; base64: string }> = [];
  for (const entry of SCREENSHOTS) {
    const path = join(screenshotsDir, `${entry.name}.png`);
    if (existsSync(path)) {
      const buf = await readFile(path);
      out.push({ name: entry.name, caption: entry.caption, base64: buf.toString('base64') });
    }
  }
  return out;
}

function parseJudgeOutput(raw: string): JudgeOutput {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Model did not return JSON. Raw: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as JudgeOutput;
  if (!Array.isArray(parsed.criteria)) throw new Error('Missing criteria array in model output');
  return parsed;
}

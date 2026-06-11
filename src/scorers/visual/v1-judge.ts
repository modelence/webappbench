import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getLlmClient, createJudgeCompletion } from '../../core/llm.ts';
import { writeJson } from '../../core/artifact.ts';
import type { ChecklistConfig, ChecklistItem } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

// Two judges from different providers to mitigate self-preference bias.
// OPENROUTER_MODEL overrides both (useful for one-off experiments).
const DEFAULT_JUDGES = [
  'google/gemini-2.5-pro',
  'openai/gpt-5.5',
] as const;

export const V1_VERSION = '0.3.0';

// Default visual-quality criteria, always included.
const VISUAL_DEFAULTS = [
  { id: 'visual_hierarchy',  label: 'Visual hierarchy',   description: 'Clear focal points and visual flow guiding the eye through the page' },
  { id: 'typography',        label: 'Typography',          description: 'Readable font sizes, weights, line heights; clear heading scale' },
  { id: 'color_harmony',     label: 'Color harmony',       description: 'Cohesive palette with appropriate contrast; not garish or clashing' },
  { id: 'whitespace',        label: 'Whitespace',          description: 'Appropriate negative space between sections and elements' },
  { id: 'brand_fit',         label: 'Brand fit',           description: 'Design tone and aesthetic matches the described product/context in the prompt' },
  { id: 'cta_prominence',    label: 'CTA prominence',       description: 'Primary call-to-action is visually distinct and easy to find' },
  { id: 'mobile_layout',     label: 'Mobile layout',       description: 'Content is well-composed at mobile viewport (360px); nothing obviously broken' },
  { id: 'overall_polish',    label: 'Overall polish',      description: 'Professional quality overall; looks like a real product, not a rough prototype' },
];

// Copy-quality criteria, included by default but skipped when the prompt
// explicitly uses placeholder content (placeholder_copy: true).
const COPY_QUALITY_DEFAULTS = [
  { id: 'copy_specificity',  label: 'Copy specificity',    description: 'Headlines and feature descriptions name concrete benefits or specific user roles, not generic SaaS-speak ("revolutionize", "unlock", "next-level", "seamless", "the future of X")' },
  { id: 'no_fabricated_trust', label: 'No fabricated trust signals', description: 'No invented testimonials with stock-photo names, no fabricated customer logos, no invented metric badges ("10,000+ companies trust us") unless the prompt explicitly requests them' },
  { id: 'cta_clarity',       label: 'CTA clarity',         description: 'Primary CTA uses a specific action verb matching the prompt\'s stated user action (e.g., "Start free trial" / "Get the report" rather than generic "Get started" / "Learn more")' },
];

interface CriterionScore {
  id: string;
  score: number;        // 1..5
  rationale: string;
}

interface JudgeOutput {
  criteria: CriterionScore[];
  overall_notes?: string;
}

// `dashboard` is the authenticated (populated) view, present only for backend
// apps (skipped if absent) — so V1 judges the real app, not just the login
// screen. The empty-state shot is omitted from V1 (visual design is better
// judged on a populated UI).
const SCREENSHOT_NAMES = ['initial', 'viewport-mobile', 'mid-scroll', 'dashboard'] as const;

const SYSTEM_PROMPT = `You are an expert web design reviewer evaluating AI-generated web applications.
You will be shown screenshots of a website and asked to score it on specific visual design criteria.

IMPORTANT: Respond ONLY with valid JSON matching this schema exactly:
{
  "criteria": [
    { "id": "<criterion_id>", "score": <1-5>, "rationale": "<one sentence>" }
  ],
  "overall_notes": "<optional 1-2 sentences>"
}

Score scale — use the concrete anchors below, not just the labels:
1 = Broken or unusable: layout overflows, text illegible, buttons not visible, obviously unfinished
2 = Below average: functional but visually rough — inconsistent spacing, clashing colours, hard to scan
3 = Adequate: a competent default. Clean layout, readable text, no obvious errors. Looks like a generic template or a Bootstrap/Tailwind starter with no customisation. This is the expected baseline for AI-generated output.
4 = Good: clear visual identity beyond the default — a distinctive colour palette, considered typography scale, purposeful spacing rhythm, or a layout that feels designed rather than assembled
5 = Exceptional: production-quality. Multiple design decisions working together — custom brand character, polished micro-details (icon alignment, hover states, shadow depth), and a cohesive aesthetic that would not look out of place on a real product's marketing site or app. This should be rare.

Calibration rules:
- A plain white/light-grey background with default system or generic sans-serif font, no custom colour palette, and no visual character beyond functional layout is a 3, not higher — even if it is clean and bug-free.
- A score of 4 requires at least one clearly intentional design decision that elevates it above a generic template.
- A score of 5 requires multiple such decisions working together cohesively. Do not give 5 simply because the design is inoffensive or "professional-looking in a generic sense".
- Scores of 4 and 5 combined should represent roughly the top 20–30% of well-executed designs. If you find yourself giving mostly 4s and 5s, recalibrate.`;

export async function runV1(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();

  const screenshots = await loadScreenshots(ctx.paths.screenshots);
  if (screenshots.length === 0) {
    return {
      scorer: 'v1',
      version: V1_VERSION,
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
      scorer: 'v1',
      version: V1_VERSION,
      passed: null,
      score: null,
      details: { note: err instanceof Error ? err.message : String(err), elapsedMs: 0 },
    };
  }

  // OPENROUTER_MODEL overrides to a single model (useful for experiments).
  const modelOverride = process.env['OPENROUTER_MODEL'];
  const models = modelOverride ? [modelOverride] : [...DEFAULT_JUDGES];

  const criteria = buildCriteria(ctx.prompt.visualChecklist);
  const criteriaList = criteria.map(
    (c) => `- ${c.id}: ${c.label} — ${c.description}`,
  ).join('\n');

  const userText = `Original prompt given to the sitebuilder:
"""
${ctx.submission.tool} / ${ctx.prompt.id}
${ctx.prompt.prompt.trim()}
"""

Score each of the following criteria from 1 to 5:
${criteriaList}

Respond with JSON only.`;

  const imageContent = screenshots.map((b64) => ({
    type: 'image_url' as const,
    image_url: { url: `data:image/png;base64,${b64}`, detail: 'low' as const },
  }));

  // Run both judges in parallel.
  const judgeResults = await Promise.all(
    models.map(async (model) => {
      try {
        // No cross-model fallback here: V1 already runs a diverse model PAIR and
        // averages the survivors, so a per-model fallback would just duplicate the
        // other judge. Empty-200 retries (within the same model) still apply.
        const { raw, usage } = await createJudgeCompletion(client, {
          model,
          fallbackModel: null,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: [{ type: 'text', text: userText }, ...imageContent] },
          ],
        });
        const parsed = parseJudgeOutput(raw);
        return { model, raw, parsed, usage, error: null };
      } catch (err) {
        return { model, raw: '', parsed: null, usage: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  await writeJson(join(ctx.paths.root, 'v1-judge.json'), { models, judges: judgeResults });

  // Aggregate: average each criterion score across judges that succeeded,
  // then average across criteria for the final mean.
  const successfulJudges = judgeResults.filter((j) => j.parsed !== null);
  if (successfulJudges.length === 0) {
    return {
      scorer: 'v1',
      version: V1_VERSION,
      passed: null,
      score: null,
      details: {
        models,
        elapsedMs: Date.now() - start,
        error: judgeResults.map((j) => `${j.model}: ${j.error}`).join('; '),
      },
    };
  }

  // Per-criterion mean across judges, then flag disagreements (>1 point apart).
  const criterionIds = criteria.map((c) => c.id);
  const aggregated = criterionIds.map((id) => {
    const perJudge = successfulJudges.flatMap((j) => {
      const c = j.parsed!.criteria.find((x) => x.id === id);
      if (!c) return [];
      const score = Number(c.score);
      if (score < 1 || score > 5) return [];
      return [{ model: j.model, score, rationale: c.rationale }];
    });
    if (perJudge.length === 0) return null;
    const mean = perJudge.reduce((s, c) => s + c.score, 0) / perJudge.length;
    const max = Math.max(...perJudge.map((c) => c.score));
    const min = Math.min(...perJudge.map((c) => c.score));
    return { id, meanScore: mean, disagreement: max - min > 1, perJudge };
  }).filter((c): c is NonNullable<typeof c> => c !== null);

  const overallMean = aggregated.length > 0
    ? aggregated.reduce((s, c) => s + c.meanScore, 0) / aggregated.length
    : null;
  const normalised = overallMean !== null ? (overallMean - 1) / 4 : null;
  const disagreements = aggregated.filter((c) => c.disagreement).map((c) => c.id);

  const overallNotes = successfulJudges
    .map((j) => j.parsed?.overall_notes)
    .filter(Boolean)
    .join(' | ');

  return {
    scorer: 'v1',
    version: V1_VERSION,
    passed: normalised !== null ? normalised >= 0.5 : null,
    score: normalised,
    details: {
      models,
      judgesSucceeded: successfulJudges.length,
      meanRaw: overallMean !== null ? Number(overallMean.toFixed(2)) : null,
      criteria: aggregated,
      criteriaTotal: criteria.length,
      criteriaExtras: ctx.prompt.visualChecklist.extra.length,
      placeholderCopy: ctx.prompt.visualChecklist.placeholderCopy,
      disagreements,
      overallNotes: overallNotes || null,
      screenshotsUsed: screenshots.length,
      elapsedMs: Date.now() - start,
    },
  };
}

// Builds the per-prompt criteria list:
//   1. The 8 default visual-quality criteria (always included).
//   2. Three copy-quality criteria (skipped when prompt sets placeholder_copy: true).
//   3. Any prompt-specific extras from prompt.visual_checklist.extra.
// Duplicate ids are de-duplicated, keeping the last occurrence so prompt extras
// can override default descriptions if they reuse a default id intentionally.
function buildCriteria(config: ChecklistConfig): ChecklistItem[] {
  const list: ChecklistItem[] = [...VISUAL_DEFAULTS];
  if (!config.placeholderCopy) list.push(...COPY_QUALITY_DEFAULTS);
  list.push(...config.extra);

  const byId = new Map<string, ChecklistItem>();
  for (const item of list) byId.set(item.id, item);
  return [...byId.values()];
}

async function loadScreenshots(screenshotsDir: string): Promise<string[]> {
  const b64s: string[] = [];
  for (const name of SCREENSHOT_NAMES) {
    const path = join(screenshotsDir, `${name}.png`);
    if (existsSync(path)) {
      const buf = await readFile(path);
      b64s.push(buf.toString('base64'));
    }
  }
  return b64s;
}

function parseJudgeOutput(raw: string): JudgeOutput {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Model did not return JSON. Raw: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as JudgeOutput;
  if (!Array.isArray(parsed.criteria)) throw new Error('Missing criteria array in model output');
  return parsed;
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getLlmClient, DEFAULT_JUDGE_MODEL } from '../../core/llm.ts';
import { writeJson } from '../../core/artifact.ts';
import type { ChecklistConfig, ChecklistItem } from '../../core/types.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const V1_VERSION = '0.2.0';

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

const SYSTEM_PROMPT = `You are an expert web design reviewer evaluating AI-generated landing pages.
You will be shown screenshots of a website and asked to score it on specific visual design criteria.

IMPORTANT: Respond ONLY with valid JSON matching this schema exactly:
{
  "criteria": [
    { "id": "<criterion_id>", "score": <1-5>, "rationale": "<one sentence>" }
  ],
  "overall_notes": "<optional 1-2 sentences>"
}

Score scale:
1 = Very poor / unusable
2 = Below average
3 = Adequate / average for AI-generated content
4 = Good, above average
5 = Excellent / professional quality

Be calibrated: a score of 3 is normal for AI-generated sites. Reserve 5 for genuinely impressive work.`;

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

  const model = process.env['OPENROUTER_MODEL'] ?? DEFAULT_JUDGE_MODEL;

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

  try {
    const imageContent = screenshots.map((b64) => ({
      type: 'image_url' as const,
      image_url: { url: `data:image/png;base64,${b64}`, detail: 'low' as const },
    }));

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
      await writeJson(join(ctx.paths.root, 'v1-judge.json'), {
        model,
        raw,
        parseError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await writeJson(join(ctx.paths.root, 'v1-judge.json'), { model, raw, parsed: judgeOutput });

    const scored = judgeOutput.criteria
      .map((c) => ({ ...c, score: Number(c.score) }))
      .filter((c) => c.score >= 1 && c.score <= 5);
    const meanScore = scored.length > 0
      ? scored.reduce((s, c) => s + c.score, 0) / scored.length
      : null;
    const normalised = meanScore !== null ? (meanScore - 1) / 4 : null;

    const usage = response.usage;

    return {
      scorer: 'v1',
      version: V1_VERSION,
      passed: normalised !== null ? normalised >= 0.5 : null,
      score: normalised,
      details: {
        model,
        meanRaw: meanScore !== null ? Number(meanScore.toFixed(2)) : null,
        criteria: scored,
        criteriaTotal: criteria.length,
        criteriaExtras: ctx.prompt.visualChecklist.extra.length,
        placeholderCopy: ctx.prompt.visualChecklist.placeholderCopy,
        overallNotes: judgeOutput.overall_notes ?? null,
        screenshotsUsed: screenshots.length,
        usage: usage ?? null,
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'v1',
      version: V1_VERSION,
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

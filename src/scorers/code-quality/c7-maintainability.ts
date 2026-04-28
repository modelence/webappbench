import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { getLlmClient, DEFAULT_JUDGE_MODEL } from '../../core/llm.ts';
import { writeJson } from '../../core/artifact.ts';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C7_VERSION = '0.1.0';

// Token budget for the source excerpt sent to the judge. ~12k chars ≈ 3k tokens
// keeps the call cheap while letting the model see enough code to form a judgment.
const MAX_EXCERPT_CHARS = 12_000;
const MAX_FILES_IN_EXCERPT = 12;
const MAX_FILE_SIZE_BYTES = 50_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'public']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const CRITERIA = [
  { id: 'naming',                label: 'Naming',                description: 'Variables, functions, components, and files have clear, intentional names matching their role' },
  { id: 'separation_of_concerns', label: 'Separation of concerns', description: 'Components/modules have a single responsibility; presentation, state, and side effects are not entangled' },
  { id: 'component_reuse',       label: 'Component reuse',       description: 'Repeated UI patterns are extracted into shared components instead of duplicated' },
  { id: 'prop_typing',           label: 'Prop typing',           description: 'Component props are typed (TypeScript interfaces or PropTypes); no implicit any on public surfaces' },
  { id: 'secret_handling',       label: 'Secret handling',       description: 'Secrets, API keys, and tokens come from env vars; no hardcoded credentials in source' },
] as const;

type CriterionId = (typeof CRITERIA)[number]['id'];

interface CriterionScore {
  id: CriterionId;
  score: number;        // 1..5
  rationale: string;
}

interface JudgeOutput {
  criteria: CriterionScore[];
  overall_notes?: string;
}

const SYSTEM_PROMPT = `You are an expert TypeScript/React code reviewer evaluating maintainability of AI-generated source code.

You will be shown a sampled excerpt from a project's source tree. Score the code on specific maintainability criteria.

IMPORTANT: Respond ONLY with valid JSON matching this schema exactly:
{
  "criteria": [
    { "id": "<criterion_id>", "score": <1-5>, "rationale": "<one sentence>" }
  ],
  "overall_notes": "<optional 1-2 sentences>"
}

Score scale anchored on component size and structure:
1 = >400 LOC components, untyped, mixed concerns, hardcoded secrets
2 = Below average — large files, weak typing, duplication
3 = Adequate / average for AI-generated code — 150-400 LOC, mixed concerns acceptable
4 = Good — focused components, typed props, clear separation
5 = Excellent — components <150 LOC, single responsibility, fully typed props, no secrets in source

Be calibrated: a score of 3 is normal for AI-generated code. Reserve 5 for genuinely well-structured projects.`;

interface SourceFile {
  path: string;
  content: string;
  size: number;
}

export async function runC7(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();

  if (!ctx.sourceDir) {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: 'No source directory — c7 requires a source ZIP', elapsedMs: 0 },
    };
  }

  let client: ReturnType<typeof getLlmClient>;
  try {
    client = getLlmClient();
  } catch (err) {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: err instanceof Error ? err.message : String(err), elapsedMs: 0 },
    };
  }

  const files = await sampleSourceFiles(ctx.sourceDir);
  if (files.length === 0) {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: 'No TypeScript/JavaScript source files found', elapsedMs: Date.now() - start },
    };
  }

  const excerpt = buildExcerpt(files);
  const model = process.env['OPENROUTER_MODEL'] ?? DEFAULT_JUDGE_MODEL;
  const criteriaList = CRITERIA.map((c) => `- ${c.id}: ${c.label} — ${c.description}`).join('\n');

  const userText = `Tool: ${ctx.submission.tool}
Prompt id: ${ctx.prompt.id}

Source excerpt (${files.length} of the project's most representative files, truncated to fit budget):

${excerpt}

Score each of the following criteria from 1 to 5:
${criteriaList}

Respond with JSON only.`;

  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    let judgeOutput: JudgeOutput;
    try {
      judgeOutput = parseJudgeOutput(raw);
    } catch (err) {
      await writeJson(join(ctx.paths.root, 'c7-judge.json'), {
        model,
        raw,
        parseError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await writeJson(join(ctx.paths.root, 'c7-judge.json'), {
      model,
      raw,
      parsed: judgeOutput,
      sampledFiles: files.map((f) => f.path),
    });

    const scored = judgeOutput.criteria
      .map((c) => ({ ...c, score: Number(c.score) }))
      .filter((c) => c.score >= 1 && c.score <= 5);
    const meanScore = scored.length > 0
      ? scored.reduce((s, c) => s + c.score, 0) / scored.length
      : null;
    const normalised = meanScore !== null ? (meanScore - 1) / 4 : null;

    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: normalised !== null ? normalised >= 0.5 : null,
      score: normalised,
      details: {
        model,
        meanRaw: meanScore !== null ? Number(meanScore.toFixed(2)) : null,
        criteria: scored,
        overallNotes: judgeOutput.overall_notes ?? null,
        sampledFileCount: files.length,
        sampledFiles: files.map((f) => f.path),
        usage: response.usage ?? null,
        elapsedMs: Date.now() - start,
      },
    };
  } catch (err) {
    return {
      scorer: 'c7',
      version: C7_VERSION,
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

// Sample files prioritising the kind of code that reveals project structure:
// entry points, components, and hooks. Keeps the judge focused on representative
// code rather than build configs or generated boilerplate.
async function sampleSourceFiles(sourceDir: string): Promise<SourceFile[]> {
  const all: SourceFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) continue;
      const s = await stat(full).catch(() => null);
      if (!s || s.size > MAX_FILE_SIZE_BYTES) continue;
      const content = await readFile(full, 'utf8').catch(() => null);
      if (!content) continue;
      all.push({ path: relative(sourceDir, full), content, size: s.size });
    }
  }

  await walk(sourceDir);

  // Prioritise: entry points first, then components/hooks, then everything else.
  // Within each tier, prefer smaller files to fit more variety into the budget.
  const tier = (path: string): number => {
    const lower = path.toLowerCase();
    if (/(^|\/)(index|main|app)\.[tj]sx?$/.test(lower)) return 0;
    if (/(^|\/)(components|hooks|features|pages)\//.test(lower)) return 1;
    if (/\.(tsx|jsx)$/.test(lower)) return 2;
    return 3;
  };
  all.sort((a, b) => {
    const tierDiff = tier(a.path) - tier(b.path);
    if (tierDiff !== 0) return tierDiff;
    return a.size - b.size;
  });

  return all.slice(0, MAX_FILES_IN_EXCERPT);
}

function buildExcerpt(files: SourceFile[]): string {
  const parts: string[] = [];
  let usedChars = 0;

  for (const file of files) {
    const header = `\n--- ${file.path} ---\n`;
    const remaining = MAX_EXCERPT_CHARS - usedChars - header.length;
    if (remaining <= 200) break;
    const body = file.content.length > remaining
      ? `${file.content.slice(0, remaining - 20)}\n... [truncated]`
      : file.content;
    parts.push(header + body);
    usedChars += header.length + body.length;
  }

  return parts.join('\n');
}

function parseJudgeOutput(raw: string): JudgeOutput {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Model did not return JSON. Raw: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as JudgeOutput;
  if (!Array.isArray(parsed.criteria)) throw new Error('Missing criteria array in model output');
  return parsed;
}

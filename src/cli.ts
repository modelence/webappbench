import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { loadDotenv } from './core/env.ts';

await loadDotenv();
import { createSubmissionArtifact } from './core/submission.ts';
import { TOOL_NAME_PATTERN } from './core/types.ts';
import type { ToolName, UserReportedCost, UserReportedTiming } from './core/types.ts';
import { loadCorpus } from './prompts/schema.ts';
import { computeComposite, formatComposite, formatCompositeBreakdown } from './scorers/composite.ts';
import { makeProgressHandler } from './scorers/progress.ts';
import { scoreSubmission } from './scorers/orchestrate.ts';
import { scoreAll, runOne } from './scorers/score-all.ts';
import { loadConfig } from './core/config.ts';
import { generateReport } from './report/generate.ts';
import { generateFixReport, generateFixReportRollup } from './report/fix-report.ts';

const program = new Command();

program
  .name('benchmark')
  .description('Open-source benchmark for AI sitebuilder products')
  .version('0.1.0');

program
  .command('tools')
  .description('List tools that have artifacts on disk (any kebab-case name is accepted at submit time)')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .action(async (opts: { artifacts: string }) => {
    const tools = await listToolsWithArtifacts(opts.artifacts);
    if (tools.length === 0) {
      console.log(`No tools found under ${opts.artifacts}/.`);
      console.log('Submit a run first: npm run bench -- submit --tool <name> --prompt <id> --url <url>');
      return;
    }
    for (const t of tools) {
      console.log(t);
    }
  });

async function listToolsWithArtifacts(artifactsRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(artifactsRoot);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const tools: string[] = [];
  for (const name of entries) {
    if (!TOOL_NAME_PATTERN.test(name)) continue;
    const info = await stat(join(artifactsRoot, name)).catch(() => null);
    if (info?.isDirectory()) tools.push(name);
  }
  return tools.sort();
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

program
  .command('prompts')
  .description('List all loadable prompts from the corpus')
  .option('-d, --dir <dir>', 'Corpus directory', 'prompts/corpus')
  .action(async (opts: { dir: string }) => {
    const prompts = await loadCorpus(opts.dir);
    for (const p of prompts) {
      console.log(
        `${p.id}\ttier=${p.tier}\tmust=${p.mustHave.length}\tshould=${p.shouldHave.length}\tverbatim=${p.verbatimConstraints.length}`,
      );
    }
    console.log(`\n${prompts.length} prompt(s) loaded from ${opts.dir}`);
  });

function parseToolName(value: string): ToolName {
  if (!TOOL_NAME_PATTERN.test(value)) {
    throw new InvalidArgumentError(
      `Tool name "${value}" must be lowercase kebab-case (a-z, 0-9, hyphens; must start with a letter or digit).`,
    );
  }
  return value;
}

function parseNonNegativeInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(`Expected non-negative integer, got "${value}"`);
  }
  return n;
}

function parseNonNegativeFloat(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(`Expected non-negative number, got "${value}"`);
  }
  return n;
}

interface SubmitOptions {
  tool: ToolName;
  prompt: string;
  url: string;
  source?: string;
  run: number;
  toolVersion?: string;
  corpus: string;
  artifacts: string;
  promptSubmittedAt?: string;
  firstRenderAt?: string;
  workingBuildAt?: string;
  credits?: number;
  usd?: number;
  note?: string;
}

program
  .command('submit')
  .description('Record a single manual submission: a tool + prompt + deployed URL')
  .requiredOption('-t, --tool <tool>', 'Tool name', parseToolName)
  .requiredOption('-p, --prompt <id>', 'Prompt id (must exist in corpus)')
  .requiredOption('-u, --url <url>', 'Deployed preview URL from the tool')
  .option('-s, --source <path>', 'Path to .zip of the generated source code')
  .option('-r, --run <idx>', 'Run index', parseNonNegativeInt, 0)
  .option('--tool-version <ver>', 'Tool version (defaults to ISO week of today)')
  .option('-d, --corpus <dir>', 'Corpus directory', 'prompts/corpus')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .option('--prompt-submitted-at <iso>', 'User-reported ISO time prompt was sent')
  .option('--first-render-at <iso>', 'User-reported ISO time first preview appeared')
  .option('--working-build-at <iso>', 'User-reported ISO time build looked correct')
  .option('--credits <n>', 'User-reported credits spent', parseNonNegativeFloat)
  .option('--usd <n>', 'User-reported USD cost estimate', parseNonNegativeFloat)
  .option('--note <text>', 'Free-text note stored with cost data')
  .action(async (opts: SubmitOptions) => {
    const { submission, prompt, paths } = await createSubmissionArtifact({
      tool: opts.tool,
      promptId: opts.prompt,
      runIdx: opts.run,
      url: opts.url,
      sourcePath: opts.source,
      toolVersion: opts.toolVersion,
      timing: userReportedTimingFrom(opts),
      cost: userReportedCostFrom(opts),
      corpusDir: opts.corpus,
      artifactsRoot: opts.artifacts,
    });
    console.log(`Submission recorded at ${paths.root}`);
    console.log(`  tool          ${submission.tool} (${submission.toolVersion})`);
    console.log(`  prompt        ${submission.promptId} (tier ${prompt.tier})`);
    console.log(`  artifactUrl   ${submission.artifactUrl}`);
    console.log('');
    console.log('Next: npm run bench -- score', paths.root);
  });

interface ScoreOptions {
  tool?: ToolName;
  prompt?: string;
  run?: number;
  config: string;
  corpus: string;
  artifacts: string;
  report: boolean;
  out: string;
}

program
  .command('score')
  .description('Score a submission. Pass <dir> to score an existing artifact directory, or use --tool to submit + score from submissions.yaml and regenerate the leaderboard.')
  .argument('[dir]', 'Submission directory (contains submission.json + prompt.json)')
  .option('-t, --tool <tool>', 'Tool name (reads entry from submissions.yaml)', parseToolName)
  .option('-p, --prompt <id>', 'Prompt id (required only when the tool has multiple entries)')
  .option('-r, --run <idx>', 'Run index (required only when the tool has multiple entries)', parseNonNegativeInt)
  .option('-c, --config <path>', 'Submissions config file', 'submissions.yaml')
  .option('-d, --corpus <dir>', 'Corpus directory', 'prompts/corpus')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .option('--no-report', 'Skip regenerating leaderboard.html (only when --tool is used)')
  .option('-o, --out <file>', 'Leaderboard output file', 'leaderboard.html')
  .action(async (dir: string | undefined, opts: ScoreOptions) => {
    if (opts.tool) {
      if (dir) {
        throw new InvalidArgumentError('Pass either <dir> or --tool, not both.');
      }
      await scoreFromConfig(opts);
      return;
    }
    if (!dir) {
      throw new InvalidArgumentError('score requires either <dir> or --tool');
    }
    console.log(`Scoring ${dir}`);
    const { onProgress, flush } = makeProgressHandler();
    const { results } = await scoreSubmission(dir, { onProgress });
    flush();
    const composite = computeComposite(results);
    console.log(`  ${formatComposite(composite)}`);
    const breakdown = formatCompositeBreakdown(composite);
    if (breakdown) console.log(breakdown);
  });

async function scoreFromConfig(opts: ScoreOptions): Promise<void> {
  const config = await loadConfig(opts.config);
  const matches = config.runs.filter((r) => {
    if (r.tool !== opts.tool) return false;
    if (opts.prompt !== undefined && r.prompt !== opts.prompt) return false;
    if (opts.run !== undefined && r.runIdx !== opts.run) return false;
    return true;
  });
  if (matches.length === 0) {
    const filter = [
      `tool=${opts.tool}`,
      opts.prompt !== undefined ? `prompt=${opts.prompt}` : null,
      opts.run !== undefined ? `run=${opts.run}` : null,
    ].filter(Boolean).join(', ');
    throw new InvalidArgumentError(`No entry in ${opts.config} matches ${filter}`);
  }
  if (matches.length > 1 && (opts.prompt === undefined || opts.run === undefined)) {
    const labels = matches.map((m) => `  - prompt=${m.prompt} run=${m.runIdx}`).join('\n');
    throw new InvalidArgumentError(
      `Multiple entries match tool=${opts.tool}; disambiguate with --prompt and --run:\n${labels}`,
    );
  }

  let okCount = 0;
  let failCount = 0;
  for (const entry of matches) {
    console.log(`\n→ ${entry.tool}/${entry.prompt}/${entry.runIdx}  ${entry.url}`);
    const outcome = await runOne(entry, {
      corpusDir: opts.corpus,
      artifactsRoot: opts.artifacts,
    });
    if (outcome.ok) {
      okCount += 1;
    } else {
      failCount += 1;
      console.error(`  failed: ${outcome.error}`);
    }
  }
  console.log('');
  console.log(`Finished: ${okCount} scored, ${failCount} failed.`);

  if (opts.report) {
    const runs = await generateReport(opts.artifacts, opts.out);
    console.log(`Wrote ${opts.out} with ${runs.length} scored run(s)`);
  }
  if (failCount > 0) process.exitCode = 1;
}


interface ScoreAllOptions {
  config: string;
  corpus: string;
  artifacts: string;
  report: boolean;
  out: string;
}

program
  .command('score-all')
  .description('Submit + score every entry in submissions.yaml, then generate the leaderboard')
  .option('-c, --config <path>', 'Submissions config file', 'submissions.yaml')
  .option('-d, --corpus <dir>', 'Corpus directory', 'prompts/corpus')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .option('--no-report', 'Skip generating leaderboard.html after scoring')
  .option('-o, --out <file>', 'Leaderboard output file', 'leaderboard.html')
  .action(async (opts: ScoreAllOptions) => {
    const outcomes = await scoreAll({
      configPath: opts.config,
      corpusDir: opts.corpus,
      artifactsRoot: opts.artifacts,
    });
    const ok = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - ok;
    console.log('');
    console.log(`Finished: ${ok} scored, ${failed} failed.`);

    if (opts.report) {
      const runs = await generateReport(opts.artifacts, opts.out);
      console.log(`Wrote ${opts.out} with ${runs.length} scored run(s)`);
    }
    if (failed > 0) process.exitCode = 1;
  });

program
  .command('report')
  .description('Generate leaderboard.html from scored submissions')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .option('-o, --out <file>', 'Output file', 'leaderboard.html')
  .action(async (opts: { artifacts: string; out: string }) => {
    const runs = await generateReport(opts.artifacts, opts.out);
    console.log(`Wrote ${opts.out} with ${runs.length} scored run(s)`);
  });

program
  .command('fix-report')
  .description('Generate an actionable Markdown audit of failing scorers (paste into an AI to drive fixes)')
  .argument('[dir]', 'Submission directory (single-submission mode) — omit when using --all')
  .option('-o, --out <file>', 'Output file. Defaults to <dir>/fix-report.md or <artifacts>/fix-report.md when --all is set')
  .option('--all', 'Rollup mode: walk every submission under --artifacts and emit one combined report')
  .option('-a, --artifacts <dir>', 'Artifacts root (only used with --all)', 'artifacts')
  .option('-t, --tool <name>', 'Filter rollup to a single tool (only used with --all)')
  .action(async (
    dir: string | undefined,
    opts: { out?: string; all?: boolean; artifacts: string; tool?: string },
  ) => {
    if (opts.all) {
      const result = await generateFixReportRollup({
        artifactsRoot: opts.artifacts,
        out: opts.out,
        tool: opts.tool,
      });
      const filterNote = opts.tool ? ` for tool=${opts.tool}` : '';
      console.log(`Wrote ${result.outFile} covering ${result.submissionCount} submission(s) across ${result.toolCount} tool(s)${filterNote}`);
      return;
    }
    if (!dir) {
      throw new InvalidArgumentError('fix-report requires <dir> argument or --all flag');
    }
    const result = await generateFixReport({ artifactDir: dir, out: opts.out });
    console.log(`Wrote ${result.outFile} (${result.failingScorers} failing scorer${result.failingScorers === 1 ? '' : 's'})`);
  });

function userReportedTimingFrom(opts: SubmitOptions): UserReportedTiming | undefined {
  const t: UserReportedTiming = {};
  if (opts.promptSubmittedAt) t.promptSubmittedAt = opts.promptSubmittedAt;
  if (opts.firstRenderAt) t.firstRenderAt = opts.firstRenderAt;
  if (opts.workingBuildAt) t.workingBuildAt = opts.workingBuildAt;
  return Object.keys(t).length > 0 ? t : undefined;
}

function userReportedCostFrom(opts: SubmitOptions): UserReportedCost | undefined {
  const c: UserReportedCost = {};
  if (opts.credits !== undefined) c.credits = opts.credits;
  if (opts.usd !== undefined) c.usdEstimate = opts.usd;
  if (opts.note) c.notes = opts.note;
  return Object.keys(c).length > 0 ? c : undefined;
}

await program.parseAsync(process.argv);

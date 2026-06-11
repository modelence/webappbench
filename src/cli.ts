#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { loadDotenv } from './core/env.ts';

await loadDotenv();
import { readPackageVersion } from './core/version.ts';
import { createSubmissionArtifact } from './core/submission.ts';
import { TOOL_NAME_PATTERN } from './core/types.ts';
import type { ToolName, UserReportedCost, UserReportedTiming } from './core/types.ts';
import { loadCorpus } from './prompts/schema.ts';
import { computeComposite, formatComposite, formatCompositeBreakdown } from './scorers/composite.ts';
import { makeProgressHandler } from './scorers/progress.ts';
import { scoreSubmission } from './scorers/orchestrate.ts';
import { runOne } from './scorers/score-all.ts';
import { loadConfig } from './core/config.ts';
import { generateReport } from './report/generate.ts';
import { generateFixReport, generateFixReportRollup } from './report/fix-report.ts';

const program = new Command();

program
  .name('webappbench')
  .description('Open-source benchmark for AI sitebuilder products')
  .version(await readPackageVersion());

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
  cost?: number;
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
  .option('--cost <n>', 'User-reported approximate USD cost of the run', parseNonNegativeFloat)
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
    console.log('Next: npm run bench -- rescore', paths.root);
  });

interface ScoreOptions {
  prompt?: string;
  run?: number;
  scorer?: string;
  config: string;
  corpus: string;
  artifacts: string;
  leaderboard: boolean;
  out: string;
}

program
  .command('score')
  .description('Submit + score entries from submissions.yaml, then regenerate the leaderboard. Pass <tool> to filter to one tool; omit to score every entry. URL and source are read from the config.')
  .argument('[tool]', 'Tool name (must have at least one entry in submissions.yaml). Omit to score every entry.', parseToolName)
  .option('-p, --prompt <id>', 'Filter to a single prompt id (requires <tool>)')
  .option('-r, --run <idx>', 'Filter to a single run index (requires <tool>)', parseNonNegativeInt)
  .option('-s, --scorer <ids>', 'Comma-separated scorer IDs to run (e.g. v1,f4). Omit to run all.')
  .option('-c, --config <path>', 'Submissions config file', 'submissions.yaml')
  .option('-d, --corpus <dir>', 'Corpus directory', 'prompts/corpus')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .option('--no-leaderboard', 'Skip regenerating leaderboard.html')
  .option('-o, --out <file>', 'Leaderboard output file', 'leaderboard.html')
  .action(async (tool: ToolName | undefined, opts: ScoreOptions) => {
    if (tool === undefined && (opts.prompt !== undefined || opts.run !== undefined)) {
      throw new InvalidArgumentError('--prompt and --run require a <tool> argument');
    }
    await scoreFromConfig(tool, opts);
  });

program
  .command('rescore')
  .description('Re-score an existing submission artifact directory in place (does not read submissions.yaml)')
  .argument('<dir>', 'Submission directory (contains submission.json + prompt.json)')
  .option('-s, --scorer <ids>', 'Comma-separated scorer IDs to run (e.g. v1,f4). Omit to run all.')
  .action(async (dir: string, opts: { scorer?: string }) => {
    const only = opts.scorer ? opts.scorer.split(',').map(s => s.trim()) : undefined;
    if (only) console.log(`Scorer filter: ${only.join(', ')}`);
    console.log(`Scoring ${dir}`);
    const { onProgress, flush } = makeProgressHandler();
    const { results } = await scoreSubmission(dir, { onProgress, only });
    flush();
    const composite = computeComposite(results);
    console.log(`  ${formatComposite(composite)}`);
    const breakdown = formatCompositeBreakdown(composite);
    if (breakdown) console.log(breakdown);
  });

async function scoreFromConfig(tool: ToolName | undefined, opts: ScoreOptions): Promise<void> {
  const config = await loadConfig(opts.config);
  const matches = config.runs.filter((r) => {
    if (tool !== undefined && r.tool !== tool) return false;
    if (opts.prompt !== undefined && r.prompt !== opts.prompt) return false;
    if (opts.run !== undefined && r.runIdx !== opts.run) return false;
    return true;
  });
  if (matches.length === 0) {
    const filter = [
      tool !== undefined ? `tool=${tool}` : null,
      opts.prompt !== undefined ? `prompt=${opts.prompt}` : null,
      opts.run !== undefined ? `run=${opts.run}` : null,
    ].filter(Boolean).join(', ') || '(no filter)';
    throw new InvalidArgumentError(`No entry in ${opts.config} matches ${filter}`);
  }

  let okCount = 0;
  let failCount = 0;
  for (const entry of matches) {
    console.log(`\n→ ${entry.tool}/${entry.prompt}/${entry.runIdx}  ${entry.url}`);
    const outcome = await runOne(entry, {
      corpusDir: opts.corpus,
      artifactsRoot: opts.artifacts,
      only: opts.scorer ? opts.scorer.split(',').map(x => x.trim()).filter(Boolean) : undefined,
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

  if (opts.leaderboard) {
    const includeOnly = config.runs.map((r) => ({ tool: r.tool, promptId: r.prompt, runIdx: r.runIdx }));
    const runs = await generateReport(opts.artifacts, opts.out, includeOnly);
    console.log(`Wrote ${opts.out} with ${runs.length} scored run(s) (entries in ${opts.config} only)`);
  }
  if (failCount > 0) process.exitCode = 1;
}

program
  .command('leaderboard')
  .description('Generate leaderboard.html from scored submissions. By default only runs listed in submissions.yaml are included; pass --all to include every artifact.')
  .option('-a, --artifacts <dir>', 'Artifacts root', 'artifacts')
  .option('-o, --out <file>', 'Output file', 'leaderboard.html')
  .option('-c, --config <path>', 'Submissions config used to filter runs', 'submissions.yaml')
  .option('--all', 'Include every scored artifact, ignoring the submissions config')
  .action(async (opts: { artifacts: string; out: string; config: string; all?: boolean }) => {
    let includeOnly: { tool: string; promptId: string; runIdx: number }[] | undefined;
    if (!opts.all) {
      try {
        const config = await loadConfig(opts.config);
        includeOnly = config.runs.map((r) => ({ tool: r.tool, promptId: r.prompt, runIdx: r.runIdx }));
      } catch (err) {
        console.warn(
          `Could not read ${opts.config} (${err instanceof Error ? err.message : String(err)}); including all artifacts.`,
        );
      }
    }
    const runs = await generateReport(opts.artifacts, opts.out, includeOnly);
    const scope = includeOnly ? ` (entries in ${opts.config} only)` : '';
    console.log(`Wrote ${opts.out} with ${runs.length} scored run(s)${scope}`);
  });

program
  .command('audit')
  .description('Generate an actionable Markdown audit of failing scorers (paste into an AI to drive fixes)')
  .argument('[dir]', 'Submission directory (single-submission mode) — omit when using --all')
  .option('-o, --out <file>', 'Output file. Defaults to <dir>/audit.md or <artifacts>/audit.md when --all is set')
  .option('--all', 'Rollup mode: walk every submission under --artifacts and emit one combined audit')
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
      throw new InvalidArgumentError('audit requires <dir> argument or --all flag');
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
  if (opts.cost !== undefined) c.cost = opts.cost;
  if (opts.note) c.notes = opts.note;
  return Object.keys(c).length > 0 ? c : undefined;
}

await program.parseAsync(process.argv);

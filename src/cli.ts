import { Command, InvalidArgumentError } from 'commander';
import { createSubmissionArtifact } from './core/submission.ts';
import { ALL_TOOLS } from './core/types.ts';
import type { ToolName, UserReportedCost, UserReportedTiming } from './core/types.ts';
import { loadCorpus } from './prompts/schema.ts';
import { scoreSubmission } from './scorers/orchestrate.ts';
import { scoreAll } from './scorers/score-all.ts';
import { generateReport } from './report/generate.ts';

const program = new Command();

program
  .name('benchmark')
  .description('Open-source benchmark for AI sitebuilder products')
  .version('0.1.0');

program
  .command('tools')
  .description('List supported tools')
  .action(() => {
    for (const t of ALL_TOOLS) {
      console.log(t);
    }
  });

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
  if (!(ALL_TOOLS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(
      `Unknown tool "${value}". Supported: ${ALL_TOOLS.join(', ')}`,
    );
  }
  return value as ToolName;
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

program
  .command('score')
  .description('Run all scorers against a submission directory')
  .argument('<dir>', 'Submission directory (contains submission.json + prompt.json)')
  .action(async (dir: string) => {
    console.log(`Scoring ${dir}`);
    await scoreSubmission(dir, {
      onProgress: (e) => {
        if (e.kind === 'scorer_start') {
          process.stdout.write(`  ${e.name.padEnd(5)} running…`);
        } else {
          const pass = e.result.passed === null ? 'N/A' : e.result.passed ? 'yes' : 'NO ';
          const score = e.result.score === null ? '  N/A' : e.result.score.toFixed(3);
          const elapsed = formatElapsedForCli(e.elapsedMs);
          process.stdout.write(`\r  ${e.name.padEnd(5)} ${pass}   ${score}   ${elapsed}\n`);
        }
      },
    });
  });

function formatElapsedForCli(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
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

import { Command } from 'commander';
import { loadCorpus } from './prompts/schema.ts';
import { ALL_TOOLS } from './adapters/index.ts';

const program = new Command();

program
  .name('benchmark')
  .description('Open-source benchmark for AI sitebuilder products')
  .version('0.1.0');

program
  .command('prompts')
  .description('List all loadable prompts from the corpus')
  .option('-d, --dir <dir>', 'Corpus directory', 'prompts/corpus')
  .action(async (opts: { dir: string }) => {
    const prompts = await loadCorpus(opts.dir);
    for (const p of prompts) {
      console.log(`${p.id}\ttier=${p.tier}\tmust=${p.mustHave.length}\tshould=${p.shouldHave.length}\tverbatim=${p.verbatimConstraints.length}`);
    }
    console.log(`\n${prompts.length} prompt(s) loaded from ${opts.dir}`);
  });

program
  .command('tools')
  .description('List supported tools')
  .action(() => {
    for (const t of ALL_TOOLS) {
      console.log(t);
    }
  });

program
  .command('run')
  .description('Run the benchmark — not yet implemented')
  .option('-t, --tool <tool>', 'Tool to run (or "all")', 'all')
  .option('-p, --prompt <id>', 'Prompt id (or "all")', 'all')
  .option('-n, --runs <n>', 'Runs per prompt', '3')
  .action((_opts) => {
    console.error('`run` command not yet implemented — blocked on adapter implementations.');
    console.error('Use `npm run health` to verify adapter health checks.');
    process.exitCode = 1;
  });

await program.parseAsync(process.argv);

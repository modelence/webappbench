import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { artifactPaths, prepareArtifactDir, writeJson, writeManifest } from '../core/artifact.ts';
import { readSubmission } from '../core/submission.ts';
import type { Prompt } from '../core/types.ts';
import { runF1, F1_VERSION } from './functional/f1-render.ts';
import { runF2, F2_VERSION } from './functional/f2-acceptance.ts';
import { runF6, F6_VERSION } from './functional/f6-verbatim.ts';
import { runC1, C1_VERSION } from './code-quality/c1-eslint.ts';
import { runC3, C3_VERSION } from './code-quality/c3-axe.ts';
import { runC4, C4_VERSION } from './code-quality/c4-lighthouse.ts';
import { runC5, C5_VERSION } from './code-quality/c5-bundle-size.ts';
import { runC9, C9_VERSION } from './code-quality/c9-seo.ts';
import { runCost, COST_VERSION } from './cost.ts';
import type { ScorerContext, ScorerResult } from './types.ts';

const HARNESS_VERSION = '0.1.0';

export interface ScoreOutput {
  artifactDir: string;
  results: Record<string, ScorerResult>;
}

export interface ScoreOptions {
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { kind: 'scorer_start'; name: string }
  | { kind: 'scorer_done'; name: string; elapsedMs: number; result: ScorerResult };

export async function scoreSubmission(
  artifactDir: string,
  opts: ScoreOptions = {},
): Promise<ScoreOutput> {
  const submission = await readSubmission(join(artifactDir, 'submission.json'));
  const prompt = JSON.parse(await readFile(join(artifactDir, 'prompt.json'), 'utf8')) as Prompt;
  const paths = artifactPaths('artifacts', submission.tool, submission.promptId, submission.runIdx);
  if (paths.root !== artifactDir) {
    paths.root = artifactDir;
    rebasePaths(paths, artifactDir);
  }
  await prepareArtifactDir(paths);

  const headless = process.env['BENCHMARK_HEADED'] !== '1';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const sourceDir = join(artifactDir, 'source');
  const hasSource = await access(sourceDir).then(() => true).catch(() => false);
  const ctx: ScorerContext = { submission, prompt, paths, page, sourceDir: hasSource ? sourceDir : undefined };
  const results: Record<string, ScorerResult> = {};

  const runScorer = async (
    name: string,
    fn: () => Promise<ScorerResult>,
  ): Promise<ScorerResult> => {
    opts.onProgress?.({ kind: 'scorer_start', name });
    const started = Date.now();
    const result = await fn();
    const elapsedMs = Date.now() - started;
    opts.onProgress?.({ kind: 'scorer_done', name, elapsedMs, result });
    return result;
  };

  try {
    results['f1'] = await runScorer('f1', () => runF1(ctx));
    if (results['f1']?.passed) {
      results['f2'] = await runScorer('f2', () => runF2(ctx));
      await page.screenshot({ path: join(paths.screenshots, 'post-interaction.png'), fullPage: true }).catch(() => undefined);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => undefined);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(paths.screenshots, 'mid-scroll.png'), fullPage: false }).catch(() => undefined);
      results['c3'] = await runScorer('c3', () => runC3(ctx));
      results['c9'] = await runScorer('c9', () => runC9(ctx));
      results['c4'] = await runScorer('c4', () => runC4(ctx));
    } else {
      const skip: ScorerResult = {
        scorer: 'skipped',
        version: 'n/a',
        passed: null,
        score: null,
        details: { reason: 'F1 render failed — downstream scorers skipped' },
      };
      results['f2'] = { ...skip, scorer: 'f2', version: F2_VERSION };
      results['c3'] = { ...skip, scorer: 'c3', version: C3_VERSION };
      results['c4'] = { ...skip, scorer: 'c4', version: C4_VERSION };
      results['c9'] = { ...skip, scorer: 'c9', version: C9_VERSION };
    }
    results['cost'] = await runScorer('cost', () => runCost(submission, paths));

    if (hasSource) {
      results['f6'] = await runScorer('f6', () => runF6(sourceDir, ctx.prompt.verbatimConstraints));
      results['c1'] = await runScorer('c1', () => runC1(sourceDir));
      results['c5'] = await runScorer('c5', () => runC5(sourceDir));
    }
  } finally {
    await context.close();
    await browser.close();
  }

  await writeJson(paths.acceptance, results['f2']);
  await writeManifest(paths, {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    scorerVersions: {
      f1: F1_VERSION,
      f2: F2_VERSION,
      ...(hasSource && { f6: F6_VERSION }),
      ...(hasSource && { c1: C1_VERSION }),
      c3: C3_VERSION,
      c4: C4_VERSION,
      ...(hasSource && { c5: C5_VERSION }),
      c9: C9_VERSION,
      cost: COST_VERSION,
    },
    scoredAt: new Date().toISOString(),
  });

  await writeJson(join(artifactDir, 'scores.json'), results);

  return { artifactDir, results };
}

function rebasePaths(paths: ReturnType<typeof artifactPaths>, newRoot: string): void {
  paths.submission = join(newRoot, 'submission.json');
  paths.prompt = join(newRoot, 'prompt.json');
  paths.screenshots = join(newRoot, 'screenshots');
  paths.network = join(newRoot, 'network.har');
  paths.playwrightResults = join(newRoot, 'playwright_results');
  paths.axe = join(newRoot, 'axe.json');
  paths.lighthouse = join(newRoot, 'lighthouse.json');
  paths.acceptance = join(newRoot, 'acceptance.json');
  paths.seo = join(newRoot, 'seo.json');
  paths.cost = join(newRoot, 'cost.json');
  paths.manifest = join(newRoot, 'manifest.json');
}

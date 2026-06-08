import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { artifactPaths, prepareArtifactDir, writeJson, writeManifest } from '../core/artifact.ts';
import { readSubmission } from '../core/submission.ts';
import type { Prompt } from '../core/types.ts';
import { runF1, F1_VERSION } from './functional/f1-render.ts';
import { runF2, F2_VERSION } from './functional/f2-acceptance.ts';
import { attachErrorCollector, scoreF5, F5_VERSION } from './functional/f5-errors.ts';
import { runF4, F4_VERSION } from './functional/f4-judge.ts';
import { runF6, F6_VERSION } from './functional/f6-verbatim.ts';
import { runC1, C1_VERSION } from './code-quality/c1-eslint.ts';
import { runC2, C2_VERSION } from './code-quality/c2-types.ts';
import { runC3, C3_VERSION } from './code-quality/c3-axe.ts';
import { runC4, C4_VERSION } from './code-quality/c4-lighthouse.ts';
import { runC5, C5_VERSION, attachNetworkCollector, type NetworkCollector } from './code-quality/c5-bundle-size.ts';
import { runC6, C6_VERSION } from './code-quality/c6-complexity.ts';
import { runC7, C7_VERSION } from './code-quality/c7-maintainability.ts';
import { runC8, C8_VERSION } from './code-quality/c8-install.ts';
import { runS1, S1_VERSION } from './security/s1-secrets.ts';
import { runS2, S2_VERSION } from './security/s2-auth.ts';
import { runS3, S3_VERSION } from './security/s3-vuln.ts';
import { runS4, S4_VERSION } from './security/s4-backend.ts';
import { runF7, F7_VERSION } from './functional/f7-auth-roundtrip.ts';
import { runF8, F8_VERSION } from './functional/f8-cross-session.ts';
import { login, deleteAllContacts, createContact } from './backend/login.ts';
import type { Account } from '../core/backend.ts';
import { runC9, C9_VERSION } from './code-quality/c9-seo.ts';
import { runV1, V1_VERSION } from './visual/v1-judge.ts';
import { runV2, V2_VERSION } from './visual/v2-design.ts';
import { runV4, V4_VERSION } from './visual/v4-responsive.ts';
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
  const ctx: ScorerContext = { submission, prompt, paths, page, browser, sourceDir: hasSource ? sourceDir : undefined };
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

  // Attach passive collectors before any navigation so we capture everything.
  const errorCollector = attachErrorCollector(page);
  // Network collector survives only as long as F1 + page interactions; stopped
  // alongside the error collector so post-load fetches in later scorers don't
  // pollute the page-load payload number.
  let networkCollector: NetworkCollector | null = attachNetworkCollector(page);

  try {
    results['f1'] = await runScorer('f1', () => runF1(ctx));
    if (results['f1']?.passed) {
      results['f2'] = await runScorer('f2', () => runF2(ctx));
      // Score F5 here — all page events during F1+F2 have been collected.
      results['f5'] = await runScorer('f5', async () => {
        errorCollector.stop();
        networkCollector?.stop();
        return scoreF5(errorCollector);
      });
      await page.screenshot({ path: join(paths.screenshots, 'post-interaction.png'), fullPage: true }).catch(() => undefined);
      // scrolled-viewport.png: viewport-sized capture taken AFTER scrolling 800px
      // down. Used by F4/V1 to verify that elements claimed to be sticky/fixed
      // actually pin to the viewport. If a nav is sticky, it appears at the top
      // of this image; if not, it scrolls out of frame.
      await page.evaluate(() => window.scrollTo(0, 800)).catch(() => undefined);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(paths.screenshots, 'scrolled-viewport.png'), fullPage: false }).catch(() => undefined);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => undefined);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(paths.screenshots, 'mid-scroll.png'), fullPage: false }).catch(() => undefined);

      // Mobile screenshot for V1/F4 judges. V4 also captures a viewport-mobile.png
      // later via its own contexts, but V4 runs after V1/F4 — so we capture here
      // first to make sure the judges actually see a mobile view. Uses a temp
      // mobile context to avoid disturbing the main desktop page state.
      await captureMobileScreenshot(ctx.browser, ctx.submission.artifactUrl, paths.screenshots);

      // For backend-bearing apps, the logged-out screenshots above only show the
      // login screen — F4/V1 would judge the front door, not the app. Log in on
      // a fresh context and capture the authenticated dashboard so the judges see
      // the real UI. Best-effort: if login fails, judges fall back to the
      // logged-out shots (missing dashboard.png is skipped, not an error).
      if (submission.backend) {
        await captureAuthenticatedScreenshots(ctx.browser, ctx.submission.artifactUrl, submission.backend.userA, paths.screenshots);
      }

      results['c3'] = await runScorer('c3', () => runC3(ctx));
      results['c9'] = await runScorer('c9', () => runC9(ctx));
      results['f4'] = await runScorer('f4', () => runF4(ctx));
      results['v1'] = await runScorer('v1', () => runV1(ctx));
      results['v2'] = await runScorer('v2', () => runV2(ctx));
      results['v4'] = await runScorer('v4', () => runV4(ctx));
      results['c4'] = await runScorer('c4', () => runC4(ctx));
    } else {
      errorCollector.stop();
      networkCollector?.stop();
      const skip: ScorerResult = {
        scorer: 'skipped',
        version: 'n/a',
        passed: null,
        score: null,
        details: { reason: 'F1 render failed — downstream scorers skipped' },
      };
      results['f2'] = { ...skip, scorer: 'f2', version: F2_VERSION };
      results['f4'] = { ...skip, scorer: 'f4', version: F4_VERSION };
      results['f5'] = { ...skip, scorer: 'f5', version: F5_VERSION };
      results['c3'] = { ...skip, scorer: 'c3', version: C3_VERSION };
      results['v1'] = { ...skip, scorer: 'v1', version: V1_VERSION };
      results['v2'] = { ...skip, scorer: 'v2', version: V2_VERSION };
      results['v4'] = { ...skip, scorer: 'v4', version: V4_VERSION };
      results['c4'] = { ...skip, scorer: 'c4', version: C4_VERSION };
      results['c9'] = { ...skip, scorer: 'c9', version: C9_VERSION };
    }
    results['cost'] = await runScorer('cost', () => runCost(submission, paths));

    // S1 has two sub-checks (secrets + deployed headers); the header audit can run
    // without source, so S1 lives outside the hasSource gate.
    results['s1'] = await runScorer('s1', () => runS1(ctx));

    // C5 measures the gzipped network payload (always primary) and falls back
    // to uncompressed source totals when no network capture is available — so
    // it runs regardless of source ZIP, identical to S1's split signal model.
    results['c5'] = await runScorer('c5', () => runC5(ctx, { network: networkCollector }));

    if (hasSource) {
      results['f6'] = await runScorer('f6', () => runF6(sourceDir, ctx.prompt.verbatimConstraints));
      results['c1'] = await runScorer('c1', () => runC1(sourceDir));
      results['c2'] = await runScorer('c2', () => runC2(sourceDir));
      results['c6'] = await runScorer('c6', () => runC6(sourceDir));
      results['c7'] = await runScorer('c7', () => runC7(ctx));
      results['c8'] = await runScorer('c8', () => runC8(sourceDir));
      results['s2'] = await runScorer('s2', () => runS2(sourceDir));
      results['s3'] = await runScorer('s3', () => runS3(sourceDir));
    }

    // Backend track (F7/F8/S4): only when the submission carries a backend block.
    // S4 is API-only; F7/F8 drive the login form, mutating page state, so they
    // run last — after every screenshot/judge that depends on the logged-out
    // landing page has already been captured above.
    if (submission.backend) {
      results['s4'] = await runScorer('s4', () => runS4(ctx));
      results['f7'] = await runScorer('f7', () => runF7(ctx));
      results['f8'] = await runScorer('f8', () => runF8(ctx));
      // Single account cleanup, AFTER every backend scorer has run — removes all
      // test data both accounts accumulated this submission. Done once here (not
      // per-scorer) so a teardown can't wipe another scorer's in-flight data.
      await cleanupTestAccounts(ctx.browser, ctx.submission.artifactUrl, submission.backend.userA, submission.backend.userB);
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
      f4: F4_VERSION,
      f5: F5_VERSION,
      ...(hasSource && { f6: F6_VERSION }),
      ...(hasSource && { c1: C1_VERSION }),
      ...(hasSource && { c2: C2_VERSION }),
      c3: C3_VERSION,
      v1: V1_VERSION,
      v2: V2_VERSION,
      v4: V4_VERSION,
      c4: C4_VERSION,
      c5: C5_VERSION,
      ...(hasSource && { c6: C6_VERSION }),
      ...(hasSource && { c7: C7_VERSION }),
      ...(hasSource && { c8: C8_VERSION }),
      s1: S1_VERSION,
      ...(hasSource && { s2: S2_VERSION }),
      ...(hasSource && { s3: S3_VERSION }),
      ...(submission.backend && { s4: S4_VERSION }),
      ...(submission.backend && { f7: F7_VERSION }),
      ...(submission.backend && { f8: F8_VERSION }),
      c9: C9_VERSION,
      cost: COST_VERSION,
    },
    scoredAt: new Date().toISOString(),
  });

  await writeJson(join(artifactDir, 'scores.json'), results);

  return { artifactDir, results };
}

async function captureMobileScreenshot(
  browser: import('@playwright/test').Browser,
  url: string,
  screenshotsDir: string,
): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.screenshot({
      path: join(screenshotsDir, 'viewport-mobile.png'),
      fullPage: false,
    });
  } catch {
    // Best-effort — V1/F4 fall back to whatever screenshots are present.
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

// Log in as user A on a fresh context and capture the authenticated dashboard,
// so F4/V1 judge the real app rather than the login screen. Best-effort — any
// failure leaves the logged-out screenshots in place.
async function captureAuthenticatedScreenshots(
  browser: import('@playwright/test').Browser,
  url: string,
  account: Account,
  screenshotsDir: string,
): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    const outcome = await login(page, url, account);
    if (!outcome.ok) return;
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);

    // Capture the POPULATED dashboard so the judges see the real app — the list,
    // a contact row, and its delete (✕) control. We create one contact right
    // after login (the page is freshly interactive then; chaining a delete-all
    // before a create poisons the create on hydration-sensitive SPAs). The empty
    // state ("No contacts yet") is verified deterministically by F6 from source,
    // so we deliberately don't try to screenshot it here.
    await createContact(page, 'Sample Contact').catch(() => undefined);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(screenshotsDir, 'dashboard.png'), fullPage: true }).catch(() => undefined);
    // No teardown here — a single account cleanup runs at the very end of the
    // submission, so nothing deletes another scorer's in-flight test data.
  } catch {
    // best-effort
  } finally {
    await ctx.close().catch(() => undefined);
  }
  // Mobile dashboard in its own context.
  const mctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  try {
    const page = await mctx.newPage();
    const outcome = await login(page, url, account);
    if (!outcome.ok) return;
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.screenshot({ path: join(screenshotsDir, 'dashboard-mobile.png'), fullPage: false }).catch(() => undefined);
  } catch {
    // best-effort
  } finally {
    await mctx.close().catch(() => undefined);
  }
}

// Single end-of-submission cleanup: log into each test account and delete all
// its contacts, so scoring doesn't accumulate litter across runs. Best-effort,
// runs once after all scorers — never mid-scoring.
async function cleanupTestAccounts(
  browser: import('@playwright/test').Browser,
  url: string,
  ...accounts: Account[]
): Promise<void> {
  for (const account of accounts) {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const outcome = await login(page, url, account);
      if (outcome.ok) {
        await page.waitForTimeout(1500);
        await deleteAllContacts(page).catch(() => undefined);
      }
    } catch {
      // best-effort
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
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

import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C5_VERSION = '0.2.0';

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const CSS_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'public']);

// Resource types we attribute to "the page" — the gzipped bytes a real user
// would download to make the page interactive. Images, media, and font files
// are excluded because they are content, not code; the C5 budget is about
// JS/CSS payload weight.
const TRACKED_RESOURCE_TYPES = new Set(['script', 'stylesheet']);

interface ResponseRecord {
  url: string;
  resourceType: string;
  // Bytes transferred over the wire — Content-Length when available, body
  // length otherwise. When Content-Length is set on a gzipped response this
  // is the compressed size (what users actually pay for in download time).
  transferredBytes: number;
  // True when transferredBytes came from Content-Length (compressed),
  // false when we fell back to reading the response body (uncompressed).
  contentLengthAvailable: boolean;
}

export interface NetworkCollector {
  readonly responses: ResponseRecord[];
  stop: () => void;
}

// Attaches a passive listener to a page that records JS/CSS responses for
// later size accounting. Uses Content-Length when present (cheap, gzipped);
// falls back to reading the response body length only when Content-Length
// is absent (chunked transfer-encoding). Never throws — failures are
// recorded as transferredBytes: 0 with contentLengthAvailable: false.
export function attachNetworkCollector(page: Page): NetworkCollector {
  const responses: ResponseRecord[] = [];

  const onResponse = async (response: import('@playwright/test').Response): Promise<void> => {
    const resourceType = response.request().resourceType();
    if (!TRACKED_RESOURCE_TYPES.has(resourceType)) return;

    const headers = response.headers();
    const cl = headers['content-length'];
    const url = response.url().slice(0, 300);

    if (cl !== undefined) {
      const parsed = Number.parseInt(cl, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        responses.push({ url, resourceType, transferredBytes: parsed, contentLengthAvailable: true });
        return;
      }
    }

    // No Content-Length — try buffering the body. This is only safe to do
    // after the response is finished; we ignore errors silently.
    try {
      const body = await response.body();
      responses.push({ url, resourceType, transferredBytes: body.length, contentLengthAvailable: false });
    } catch {
      responses.push({ url, resourceType, transferredBytes: 0, contentLengthAvailable: false });
    }
  };

  page.on('response', onResponse);

  return {
    responses,
    stop() {
      page.off('response', onResponse);
    },
  };
}

interface FileStat {
  path: string;
  bytes: number;
}

interface SourceStats {
  jsBytes: number;
  cssBytes: number;
  jsFileCount: number;
  cssFileCount: number;
  totalSourceFiles: number;
}

export interface RunC5Options {
  network: NetworkCollector | null;
}

// C5 measures the gzipped JS/CSS payload over the wire — the metric that
// actually matters for time-to-interactive. Source-tree byte totals (when a
// ZIP is provided) are surfaced as a side-stat for diagnostics but no longer
// drive the score.
//
// Score thresholds (transferred bytes, gzipped when available):
//   ≤ 170 KB  → 1.0   (Lighthouse-aligned "lean SPA" budget)
//   ≥ 1 MB    → 0.0
//   linear decay between
//
// If neither network capture nor source ZIP is available, score is null.
export async function runC5(ctx: ScorerContext, opts: RunC5Options): Promise<ScorerResult> {
  const start = Date.now();

  const network = opts.network;
  const responses = network?.responses ?? [];
  const jsResponses = responses.filter((r) => r.resourceType === 'script');
  const cssResponses = responses.filter((r) => r.resourceType === 'stylesheet');
  const jsBytes = jsResponses.reduce((s, r) => s + r.transferredBytes, 0);
  const cssBytes = cssResponses.reduce((s, r) => s + r.transferredBytes, 0);
  const networkBytes = jsBytes + cssBytes;
  const networkAvailable = responses.length > 0;
  const allHaveContentLength = networkAvailable && responses.every((r) => r.contentLengthAvailable);

  // Source-tree side-stat (uncompressed, optional).
  const sourceStats = ctx.sourceDir ? await computeSourceStats(ctx.sourceDir) : null;

  if (!networkAvailable && !sourceStats) {
    return {
      scorer: 'c5',
      version: C5_VERSION,
      passed: null,
      score: null,
      details: {
        note: 'No network capture and no source ZIP — c5 skipped',
        elapsedMs: Date.now() - start,
      },
    };
  }

  // Score from network if available; otherwise fall back to the legacy
  // uncompressed-source heuristic so submissions without a working render
  // still get a number (clearly labelled).
  let score: number;
  let passed: boolean;
  let scoringSource: 'network' | 'source-fallback';
  let scoredBytes: number;

  if (networkAvailable) {
    scoringSource = 'network';
    scoredBytes = networkBytes;
    score = scoreFromBytes(networkBytes, 170, 1024);
    passed = networkBytes <= 350 * 1024;
  } else {
    scoringSource = 'source-fallback';
    scoredBytes = sourceStats!.jsBytes + sourceStats!.cssBytes;
    // Source bytes are uncompressed and inflated by deps; use looser thresholds
    // matching the v0.1 contract (150 KB → 1 MB).
    score = scoreFromBytes(scoredBytes, 150, 1024);
    passed = scoredBytes <= 512 * 1024;
  }

  return {
    scorer: 'c5',
    version: C5_VERSION,
    passed,
    score,
    details: {
      scoringSource,
      // Network (primary signal)
      networkAvailable,
      networkBytesTransferred: networkBytes,
      networkJsBytes: jsBytes,
      networkCssBytes: cssBytes,
      networkJsResponseCount: jsResponses.length,
      networkCssResponseCount: cssResponses.length,
      allHaveContentLength,
      // When at least one response was missing Content-Length we measured
      // its uncompressed body — flag so users know the number is mixed.
      compressedMeasurement: allHaveContentLength,
      // Source (side-stat)
      ...(sourceStats ? {
        sourceJsBytesUncompressed: sourceStats.jsBytes,
        sourceCssBytesUncompressed: sourceStats.cssBytes,
        sourceJsFileCount: sourceStats.jsFileCount,
        sourceCssFileCount: sourceStats.cssFileCount,
        sourceTotalFiles: sourceStats.totalSourceFiles,
      } : {}),
      scoredBytes,
      thresholdGoodBytes: networkAvailable ? 170 * 1024 : 150 * 1024,
      thresholdBadBytes: 1024 * 1024,
      elapsedMs: Date.now() - start,
    },
  };
}

function scoreFromBytes(bytes: number, goodKb: number, badKb: number): number {
  const KB = 1024;
  if (bytes <= goodKb * KB) return 1;
  if (bytes >= badKb * KB) return 0;
  return 1 - (bytes - goodKb * KB) / ((badKb - goodKb) * KB);
}

async function computeSourceStats(sourceDir: string): Promise<SourceStats> {
  const jsFiles: FileStat[] = [];
  const cssFiles: FileStat[] = [];
  let totalFiles = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else {
        const ext = extname(e.name).toLowerCase();
        const full = join(dir, e.name);
        const s = await stat(full).catch(() => null);
        if (!s) continue;
        totalFiles++;
        if (JS_EXTS.has(ext)) jsFiles.push({ path: full.slice(sourceDir.length + 1), bytes: s.size });
        else if (CSS_EXTS.has(ext)) cssFiles.push({ path: full.slice(sourceDir.length + 1), bytes: s.size });
      }
    }
  }
  await walk(sourceDir);

  return {
    jsBytes: jsFiles.reduce((s, f) => s + f.bytes, 0),
    cssBytes: cssFiles.reduce((s, f) => s + f.bytes, 0),
    jsFileCount: jsFiles.length,
    cssFileCount: cssFiles.length,
    totalSourceFiles: totalFiles,
  };
}

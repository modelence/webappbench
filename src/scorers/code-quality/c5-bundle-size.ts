import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import type { ScorerContext, ScorerResult } from '../types.ts';

export const C5_VERSION = '0.4.1';

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const CSS_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
// Dot-directories (.local, .replit, .config, ...) are platform/tooling
// scaffolding shipped in some exports (e.g. Replit's .local/skills templates),
// not app code — the walker skips every hidden directory, so this list only
// needs the visible ones.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'public']);

// Resource types we attribute to "the page" — the gzipped bytes a real user
// would download to make the page interactive. Images, media, and font files
// are excluded because they are content, not code; the C5 budget is about
// JS/CSS payload weight.
const TRACKED_RESOURCE_TYPES = new Set(['script', 'stylesheet']);

// How a response's transferred size was obtained, best first:
//   content-length — header value (compressed wire size, exact)
//   transfer-size  — encoded responseBodySize reported by the browser (exact)
//   gzip-estimate  — decoded body re-gzipped in-process; an approximation of
//                    the wire size for compressed responses served with
//                    chunked transfer and no Content-Length (e.g. Vercel/br)
//   decoded-body   — decoded body length; exact for uncompressed responses,
//                    inflated for compressed ones (last resort)
//   failed         — body unavailable; counted as 0 bytes
type SizeMeasurement = 'content-length' | 'transfer-size' | 'gzip-estimate' | 'decoded-body' | 'failed';

// Measurements that reflect (at least approximately) compressed wire bytes.
const COMPRESSED_MEASUREMENTS = new Set<SizeMeasurement>(['content-length', 'transfer-size', 'gzip-estimate']);

interface ResponseRecord {
  url: string;
  resourceType: string;
  // Bytes transferred over the wire (compressed when the measurement allows —
  // what users actually pay for in download time).
  transferredBytes: number;
  measurement: SizeMeasurement;
}

export interface NetworkCollector {
  readonly responses: ResponseRecord[];
  stop: () => void;
}

// Attaches a passive listener to a page that records JS/CSS responses for
// later size accounting. Uses Content-Length when present (cheap, gzipped);
// when it is absent (chunked transfer-encoding — e.g. Vercel serves brotli
// chunks with no Content-Length) it asks the browser for the encoded transfer
// size, then estimates by re-gzipping the decoded body, and only counts raw
// decoded bytes as a last resort. Never throws — failures are recorded as
// transferredBytes: 0.
export function attachNetworkCollector(page: Page): NetworkCollector {
  const responses: ResponseRecord[] = [];

  const onResponse = async (response: import('@playwright/test').Response): Promise<void> => {
    const resourceType = response.request().resourceType();
    if (!TRACKED_RESOURCE_TYPES.has(resourceType)) return;
    // blob:/data: scripts are created in-page — no bytes cross the network.
    if (!/^https?:/i.test(response.url())) return;

    const headers = response.headers();
    const cl = headers['content-length'];
    const url = response.url().slice(0, 300);

    if (cl !== undefined) {
      const parsed = Number.parseInt(cl, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        responses.push({ url, resourceType, transferredBytes: parsed, measurement: 'content-length' });
        return;
      }
    }

    // The browser knows the encoded (on-the-wire) body size even for chunked
    // responses. 0 can mean "served from cache", so only trust positive sizes.
    try {
      const sizes = await response.request().sizes();
      if (sizes.responseBodySize > 0) {
        responses.push({ url, resourceType, transferredBytes: sizes.responseBodySize, measurement: 'transfer-size' });
        return;
      }
    } catch {
      // sizes() unsupported or request failed — fall through to the body.
    }

    // Buffer the decoded body (safe once the response has finished). For
    // responses the server compressed, counting decoded bytes would inflate
    // the payload ~3-4x, so estimate the wire size by gzipping in-process.
    try {
      const body = await response.body();
      const wasCompressed = /\b(br|gzip|deflate|zstd)\b/i.test(headers['content-encoding'] ?? '');
      if (wasCompressed) {
        responses.push({ url, resourceType, transferredBytes: gzipSync(body).length, measurement: 'gzip-estimate' });
      } else {
        responses.push({ url, resourceType, transferredBytes: body.length, measurement: 'decoded-body' });
      }
    } catch {
      responses.push({ url, resourceType, transferredBytes: 0, measurement: 'failed' });
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
  const rawResponses = network?.responses ?? [];
  // The capture window spans F1's load plus F2's interactions, and an F2
  // acceptance script may reload the page — re-emitting every chunk once per
  // navigation. Cold-load page weight counts each unique resource once, so
  // dedupe by URL, keeping the largest measurement seen for it.
  const byUrl = new Map<string, ResponseRecord>();
  for (const r of rawResponses) {
    const prev = byUrl.get(r.url);
    if (!prev || r.transferredBytes > prev.transferredBytes) byUrl.set(r.url, r);
  }
  const responses = [...byUrl.values()];
  const jsResponses = responses.filter((r) => r.resourceType === 'script');
  const cssResponses = responses.filter((r) => r.resourceType === 'stylesheet');
  const jsBytes = jsResponses.reduce((s, r) => s + r.transferredBytes, 0);
  const cssBytes = cssResponses.reduce((s, r) => s + r.transferredBytes, 0);
  const networkBytes = jsBytes + cssBytes;
  const networkAvailable = responses.length > 0;
  const compressedMeasurement = networkAvailable && responses.every((r) => COMPRESSED_MEASUREMENTS.has(r.measurement));
  const measurementCounts: Record<string, number> = {};
  for (const r of responses) {
    measurementCounts[r.measurement] = (measurementCounts[r.measurement] ?? 0) + 1;
  }

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
      // Raw event count before URL dedup — a multiple of the unique count
      // indicates how many navigations the capture window saw.
      networkResponseCountRaw: rawResponses.length,
      // True when every response was measured compressed (Content-Length,
      // browser transfer size, or gzip estimate); false means at least one
      // response could only be counted at its decoded size.
      compressedMeasurement,
      measurementCounts,
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
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name));
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

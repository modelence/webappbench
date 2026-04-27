import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ScorerResult } from '../types.ts';

export const C5_VERSION = '0.1.0';

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const CSS_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'public']);

interface FileStat {
  path: string;
  bytes: number;
}

export async function runC5(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
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

  const jsBytes = jsFiles.reduce((s, f) => s + f.bytes, 0);
  const cssBytes = cssFiles.reduce((s, f) => s + f.bytes, 0);
  const totalBytes = jsBytes + cssBytes;

  // Score: full marks up to 150KB uncompressed; penalty up to 1MB; 0 above 1MB
  const KB = 1024;
  const score =
    totalBytes <= 150 * KB ? 1 :
    totalBytes >= 1024 * KB ? 0 :
    1 - (totalBytes - 150 * KB) / (874 * KB);

  return {
    scorer: 'c5',
    version: C5_VERSION,
    passed: totalBytes <= 512 * KB,
    score,
    details: {
      jsBytesUncompressed: jsBytes,
      cssBytesUncompressed: cssBytes,
      totalBytesUncompressed: totalBytes,
      jsFileCount: jsFiles.length,
      cssFileCount: cssFiles.length,
      totalSourceFiles: totalFiles,
      note: 'Uncompressed source sizes — not a build artifact. Does not account for tree-shaking or minification.',
      elapsedMs: Date.now() - start,
    },
  };
}

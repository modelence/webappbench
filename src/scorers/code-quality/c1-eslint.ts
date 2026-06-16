import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import type { ScorerResult } from '../types.ts';

export const C1_VERSION = '0.2.1';

const LINT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
// Dot-directories (.local, .replit, .config, ...) are platform/tooling
// scaffolding shipped in some exports (e.g. Replit's .local/skills templates),
// not app code — the walker skips every hidden directory, so this list only
// needs the visible ones.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);

export async function runC1(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
  const files = await collectLintableFiles(sourceDir);
  if (files.length === 0) {
    return {
      scorer: 'c1',
      version: C1_VERSION,
      passed: null,
      score: null,
      details: { note: 'No lintable files found in source', elapsedMs: Date.now() - start },
    };
  }

  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      // Use recommended rules that don't need type info — no tsc required
      ...tseslint.configs.recommended,
      {
        rules: {
          'no-console': 'warn',
          'no-debugger': 'error',
        },
      },
    ] as ESLint.Options['overrideConfig'],
  });

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalLoc = 0;
  const topOffenders: Array<{ file: string; errors: number; warnings: number }> = [];

  const results = await eslint.lintFiles(files);
  for (const r of results) {
    const errors = r.messages.filter((m) => m.severity === 2).length;
    const warnings = r.messages.filter((m) => m.severity === 1).length;
    totalErrors += errors;
    totalWarnings += warnings;
    if (errors + warnings > 0) {
      // ESLint returns absolute filePaths; sourceDir may be relative or absolute.
      // `relative` normalizes both to a clean source-relative path (the old
      // `.slice(sourceDir.length + 1)` chopped mid-string when sourceDir was
      // relative but filePath absolute, leaving mangled prefixes like "hmark/…").
      topOffenders.push({ file: relative(sourceDir, r.filePath), errors, warnings });
    }
  }
  // LOC: count non-empty lines across all source files
  await Promise.all(
    files.map(async (f) => {
      const text = await readFile(f, 'utf8').catch(() => '');
      totalLoc += text.split('\n').filter((l) => l.trim().length > 0).length;
    }),
  );

  const errorsPer1k = totalLoc > 0 ? (totalErrors / totalLoc) * 1000 : 0;
  const warnPer1k = totalLoc > 0 ? (totalWarnings / totalLoc) * 1000 : 0;
  const issuePer1k = errorsPer1k + 0.1 * warnPer1k;
  // Linear penalty: 0 issues/1k = score 1; 20+ issues/1k = score 0
  const score = Math.max(0, 1 - issuePer1k / 20);

  return {
    scorer: 'c1',
    version: C1_VERSION,
    passed: errorsPer1k === 0,
    score,
    details: {
      totalFiles: files.length,
      totalLoc,
      totalErrors,
      totalWarnings,
      errorsPer1kLoc: Number(errorsPer1k.toFixed(3)),
      warningsPer1kLoc: Number(warnPer1k.toFixed(3)),
      topOffenders: topOffenders.sort((a, b) => b.errors - a.errors).slice(0, 5),
      elapsedMs: Date.now() - start,
    },
  };
}

async function collectLintableFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(current, e.name));
      } else if (LINT_EXTS.has(extname(e.name).toLowerCase())) {
        result.push(join(current, e.name));
      }
    }
  }
  await walk(dir);
  return result;
}

import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ESLint } from 'eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import type { ScorerResult } from '../types.ts';

export const C6_VERSION = '0.1.0';

const LINT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);

// Cognitive complexity threshold per function above which it's flagged
const COMPLEXITY_THRESHOLD = 15;

export async function runC6(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
  const files = await collectFiles(sourceDir);
  if (files.length === 0) {
    return {
      scorer: 'c6',
      version: C6_VERSION,
      passed: null,
      score: null,
      details: { note: 'No lintable files found in source', elapsedMs: Date.now() - start },
    };
  }

  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        plugins: { sonarjs },
        rules: {
          'sonarjs/cognitive-complexity': ['error', COMPLEXITY_THRESHOLD],
        },
      },
    ] as ESLint.Options['overrideConfig'],
  });

  let totalViolations = 0;
  let totalLoc = 0;
  const hotspots: Array<{ file: string; line: number; complexity: number }> = [];

  const results = await eslint.lintFiles(files);
  for (const r of results) {
    for (const msg of r.messages) {
      if (msg.ruleId === 'sonarjs/cognitive-complexity') {
        totalViolations++;
        const match = msg.message.match(/(\d+)/);
        const complexity = match ? Number(match[1]) : COMPLEXITY_THRESHOLD + 1;
        hotspots.push({
          file: r.filePath.slice(sourceDir.length + 1),
          line: msg.line,
          complexity,
        });
      }
    }
  }

  await Promise.all(
    files.map(async (f) => {
      const text = await readFile(f, 'utf8').catch(() => '');
      totalLoc += text.split('\n').filter((l) => l.trim().length > 0).length;
    }),
  );

  const violationsPer1k = totalLoc > 0 ? (totalViolations / totalLoc) * 1000 : 0;
  // Linear penalty: 0 violations/1k = 1.0; 10+ violations/1k = 0
  const score = Math.max(0, 1 - violationsPer1k / 10);

  return {
    scorer: 'c6',
    version: C6_VERSION,
    passed: totalViolations === 0,
    score,
    details: {
      totalFiles: files.length,
      totalLoc,
      totalViolations,
      violationsPer1kLoc: Number(violationsPer1k.toFixed(3)),
      complexityThreshold: COMPLEXITY_THRESHOLD,
      hotspots: hotspots.sort((a, b) => b.complexity - a.complexity).slice(0, 5),
      elapsedMs: Date.now() - start,
    },
  };
}

async function collectFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(current, e.name));
      } else if (LINT_EXTS.has(extname(e.name).toLowerCase())) {
        result.push(join(current, e.name));
      }
    }
  }
  await walk(dir);
  return result;
}

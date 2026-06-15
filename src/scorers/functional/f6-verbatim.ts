import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { VerbatimConstraint } from '../../core/types.ts';
import type { ScorerResult } from '../types.ts';

export const F6_VERSION = '0.2.0';

// Extensions whose content we search for verbatim constraints
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.svg', '.json', '.md']);
// Dot-directories (.local, .replit, .config, ...) are platform/tooling
// scaffolding shipped in some exports (e.g. Replit's .local/skills templates),
// not app code — the walker skips every hidden directory, so this list only
// needs the visible ones.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);

interface F6Detail {
  value: string;
  where: string;
  type: string;
  passed: boolean;
  foundIn?: string;
}

export async function runF6(sourceDir: string, constraints: VerbatimConstraint[]): Promise<ScorerResult> {
  const start = Date.now();
  if (constraints.length === 0) {
    return {
      scorer: 'f6',
      version: F6_VERSION,
      passed: null,
      score: null,
      details: { note: 'No verbatim constraints defined for this prompt', elapsedMs: 0 },
    };
  }

  const files = await collectTextFiles(sourceDir);
  const contents = await readFilesAsMap(files, sourceDir);
  const details: F6Detail[] = [];

  for (const c of constraints) {
    const result = checkConstraint(c, contents);
    details.push(result);
  }

  const passed = details.filter((d) => d.passed).length;
  const total = details.length;
  const score = passed / total;

  return {
    scorer: 'f6',
    version: F6_VERSION,
    passed: passed === total,
    score,
    details: {
      total,
      passed,
      constraints: details,
      elapsedMs: Date.now() - start,
    },
  };
}

function checkConstraint(
  c: VerbatimConstraint,
  contents: Map<string, string>,
): F6Detail {
  const needle = buildPattern(c);
  for (const [relPath, text] of contents) {
    if (needle.test(text)) {
      return { value: c.value, where: c.where, type: c.type, passed: true, foundIn: relPath };
    }
  }
  return { value: c.value, where: c.where, type: c.type, passed: false };
}

function buildPattern(c: VerbatimConstraint): RegExp {
  switch (c.type) {
    case 'exact_copy':
      // Exact string anywhere in the source
      return new RegExp(escapeRegex(c.value));
    case 'hex_value':
      // Hex color: with or without quotes/CSS context
      return new RegExp(escapeRegex(c.value), 'i');
    case 'structural':
      // Structural keyword: appears as a CSS class, attribute value, or string
      return new RegExp(`['"\\s]${escapeRegex(c.value)}['"\\s;:{]|class[^>]*${escapeRegex(c.value)}`, 'i');
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectTextFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(current, e.name));
      } else if (TEXT_EXTS.has(extname(e.name).toLowerCase())) {
        const full = join(current, e.name);
        const s = await stat(full).catch(() => null);
        if (s && s.size < 512_000) result.push(full); // skip files >512KB
      }
    }
  }
  await walk(dir);
  return result;
}

async function readFilesAsMap(files: string[], baseDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    files.map(async (f) => {
      const text = await readFile(f, 'utf8').catch(() => null);
      if (text !== null) map.set(f.slice(baseDir.length + 1), text);
    }),
  );
  return map;
}

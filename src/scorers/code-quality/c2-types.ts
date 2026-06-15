import { execFile } from 'node:child_process';
import { readdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScorerResult } from '../types.ts';

export const C2_VERSION = '0.2.0';

const execFileAsync = promisify(execFile);

// Errors we expect when deps aren't installed — don't penalise for these.
const IGNORABLE_PATTERNS = [
  /Cannot find module/,
  /Could not find a declaration file/,
  /has no exported member/,
  /Module .* not found/,
  /Could not resolve/,
];

interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export async function runC2(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();

  let tsconfig = await findTsconfig(sourceDir);
  let syntheticTsconfig: string | null = null;
  if (!tsconfig) {
    const hasTsFiles = await containsTsFiles(sourceDir);
    if (!hasTsFiles) {
      return {
        scorer: 'c2',
        version: C2_VERSION,
        passed: null,
        score: null,
        details: { note: 'No TypeScript files found in source', elapsedMs: Date.now() - start },
      };
    }
    // No tsconfig anywhere — synthesize one in the source dir so tsc doesn't
    // walk up the filesystem and pick up an unrelated parent tsconfig (e.g.
    // the benchmark repo's own root tsconfig.json, which produces spurious
    // "Option 'bundler' can only be used when..." errors against paths far
    // outside the project under test).
    syntheticTsconfig = join(sourceDir, 'tsconfig.benchmark-synth.json');
    const synthBody = {
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        strict: false,
        allowJs: true,
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        allowImportingTsExtensions: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        isolatedModules: true,
      },
      include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
      exclude: ['node_modules', 'dist', 'build', '.next', 'out'],
    };
    await writeFile(syntheticTsconfig, JSON.stringify(synthBody, null, 2), 'utf8');
    tsconfig = syntheticTsconfig;
  }

  // Always pass --project to pin the config and prevent tsc from walking up
  // to parent directories looking for an inherited tsconfig.
  const tscArgs = ['--noEmit', '--skipLibCheck', '--project', tsconfig];

  let rawOutput = '';
  try {
    await execFileAsync('npx', ['tsc', ...tscArgs], { cwd: sourceDir, timeout: 60_000 });
  } catch (err) {
    rawOutput = (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout ?? '';
  } finally {
    if (syntheticTsconfig) {
      await unlink(syntheticTsconfig).catch(() => {});
    }
  }

  const allErrors = parseErrors(rawOutput, sourceDir);
  const realErrors = allErrors.filter((e) => !IGNORABLE_PATTERNS.some((p) => p.test(e.message)));

  const totalLoc = await countLoc(sourceDir);
  const errorsPer1k = totalLoc > 0 ? (realErrors.length / totalLoc) * 1000 : 0;
  const score = Math.max(0, 1 - errorsPer1k / 20);

  return {
    scorer: 'c2',
    version: C2_VERSION,
    passed: realErrors.length === 0,
    score,
    details: {
      totalErrors: realErrors.length,
      totalErrorsRaw: allErrors.length,
      ignoredErrors: allErrors.length - realErrors.length,
      errorsPer1kLoc: Number(errorsPer1k.toFixed(3)),
      totalLoc,
      topErrors: realErrors.slice(0, 10).map((e) => `${e.file}:${e.line} ${e.code}: ${e.message.slice(0, 80)}`),
      elapsedMs: Date.now() - start,
    },
  };
}

function parseErrors(output: string, sourceDir: string): TscError[] {
  const errors: TscError[] = [];
  const re = /^(.+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    errors.push({
      file: m[1]!.replace(sourceDir, '').replace(/^[/\\]/, ''),
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4]!,
      message: m[5]!,
    });
  }
  return errors;
}

async function findTsconfig(sourceDir: string): Promise<string | null> {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && (e.name === 'tsconfig.json' || e.name === 'tsconfig.app.json')) {
      return join(sourceDir, e.name);
    }
  }
  // One level deeper (e.g. project.zip → project/tsconfig.json)
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = await readdir(join(sourceDir, e.name)).catch(() => [] as string[]);
      if (nested.includes('tsconfig.json')) {
        return join(sourceDir, e.name, 'tsconfig.json');
      }
    }
  }
  return null;
}

async function containsTsFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) return true;
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      if (await containsTsFiles(join(dir, e.name))) return true;
    }
  }
  return false;
}

async function countLoc(dir: string): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx']);
  let total = 0;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(join(current, e.name));
      else if (e.isFile() && exts.has(e.name.slice(e.name.lastIndexOf('.')))) {
        const text = await readFile(join(current, e.name), 'utf8').catch(() => '');
        total += text.split('\n').filter((l) => l.trim()).length;
      }
    }
  }
  await walk(dir);
  return total;
}

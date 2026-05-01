import { access, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ScorerResult } from '../types.ts';

export const C8_VERSION = '0.1.0';

// Catches the AI-sitebuilder failure mode where the tool worked around dep
// conflicts locally with stale node_modules but the committed package.json
// doesn't actually install on a clean checkout.
//
// Pass = `npm ci` (or pnpm/yarn equivalent) succeeds from a clean directory
// with no workarounds. Any of these are failures: missing lockfile, peer-dep
// conflicts, missing registry packages, postinstall script crashes, timeout.

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn';

interface InstallTarget {
  packageDir: string;
  manager: PackageManager;
  hasLockfile: boolean;
}

const INSTALL_TIMEOUT_MS = 240_000;
const SKIP_COPY_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);

export async function runC8(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();

  const target = await findInstallTarget(sourceDir);
  if (!target) {
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: null,
      score: null,
      details: { note: 'No package.json found — c8 skipped', elapsedMs: Date.now() - start },
    };
  }

  if (!target.hasLockfile) {
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: false,
      score: 0,
      details: {
        note: `No lockfile present (${target.manager}); cannot install reproducibly`,
        manager: target.manager,
        packageDir: relativePath(sourceDir, target.packageDir),
        elapsedMs: Date.now() - start,
      },
    };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'benchmark-c8-'));
  const tempProjectDir = join(tempRoot, 'project');

  try {
    await cp(target.packageDir, tempProjectDir, {
      recursive: true,
      filter: (src) => !SKIP_COPY_DIRS.has(basename(src)),
    });

    const { command, args } = installCommand(target.manager);
    const result = await runCommand(command, args, tempProjectDir, INSTALL_TIMEOUT_MS);

    // Manager not on harness PATH is a harness environment issue, not a tool
    // quality issue — score null so it doesn't unfairly tank the submission.
    if (managerNotInstalled(result, target.manager)) {
      return {
        scorer: 'c8',
        version: C8_VERSION,
        passed: null,
        score: null,
        details: {
          manager: target.manager,
          packageDir: relativePath(sourceDir, target.packageDir),
          note: `${target.manager} not found on PATH — install it on the harness machine to score this submission`,
          elapsedMs: Date.now() - start,
        },
      };
    }

    const passed = result.code === 0 && !result.timedOut;
    const score = passed ? 1 : 0;

    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed,
      score,
      details: {
        manager: target.manager,
        command: `${command} ${args.join(' ')}`,
        packageDir: relativePath(sourceDir, target.packageDir),
        exitCode: result.code,
        timedOut: result.timedOut,
        ...(passed ? {} : { errorSummary: summarizeCommandFailure(result) }),
        elapsedMs: Date.now() - start,
      },
    };
  } catch (error) {
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: false,
      score: 0,
      details: {
        manager: target.manager,
        packageDir: relativePath(sourceDir, target.packageDir),
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - start,
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findInstallTarget(sourceDir: string): Promise<InstallTarget | null> {
  // Look in source root first, then one directory deep — matches S3's heuristic.
  const candidates: string[] = [sourceDir];
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_COPY_DIRS.has(entry.name)) continue;
    candidates.push(join(sourceDir, entry.name));
  }

  for (const candidate of candidates) {
    const hasPkg = await fileExists(join(candidate, 'package.json'));
    if (!hasPkg) continue;
    const manager = await detectPackageManager(candidate);
    const hasLockfile = await lockfileFor(candidate, manager);
    return { packageDir: candidate, manager, hasLockfile };
  }

  return null;
}

async function detectPackageManager(dir: string): Promise<PackageManager> {
  // pnpm-workspace.yaml is a strong pnpm signal even when the lockfile lives at
  // the workspace root (or hasn't been generated yet); pin manager to pnpm so
  // the lockfile presence check below uses pnpm-lock.yaml, not package-lock.json.
  if (await fileExists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (await fileExists(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function lockfileFor(dir: string, manager: PackageManager): Promise<boolean> {
  switch (manager) {
    case 'npm':  return fileExists(join(dir, 'package-lock.json'));
    case 'pnpm': return fileExists(join(dir, 'pnpm-lock.yaml'));
    case 'yarn': return fileExists(join(dir, 'yarn.lock'));
  }
}

function installCommand(manager: PackageManager): { command: string; args: string[] } {
  switch (manager) {
    case 'npm':
      // `npm ci` requires package-lock.json and refuses to modify it.
      return { command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--fund=false'] };
    case 'pnpm':
      return { command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] };
    case 'yarn':
      return { command: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] };
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

function relativePath(root: string, target: string): string {
  if (target === root) return '.';
  if (target.startsWith(root + '/')) return target.slice(root.length + 1);
  return target;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, { cwd });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        code: null,
        timedOut: false,
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      finish(null);
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('close', (code) => finish(code));
    proc.on('error', (error) => {
      stderr.push(Buffer.from(error.message));
      finish(null);
    });
  });
}

function summarizeCommandFailure(result: CommandResult): string {
  if (result.timedOut) return `timed out after ${INSTALL_TIMEOUT_MS / 1000}s`;
  // Prefer stderr (where npm/pnpm/yarn write actual errors) but fall back to stdout.
  const text = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, ' ');
  return (text || `exit code ${result.code ?? 'unknown'}`).slice(0, 400);
}

function managerNotInstalled(result: CommandResult, manager: PackageManager): boolean {
  // node:child_process spawn with a missing binary surfaces ENOENT in stderr
  // (and exits with null code). Match both signals to avoid false positives
  // from real install errors that happen to mention ENOENT for a missing
  // package file inside node_modules.
  if (result.code !== null) return false;
  return new RegExp(`spawn ${manager} ENOENT`).test(result.stderr);
}

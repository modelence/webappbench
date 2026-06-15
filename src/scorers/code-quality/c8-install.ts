import { access, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ScorerResult } from '../types.ts';

export const C8_VERSION = '0.3.0';

// Catches the AI-sitebuilder failure mode where the tool worked around dep
// conflicts locally with stale node_modules but the committed package.json
// doesn't actually install on a clean checkout.
//
// Pass = `npm ci` (or pnpm/yarn equivalent) succeeds from a clean directory
// with no workarounds. Any of these are failures: missing lockfile, peer-dep
// conflicts, missing registry packages, postinstall script crashes, timeout.
//
// A package dir may ship MORE THAN ONE lockfile (e.g. a stale pnpm-lock.yaml
// left over from a template scaffold alongside the npm package-lock.json the
// tool actually built with). Lockfile presence is not the same as lockfile
// correctness, so we try every present manager and pass if ANY install
// succeeds — c8's real question is "does this install reproducibly on a clean
// checkout?", and the honest answer is yes if any committed lockfile works.

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface InstallTarget {
  packageDir: string;
  // Every manager whose lockfile is present, in preference order. Empty when no
  // lockfile of any kind exists.
  managers: PackageManager[];
}

// Registry hosts that are private to a specific sitebuilder's build sandbox and
// are NOT reachable from a clean public checkout (they 401/403 without the
// vendor's internal auth). A committed lockfile that pins tarball URLs to one of
// these does not install reproducibly outside that vendor — which is a genuine
// c8 failure — but we must report WHY explicitly so it's not mistaken for a
// generic install error. Matched against any URL appearing in install output.
const PRIVATE_REGISTRY_HOST_RE = /\b([a-z0-9-]+\.)*pkg\.dev\b|\bnpm\.pkg\.github\.com\b|\b[a-z0-9-]+\.jfrog\.io\b|\bcodeartifact\.[a-z0-9-]+\.amazonaws\.com\b/i;

// Auth/permission failures from a registry fetch (the symptom of a private
// registry the public checkout can't reach).
const REGISTRY_AUTH_FAIL_RE = /\b(401|403)\b|E401|E403|\bUnauthorized\b|\bForbidden\b|authentication required|need auth/i;

// A committed lockfile that exists but no longer matches package.json — the
// frozen install refuses because the lockfile is stale. Every manager phrases
// this differently. This is a hygiene defect even when ANOTHER lockfile installs.
const LOCKFILE_OUT_OF_SYNC_RE = /OUTDATED_LOCKFILE|frozen-?lockfile|lock ?file('?s)? .*(out of date|not up to date|outdated|do(?:es)?n'?t match|does not satisfy|is not in sync|needs? (?:an? )?update)|can only install packages when your package\.json and .* are in sync|lockfile had changes, but lockfile is frozen|your lockfile needs to be updated/i;

// A committed lockfile that can't even be parsed — wrong/old binary format,
// truncated, corrupt. Distinct from out-of-sync: the file itself is unreadable.
const LOCKFILE_DAMAGED_RE = /failed to parse lockfile|invalid lockfile|corrupt(?:ed)? lockfile|unable to (?:read|parse) .*lock|Outdated lockfile version|lockfile version .* not supported|malformed/i;

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

  if (target.managers.length === 0) {
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: false,
      score: 0,
      details: {
        note: 'No lockfile present (npm/pnpm/yarn); cannot install reproducibly',
        packageDir: relativePath(sourceDir, target.packageDir),
        elapsedMs: Date.now() - start,
      },
    };
  }

  const packageDir = relativePath(sourceDir, target.packageDir);

  try {
    // Evaluate EVERY present lockfile — we don't early-return on the first clean
    // install, because lock-file HYGIENE (a stale/damaged second lockfile sitting
    // next to a working one) is itself a defect that should affect the score and
    // be reported. So we install each, classify each failure, then grade once.
    const attempts: Attempt[] = [];
    for (const manager of target.managers) {
      const result = await attemptInstall(target.packageDir, manager);

      // Manager not on harness PATH is a harness environment issue, not a tool
      // quality issue — record it as skipped so it counts neither for nor against.
      if (managerNotInstalled(result, manager)) {
        attempts.push({ manager, outcome: 'skipped', detail: `${manager} not found on PATH` });
        continue;
      }

      if (result.code === 0 && !result.timedOut) {
        attempts.push({ manager, outcome: 'pass', detail: 'install succeeded' });
        continue;
      }

      attempts.push({ manager, outcome: 'fail', detail: summarizeCommandFailure(result), ...classifyFailure(result) });
    }

    return gradeAttempts(attempts, target.managers, packageDir, start);
  } catch (error) {
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: false,
      score: 0,
      details: {
        packageDir,
        lockfilesPresent: target.managers,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - start,
      },
    };
  }
}

interface Attempt {
  manager: PackageManager;
  outcome: 'pass' | 'fail' | 'skipped';
  detail: string;
  // Why a failed attempt failed. Only one classification is set per attempt.
  failureKind?: 'out_of_sync' | 'damaged' | 'private_registry' | 'other';
  // Hosts, only for private_registry failures.
  privateRegistryHosts?: string[];
}

// Penalty weights for lock-file hygiene defects on a project that DOES install.
// A clean single-lockfile install scores 1.0; each defect deducts, floored so a
// working install never drops below half (the install itself is the main signal).
const PENALTY_DUPLICATE_LOCKFILE = 0.15; // >1 lockfile committed (extra, redundant lock state)
const PENALTY_OUT_OF_SYNC = 0.2;          // a committed lockfile is stale vs package.json
const PENALTY_DAMAGED = 0.2;              // a committed lockfile is unparseable / corrupt
const INSTALL_SCORE_FLOOR = 0.5;          // lower bound once the project installs at all

// Turn the per-lockfile attempts into a graded result with a full hygiene report.
function gradeAttempts(
  attempts: Attempt[],
  managers: PackageManager[],
  packageDir: string,
  start: number,
): ScorerResult {
  const ran = attempts.filter((a) => a.outcome !== 'skipped');
  const passed = attempts.filter((a) => a.outcome === 'pass');
  const failed = attempts.filter((a) => a.outcome === 'fail');

  // Nothing actually ran (every manager missing from PATH) — harness gap, score null.
  if (ran.length === 0) {
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: null,
      score: null,
      details: {
        packageDir,
        lockfilesPresent: managers,
        note: `none of [${managers.join(', ')}] found on PATH — install one on the harness machine to score this submission`,
        attempts,
        elapsedMs: Date.now() - start,
      },
    };
  }

  // Collect the hygiene issues we can name, regardless of overall pass/fail.
  const outOfSync = failed.filter((a) => a.failureKind === 'out_of_sync').map((a) => a.manager);
  const damaged = failed.filter((a) => a.failureKind === 'damaged').map((a) => a.manager);
  const privateRegistryHosts = [...new Set(failed.flatMap((a) => a.privateRegistryHosts ?? []))];
  const duplicateLockfiles = managers.length > 1;

  const lockfileIssues: Array<{ kind: string; manager?: PackageManager; detail: string }> = [];
  if (duplicateLockfiles) {
    lockfileIssues.push({
      kind: 'duplicate_lockfiles',
      detail: `multiple lockfiles committed (${managers.join(', ')}); a clean project ships exactly one`,
    });
  }
  for (const m of outOfSync) {
    lockfileIssues.push({ kind: 'out_of_date', manager: m, detail: `${m} lockfile is out of sync with package.json` });
  }
  for (const m of damaged) {
    lockfileIssues.push({ kind: 'damaged', manager: m, detail: `${m} lockfile is unparseable / corrupt` });
  }

  // FAIL: no lockfile installed cleanly.
  if (passed.length === 0) {
    const allPrivateRegistry = failed.length > 0 && failed.every((a) => a.failureKind === 'private_registry');
    return {
      scorer: 'c8',
      version: C8_VERSION,
      passed: false,
      score: 0,
      details: {
        packageDir,
        lockfilesPresent: managers,
        attempts,
        ...(lockfileIssues.length ? { lockfileIssues } : {}),
        ...(allPrivateRegistry
          ? {
              failureCause: 'private_registry',
              privateRegistryHosts,
              note: `committed lockfile pins packages to a private registry (${privateRegistryHosts.join(', ')}) that is unreachable from a clean public checkout — does not install reproducibly`,
            }
          : {}),
        errorSummary: failed.map((a) => `${a.manager}: ${a.detail}`).join(' | '),
        elapsedMs: Date.now() - start,
      },
    };
  }

  // PASS: at least one lockfile installed cleanly. Grade DOWN for hygiene defects.
  // A failed sibling lockfile (private-registry included) still counts as a
  // duplicate-and-broken hygiene issue, since a clean project wouldn't ship it.
  const installer = passed[0]!.manager;
  let score = 1;
  if (duplicateLockfiles) score -= PENALTY_DUPLICATE_LOCKFILE;
  score -= outOfSync.length * PENALTY_OUT_OF_SYNC;
  score -= damaged.length * PENALTY_DAMAGED;
  // A sibling that failed on a private registry is also a hygiene defect (a
  // broken extra lockfile) — treat it like an out-of-sync sibling for scoring.
  const brokenPrivate = failed.filter((a) => a.failureKind === 'private_registry').length;
  score -= brokenPrivate * PENALTY_OUT_OF_SYNC;
  if (privateRegistryHosts.length) {
    for (const m of failed.filter((a) => a.failureKind === 'private_registry').map((a) => a.manager)) {
      lockfileIssues.push({ kind: 'private_registry', manager: m, detail: `${m} lockfile pins a private registry (${privateRegistryHosts.join(', ')})` });
    }
  }
  score = Math.max(INSTALL_SCORE_FLOOR, Number(score.toFixed(2)));

  const note = lockfileIssues.length
    ? `installed via ${installer}, but lock-file hygiene issues found: ${lockfileIssues.map((i) => i.kind).join(', ')}`
    : undefined;

  return {
    scorer: 'c8',
    version: C8_VERSION,
    passed: true,
    score,
    details: {
      manager: installer,
      command: installCommandLine(installer),
      packageDir,
      exitCode: 0,
      timedOut: false,
      lockfilesPresent: managers,
      ...(lockfileIssues.length ? { lockfileIssues } : {}),
      ...(note ? { note } : {}),
      ...(managers.length > 1 || failed.length ? { attempts } : {}),
      elapsedMs: Date.now() - start,
    },
  };
}

// Copy the package dir to a clean temp directory and run the manager's install.
// Each attempt gets a FRESH copy so a partial install from a prior failed
// manager can't poison the next one. The temp dir is removed before returning.
async function attemptInstall(packageDir: string, manager: PackageManager): Promise<CommandResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'benchmark-c8-'));
  const tempProjectDir = join(tempRoot, 'project');
  try {
    await cp(packageDir, tempProjectDir, {
      recursive: true,
      filter: (src) => !SKIP_COPY_DIRS.has(basename(src)),
    });
    const { command, args } = installCommand(manager);
    return await runCommand(command, args, tempProjectDir, INSTALL_TIMEOUT_MS);
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
    const managers = await detectPackageManagers(candidate);
    return { packageDir: candidate, managers };
  }

  return null;
}

// Collect EVERY manager whose lockfile is present, in preference order. A dir
// can legitimately ship more than one (a stale template lockfile next to the
// real one); c8 tries each and passes if any installs cleanly, so we must not
// commit to a single manager up front. pnpm-workspace.yaml is a strong pnpm
// signal even without a checked-in pnpm-lock.yaml.
async function detectPackageManagers(dir: string): Promise<PackageManager[]> {
  const managers: PackageManager[] = [];
  if (await fileExists(join(dir, 'pnpm-lock.yaml'))) managers.push('pnpm');
  else if (await fileExists(join(dir, 'pnpm-workspace.yaml'))) managers.push('pnpm');
  if (await fileExists(join(dir, 'yarn.lock'))) managers.push('yarn');
  if (await fileExists(join(dir, 'package-lock.json'))) managers.push('npm');
  // bun ships either a text `bun.lock` or a binary `bun.lockb`.
  if (await fileExists(join(dir, 'bun.lock')) || await fileExists(join(dir, 'bun.lockb'))) managers.push('bun');
  return managers;
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
    case 'bun':
      // --frozen-lockfile enforces the committed lockfile (no re-resolution),
      // matching the "install reproducibly from the committed lockfile" intent.
      return { command: 'bun', args: ['install', '--frozen-lockfile', '--ignore-scripts'] };
  }
}

function installCommandLine(manager: PackageManager): string {
  const { command, args } = installCommand(manager);
  return `${command} ${args.join(' ')}`;
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

// Classify WHY a frozen install failed, so the report can name the defect
// precisely (and the grader can weight it). Order matters: private-registry is
// checked first (it's the most specific and the most actionable), then damaged
// (unparseable file), then out-of-sync (stale-but-readable lockfile), falling
// back to 'other' for genuine dependency-resolution / network / build errors.
function classifyFailure(result: CommandResult): { failureKind: Attempt['failureKind']; privateRegistryHosts?: string[] } {
  const text = `${result.stderr}\n${result.stdout}`;

  const privateRegistryHosts = detectPrivateRegistryHosts(text);
  if (privateRegistryHosts.length > 0) {
    return { failureKind: 'private_registry', privateRegistryHosts };
  }
  if (LOCKFILE_DAMAGED_RE.test(text)) return { failureKind: 'damaged' };
  if (LOCKFILE_OUT_OF_SYNC_RE.test(text)) return { failureKind: 'out_of_sync' };
  return { failureKind: 'other' };
}

// Private-registry hosts (e.g. *.pkg.dev) appearing in the output ALONGSIDE an
// auth/permission failure (401/403/Forbidden) — the symptom of a committed
// lockfile pinned to a registry the public checkout can't reach.
function detectPrivateRegistryHosts(text: string): string[] {
  if (!REGISTRY_AUTH_FAIL_RE.test(text)) return [];
  const hosts = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1];
    if (host && PRIVATE_REGISTRY_HOST_RE.test(host)) hosts.add(host);
  }
  return [...hosts];
}

function managerNotInstalled(result: CommandResult, manager: PackageManager): boolean {
  // node:child_process spawn with a missing binary surfaces ENOENT in stderr
  // (and exits with null code). Match both signals to avoid false positives
  // from real install errors that happen to mention ENOENT for a missing
  // package file inside node_modules.
  if (result.code !== null) return false;
  return new RegExp(`spawn ${manager} ENOENT`).test(result.stderr);
}

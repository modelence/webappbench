import { access, cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import type { ScorerResult } from '../types.ts';

export const C7_VERSION = '0.1.2';

interface AuditVuln {
  name: string;
  severity: string;
  via: string[];
  fixAvailable: boolean;
}

interface NpmAuditOutput {
  message?: string;
  metadata?: {
    vulnerabilities?: {
      critical?: number;
      high?: number;
      moderate?: number;
      low?: number;
      info?: number;
    };
  };
  vulnerabilities?: Record<string, {
    name: string;
    severity: string;
    via: Array<string | { title: string }>;
    fixAvailable: boolean | { name: string };
  }>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export async function runC7(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
  const auditDir = await findAuditDir(sourceDir);

  // Require package.json; without it npm audit won't run
  const pkgPath = join(auditDir, 'package.json');
  try {
    await access(pkgPath);
  } catch {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: 'No package.json found - npm audit skipped', elapsedMs: Date.now() - start },
    };
  }

  // npm audit needs a package-lock to resolve the dependency graph.
  const hasPackageLock = await access(join(auditDir, 'package-lock.json'))
    .then(() => true).catch(() => false);
  const hasYarnLock = await access(join(auditDir, 'yarn.lock'))
    .then(() => true).catch(() => false);
  const hasPnpmLock = await access(join(auditDir, 'pnpm-lock.yaml'))
    .then(() => true).catch(() => false);

  let effectiveAuditDir = auditDir;
  let tempAuditRoot: string | null = null;
  let generatedLockfile = false;

  if (!hasPackageLock) {
    const pkgText = await readFile(pkgPath, 'utf8').catch(() => '{}');
    let depCount = 0;
    try {
      const pkg = JSON.parse(pkgText) as { dependencies?: object; devDependencies?: object };
      depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    } catch { /* ignore */ }

    const prepared = await prepareGeneratedLockfileAuditDir(auditDir);
    if (!prepared.ok) {
      return {
        scorer: 'c7',
        version: C7_VERSION,
        passed: null,
        score: null,
        details: {
          note: `${lockfileLabel(hasYarnLock, hasPnpmLock)} and npm install --package-lock-only failed (${depCount} deps declared): ${prepared.error}`,
          elapsedMs: Date.now() - start,
        },
      };
    }

    effectiveAuditDir = prepared.auditDir;
    tempAuditRoot = prepared.tempRoot;
    generatedLockfile = true;
  }

  let raw: string | null;
  try {
    raw = await runNpmAudit(effectiveAuditDir);
  } finally {
    if (tempAuditRoot) await rm(tempAuditRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  if (raw === null) {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: 'npm audit failed or timed out', elapsedMs: Date.now() - start },
    };
  }

  let auditData: NpmAuditOutput;
  try {
    auditData = JSON.parse(raw) as NpmAuditOutput;
  } catch {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: 'Failed to parse npm audit output', elapsedMs: Date.now() - start },
    };
  }

  const vulnCounts = auditData.metadata?.vulnerabilities;
  if (!vulnCounts) {
    const reason = auditData.message ? `: ${auditData.message.slice(0, 120)}` : '';
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: `npm audit returned no vulnerability metadata${reason}`, elapsedMs: Date.now() - start },
    };
  }

  const critical = vulnCounts.critical ?? 0;
  const high = vulnCounts.high ?? 0;
  const moderate = vulnCounts.moderate ?? 0;
  const low = vulnCounts.low ?? 0;

  // Weighted severity score: critical=10pts, high=3pts, moderate=1pt, low=0.1pt
  const penalty = critical * 10 + high * 3 + moderate * 1 + low * 0.1;
  // Linear decay: 0 penalty = 1.0; 20+ penalty points = 0
  const score = Math.max(0, 1 - penalty / 20);
  const passed = critical === 0 && high === 0;

  const vulns: AuditVuln[] = Object.values(auditData.vulnerabilities ?? {}).map((v) => ({
    name: v.name,
    severity: v.severity,
    via: v.via.map((x) => typeof x === 'string' ? x : x.title),
    fixAvailable: !!v.fixAvailable,
  }));

  return {
    scorer: 'c7',
    version: C7_VERSION,
    passed,
    score,
    details: {
      critical,
      high,
      moderate,
      low,
      totalVulnerabilities: critical + high + moderate + low,
      auditDir: relative(sourceDir, auditDir) || '.',
      generatedLockfile,
      topVulnerabilities: vulns
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
        .slice(0, 5),
      elapsedMs: Date.now() - start,
    },
  };
}

async function prepareGeneratedLockfileAuditDir(auditDir: string): Promise<
  | { ok: true; auditDir: string; tempRoot: string }
  | { ok: false; error: string }
> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'benchmark-c7-'));
  const tempAuditDir = join(tempRoot, 'source');

  try {
    await cp(auditDir, tempAuditDir, {
      recursive: true,
      filter: (src) => !shouldSkipDir(basename(src)),
    });

    const install = await runCommand(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--fund=false'],
      tempAuditDir,
      120_000,
    );
    if (install.code !== 0 || install.timedOut) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, error: summarizeCommandFailure(install) };
    }

    return { ok: true, auditDir: tempAuditDir, tempRoot };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function findAuditDir(sourceDir: string): Promise<string> {
  const candidates = [sourceDir];
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    candidates.push(join(sourceDir, entry.name));
  }

  const packageDirs: string[] = [];
  for (const candidate of candidates) {
    const hasPackage = await access(join(candidate, 'package.json'))
      .then(() => true)
      .catch(() => false);
    if (hasPackage) packageDirs.push(candidate);
  }

  for (const dir of packageDirs) {
    if (await hasLockfile(dir)) return dir;
  }

  return packageDirs[0] ?? sourceDir;
}

async function hasLockfile(dir: string): Promise<boolean> {
  return (
    await access(join(dir, 'package-lock.json')).then(() => true).catch(() => false) ||
    await access(join(dir, 'yarn.lock')).then(() => true).catch(() => false) ||
    await access(join(dir, 'pnpm-lock.yaml')).then(() => true).catch(() => false)
  );
}

function shouldSkipDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build';
}

function lockfileLabel(hasYarnLock: boolean, hasPnpmLock: boolean): string {
  if (hasYarnLock || hasPnpmLock) return 'No package-lock.json found';
  return 'No lockfile found';
}

function severityRank(s: string): number {
  return s === 'critical' ? 4 : s === 'high' ? 3 : s === 'moderate' ? 2 : s === 'low' ? 1 : 0;
}

async function runNpmAudit(cwd: string): Promise<string | null> {
  const result = await runCommand('npm', ['audit', '--json', '--omit=dev'], cwd, 60_000);
  // npm audit exits with non-zero when vulnerabilities are found. As long as it
  // returned JSON on stdout, the caller can parse and score it.
  return result.stdout || null;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const proc = spawn(command, args, { cwd });
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

    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('close', (code) => finish(code));
    proc.on('error', (error) => {
      stderr.push(Buffer.from(error.message));
      finish(null);
    });
  });
}

function summarizeCommandFailure(result: CommandResult): string {
  if (result.timedOut) return 'timed out';
  const text = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, ' ');
  return (text || `exit code ${result.code ?? 'unknown'}`).slice(0, 240);
}

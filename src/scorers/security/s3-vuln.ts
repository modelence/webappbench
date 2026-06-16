import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import type { ScorerResult } from '../types.ts';

export const S3_VERSION = '0.1.3';

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

export async function runS3(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
  const auditDir = await findAuditDir(sourceDir);

  // Require package.json; without it npm audit won't run
  const pkgPath = join(auditDir, 'package.json');
  try {
    await access(pkgPath);
  } catch {
    return {
      scorer: 's3',
      version: S3_VERSION,
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
  let usedLegacyPeerDeps = false;
  let strippedProtocolDeps: string[] = [];

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
        scorer: 's3',
        version: S3_VERSION,
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
    usedLegacyPeerDeps = prepared.usedLegacyPeerDeps;
    strippedProtocolDeps = prepared.strippedProtocolDeps;
  }

  let raw: string | null;
  try {
    raw = await runNpmAudit(effectiveAuditDir);
  } finally {
    if (tempAuditRoot) await rm(tempAuditRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  if (raw === null) {
    return {
      scorer: 's3',
      version: S3_VERSION,
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
      scorer: 's3',
      version: S3_VERSION,
      passed: null,
      score: null,
      details: { note: 'Failed to parse npm audit output', elapsedMs: Date.now() - start },
    };
  }

  const vulnCounts = auditData.metadata?.vulnerabilities;
  if (!vulnCounts) {
    const reason = auditData.message ? `: ${auditData.message.slice(0, 120)}` : '';
    return {
      scorer: 's3',
      version: S3_VERSION,
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
    scorer: 's3',
    version: S3_VERSION,
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
      ...(usedLegacyPeerDeps ? { usedLegacyPeerDeps: true } : {}),
      ...(strippedProtocolDeps.length ? { strippedProtocolDeps } : {}),
      topVulnerabilities: vulns
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
        .slice(0, 5),
      elapsedMs: Date.now() - start,
    },
  };
}

async function prepareGeneratedLockfileAuditDir(auditDir: string): Promise<
  | { ok: true; auditDir: string; tempRoot: string; usedLegacyPeerDeps: boolean; strippedProtocolDeps: string[] }
  | { ok: false; error: string }
> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'benchmark-s3-'));
  const tempAuditDir = join(tempRoot, 'source');

  try {
    await cp(auditDir, tempAuditDir, {
      recursive: true,
      filter: (src) => !shouldSkipDir(basename(src)),
    });

    // npm can't resolve Yarn-Berry-only dependency protocols (patch:, workspace:,
    // portal:, link:). A single such entry aborts the whole `npm install
    // --package-lock-only` with EUNSUPPORTEDPROTOCOL, so no lockfile is built and
    // s3 goes N/A even though the rest of the tree is auditable. Rewrite the temp
    // package.json to drop those entries. This loses no audit signal: patch:
    // overlays a LOCAL .patch (not in any CVE DB) on top of a normal npm
    // package — the underlying name@version is still resolved and audited;
    // workspace:/portal:/link: point at LOCAL packages that have no published
    // version and no CVEs. We strip in the temp copy only — the submission's real
    // files are untouched.
    const strippedProtocolDeps = await stripYarnOnlyProtocols(join(tempAuditDir, 'package.json'));

    const baseArgs = ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--fund=false'];
    const install = await runCommand('npm', baseArgs, tempAuditDir, 120_000);
    if (install.code === 0 && !install.timedOut) {
      return { ok: true, auditDir: tempAuditDir, tempRoot, usedLegacyPeerDeps: false, strippedProtocolDeps };
    }

    // A peer-dependency conflict (ERESOLVE) is a defect in the project's
    // package.json, but it's orthogonal to s3's question ("do the declared
    // dependency VERSIONS carry known CVEs?"). The install/reproducibility
    // defect is c8's job; here we relax peer resolution so npm audit can still
    // enumerate vulnerabilities over the declared versions. We only retry when
    // the strict install failed on ERESOLVE — other failures (network, missing
    // package, timeout) are genuine and stay reported.
    if (!install.timedOut && isPeerConflict(install)) {
      const retry = await runCommand('npm', [...baseArgs, '--legacy-peer-deps'], tempAuditDir, 120_000);
      if (retry.code === 0 && !retry.timedOut) {
        return { ok: true, auditDir: tempAuditDir, tempRoot, usedLegacyPeerDeps: true, strippedProtocolDeps };
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, error: summarizeCommandFailure(retry) };
    }

    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: summarizeCommandFailure(install) };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Yarn-Berry-only dependency protocols npm cannot resolve. A version spec using
// any of these aborts `npm install --package-lock-only` with EUNSUPPORTEDPROTOCOL.
const YARN_ONLY_PROTOCOL_RE = /^(patch|workspace|portal|link|exec):/i;

// Rewrite a package.json in place, removing dependency entries whose version
// spec uses a Yarn-only protocol from dependencies / devDependencies /
// optionalDependencies / peerDependencies / resolutions / overrides. Returns the
// "<field>.<name>" keys that were dropped (for reporting). No-op (returns []) if
// the file is missing/unparseable or has no such entries — so a normal npm
// project is unaffected.
async function stripYarnOnlyProtocols(pkgPath: string): Promise<string[]> {
  const text = await readFile(pkgPath, 'utf8').catch(() => null);
  if (text === null) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }

  const depFields = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'resolutions',
    'overrides',
  ];
  const stripped: string[] = [];
  let changed = false;

  for (const field of depFields) {
    const block = pkg[field];
    if (!block || typeof block !== 'object') continue;
    const map = block as Record<string, unknown>;
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec === 'string' && YARN_ONLY_PROTOCOL_RE.test(spec)) {
        delete map[name];
        stripped.push(`${field}.${name}`);
        changed = true;
      }
    }
  }

  if (changed) {
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2)).catch(() => undefined);
  }
  return stripped;
}

// npm 7+ rejects unsatisfiable peer dependencies with ERESOLVE and tells you to
// retry with --legacy-peer-deps / --force.
function isPeerConflict(result: CommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return /ERESOLVE|legacy-peer-deps|could not resolve dependency|peer dep/i.test(text);
}

async function findAuditDir(sourceDir: string): Promise<string> {
  // Collect every package.json dir breadth-first (skipping vendor/build dirs),
  // shallowest first. Builders wrap the project at different depths: most ship
  // it at the source root, Bolt one level deep (bolt-new-main/), and Emergent
  // two levels deep under a monorepo split (emergent-<name>-main/frontend/).
  // A bounded BFS finds the audit root regardless of wrapper depth.
  const MAX_DEPTH = 4;
  const packageDirs: string[] = [];
  let queue: Array<{ dir: string; depth: number }> = [{ dir: sourceDir, depth: 0 }];

  while (queue.length > 0) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of queue) {
      const hasPackage = await access(join(dir, 'package.json'))
        .then(() => true)
        .catch(() => false);
      if (hasPackage) packageDirs.push(dir);
      if (depth >= MAX_DEPTH) continue;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkipDir(entry.name) || entry.name.startsWith('.')) continue;
        next.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
    queue = next;
  }

  // A monorepo ROOT is often just a workspace shell: it declares `workspaces`
  // and maybe a few lint/build devDeps, but the actual application — and the
  // dependencies worth auditing — live in a member package (e.g. apps/web). The
  // root usually owns the only lockfile, so a naive "shallowest dir with a
  // lockfile" pick would audit the near-empty shell and report a meaningless
  // pass. So classify each package dir and prefer one that carries a substantial
  // runtime dependency set, while still preferring a lockfile when the choice is
  // otherwise equal.
  const profiles = await Promise.all(
    packageDirs.map(async (dir) => ({
      dir,
      ...(await profilePackageDir(dir)),
      hasLock: await hasLockfile(dir),
    })),
  );

  // Candidates that look like a real app (meaningful dependency count and not a
  // pure workspace shell). Among those, prefer one with a lockfile, then the one
  // with the most dependencies (the primary app), then the shallowest.
  const realApps = profiles.filter((p) => !p.isWorkspaceShell && p.depCount >= APP_DEP_THRESHOLD);
  if (realApps.length > 0) {
    realApps.sort((a, b) =>
      Number(b.hasLock) - Number(a.hasLock) || b.depCount - a.depCount,
    );
    return realApps[0]!.dir;
  }

  // No clear app package — fall back to the original heuristic: shallowest dir
  // with a lockfile, else the shallowest package dir.
  for (const p of profiles) {
    if (p.hasLock) return p.dir;
  }

  return packageDirs[0] ?? sourceDir;
}

// A package dir needs at least this many declared deps to count as a real app
// (vs. a workspace shell whose only deps are a handful of lint/build tools).
const APP_DEP_THRESHOLD = 5;

// Read a package.json and summarize what kind of package it is.
async function profilePackageDir(dir: string): Promise<{ depCount: number; isWorkspaceShell: boolean }> {
  const text = await readFile(join(dir, 'package.json'), 'utf8').catch(() => null);
  if (text === null) return { depCount: 0, isWorkspaceShell: false };
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: object;
      devDependencies?: object;
      workspaces?: unknown;
    };
    const runtimeDeps = Object.keys(pkg.dependencies ?? {}).length;
    const allDeps = runtimeDeps + Object.keys(pkg.devDependencies ?? {}).length;
    // A workspace shell declares `workspaces` and has no runtime dependencies of
    // its own (only build/lint devDeps, or none) — the real deps live in members.
    const isWorkspaceShell = pkg.workspaces != null && runtimeDeps === 0;
    return { depCount: allDeps, isWorkspaceShell };
  } catch {
    return { depCount: 0, isWorkspaceShell: false };
  }
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

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ScorerResult } from '../types.ts';

export const C7_VERSION = '0.1.0';

interface AuditVuln {
  name: string;
  severity: string;
  via: string[];
  fixAvailable: boolean;
}

interface NpmAuditOutput {
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

export async function runC7(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();

  // Require package.json; without it npm audit won't run
  const pkgPath = join(sourceDir, 'package.json');
  try {
    await access(pkgPath);
  } catch {
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: { note: 'No package.json found — npm audit skipped', elapsedMs: Date.now() - start },
    };
  }

  // Require a lockfile — npm audit needs one to resolve the dependency graph
  const hasLock = await access(join(sourceDir, 'package-lock.json'))
    .then(() => true).catch(() => false);
  const hasYarnLock = await access(join(sourceDir, 'yarn.lock'))
    .then(() => true).catch(() => false);
  const hasPnpmLock = await access(join(sourceDir, 'pnpm-lock.yaml'))
    .then(() => true).catch(() => false);

  if (!hasLock && !hasYarnLock && !hasPnpmLock) {
    // Try to read package.json directly and check for obviously outdated deps
    const pkgText = await readFile(pkgPath, 'utf8').catch(() => '{}');
    let depCount = 0;
    try {
      const pkg = JSON.parse(pkgText) as { dependencies?: object; devDependencies?: object };
      depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    } catch { /* ignore */ }
    return {
      scorer: 'c7',
      version: C7_VERSION,
      passed: null,
      score: null,
      details: {
        note: `No lockfile found — npm audit requires a lockfile (${depCount} deps declared)`,
        elapsedMs: Date.now() - start,
      },
    };
  }

  const raw = await runNpmAudit(sourceDir);
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

  const vulnCounts = auditData.metadata?.vulnerabilities ?? {};
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
      topVulnerabilities: vulns
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
        .slice(0, 5),
      elapsedMs: Date.now() - start,
    },
  };
}

function severityRank(s: string): number {
  return s === 'critical' ? 4 : s === 'high' ? 3 : s === 'moderate' ? 2 : s === 'low' ? 1 : 0;
}

function runNpmAudit(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn('npm', ['audit', '--json', '--omit=dev'], { cwd });
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // npm audit exits with non-zero when vulnerabilities found — that's fine, we parse the JSON
    proc.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    proc.on('error', () => resolve(null));
    setTimeout(() => { proc.kill(); resolve(null); }, 60_000);
  });
}

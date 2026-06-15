import { extname, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { ScorerContext, ScorerResult } from '../types.ts';
import { runSemgrep, runTrufflehog, type ExternalFinding, type ScannerResult } from './external-scanners.ts';

export const S1_VERSION = '0.4.0';

// S1 has two sub-checks per the research design:
//  1. Hardcoded secrets in source (binary — any finding zeros this half).
//     Findings are unioned across three scanners, each independently optional:
//       a. Built-in regex (always available)
//       b. Semgrep with p/secrets + p/owasp-top-ten rulesets (if installed)
//       c. trufflehog filesystem mode for high-entropy detection (if installed)
//  2. Deployed HTTP security headers (6 standard headers, per-header points).
// Either sub-check is N/A when its input is missing (no source ZIP / no fetchable URL).
// The final score is the mean of whichever sub-checks ran.

// Dot-directories (.local, .replit, .config, ...) are platform/tooling
// scaffolding shipped in some exports (e.g. Replit's .local/skills templates),
// not app code — the walker skips every hidden directory, so this list only
// needs the visible ones.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.json', '.env', '.config', '.yaml', '.yml', '.toml', '.sh']);

// Each pattern: { id, label, regex }
// Patterns are ordered from most specific to least to reduce false positives.
const SECRET_PATTERNS = [
  { id: 'openai_key',         label: 'OpenAI API key',         regex: /sk-[a-zA-Z0-9]{20,}/ },
  { id: 'anthropic_key',      label: 'Anthropic API key',      regex: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { id: 'aws_access_key',     label: 'AWS access key ID',      regex: /AKIA[A-Z0-9]{16}/ },
  { id: 'github_pat',         label: 'GitHub personal token',  regex: /ghp_[a-zA-Z0-9]{36,}/ },
  { id: 'private_key_pem',    label: 'PEM private key',        regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'long_jwt',           label: 'Hardcoded JWT token',    regex: /eyJ[a-zA-Z0-9_-]{150,}/ },
  { id: 'hardcoded_password', label: 'Hardcoded password',     regex: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },
  { id: 'hardcoded_secret',   label: 'Hardcoded secret/token', regex: /(?:secret|token|api_key|apikey)\s*[:=]\s*["'][a-zA-Z0-9_/+=-]{20,}["']/i },
];

// Standard security headers checked on the deployed response. Each present +
// non-trivially-set header earns one point. Score = points / total.
const HEADER_CHECKS: HeaderCheck[] = [
  {
    id: 'content_security_policy',
    label: 'Content-Security-Policy',
    headers: ['content-security-policy'],
    isPresent: (v) => v.length > 0 && !/unsafe-inline.*unsafe-eval.*\*/i.test(v),
  },
  {
    id: 'strict_transport_security',
    label: 'Strict-Transport-Security',
    headers: ['strict-transport-security'],
    isPresent: (v) => /max-age=\s*\d+/i.test(v),
  },
  {
    id: 'x_content_type_options',
    label: 'X-Content-Type-Options',
    headers: ['x-content-type-options'],
    isPresent: (v) => /nosniff/i.test(v),
  },
  {
    id: 'x_frame_options',
    label: 'X-Frame-Options',
    headers: ['x-frame-options', 'content-security-policy'],
    // Either X-Frame-Options is set or CSP has frame-ancestors directive.
    isPresent: (v, all) => /^(deny|sameorigin)$/i.test(v) || /frame-ancestors\s/i.test(all['content-security-policy'] ?? ''),
  },
  {
    id: 'referrer_policy',
    label: 'Referrer-Policy',
    headers: ['referrer-policy'],
    isPresent: (v) => v.length > 0 && !/^unsafe-url$/i.test(v),
  },
  {
    id: 'permissions_policy',
    label: 'Permissions-Policy',
    headers: ['permissions-policy', 'feature-policy'],
    isPresent: (v) => v.length > 0,
  },
];

interface HeaderCheck {
  id: string;
  label: string;
  headers: string[];
  isPresent: (firstValue: string, allHeaders: Record<string, string>) => boolean;
}

// Unified shape for findings from all three scanners (regex/Semgrep/trufflehog).
// `scanner` lets details JSON/UI break down which tool fired which finding.
interface SecretFinding {
  ruleId: string;        // canonical scanner-prefixed id (e.g. "regex/openai_key")
  label: string;
  file: string;
  lineNumber: number;
  snippet: string;       // redacted — first 8 chars of matched value
  scanner: 'regex' | 'semgrep' | 'trufflehog';
}

interface HeaderOutcome {
  id: string;
  label: string;
  present: boolean;
  value: string | null;
}

export async function runS1(ctx: ScorerContext): Promise<ScorerResult> {
  const start = Date.now();

  const secrets = ctx.sourceDir ? await scanSecrets(ctx.sourceDir) : null;
  const headers = await auditHeaders(ctx.submission.artifactUrl);

  const subScores: number[] = [];
  if (secrets) subScores.push(secrets.score);
  if (headers) subScores.push(headers.score);

  if (subScores.length === 0) {
    return {
      scorer: 's1',
      version: S1_VERSION,
      passed: null,
      score: null,
      details: { note: 'No source and no fetchable URL — s1 skipped', elapsedMs: Date.now() - start },
    };
  }

  const score = subScores.reduce((a, b) => a + b, 0) / subScores.length;
  const passed = secretsPassed(secrets) && headersPassed(headers);

  return {
    scorer: 's1',
    version: S1_VERSION,
    passed,
    score,
    details: {
      secrets: secrets
        ? {
            findingsCount: secrets.findings.length,
            uniqueRuleCount: new Set(secrets.findings.map((f) => f.ruleId)).size,
            rulesSeen: [...new Set(secrets.findings.map((f) => f.ruleId))],
            findings: secrets.findings.slice(0, 20),
            filesScanned: secrets.filesScanned,
            scanners: secrets.scanners,
            score: secrets.score,
          }
        : { note: 'No source ZIP — secrets scan skipped' },
      headers: headers
        ? {
            url: headers.url,
            status: headers.status,
            outcomes: headers.outcomes,
            passedCount: headers.outcomes.filter((o) => o.present).length,
            totalCount: headers.outcomes.length,
            score: headers.score,
          }
        : { note: 'Could not fetch deployed URL — header audit skipped' },
      elapsedMs: Date.now() - start,
    },
  };
}

interface SecretsResult {
  findings: SecretFinding[];
  filesScanned: number;
  score: number;
  scanners: {
    regex: { available: true; findingCount: number };
    semgrep: ScannerStatus;
    trufflehog: ScannerStatus;
  };
}

interface ScannerStatus {
  available: boolean;
  findingCount: number;
  error?: string;
}

async function scanSecrets(sourceDir: string): Promise<SecretsResult> {
  // Run regex scan + the two external scanners in parallel. Each is
  // independent and fails closed (returns no findings on error) so a missing
  // tool or scanner crash never zeros the others' output.
  const [regexResult, semgrepResult, trufflehogResult] = await Promise.all([
    runRegexScan(sourceDir),
    runSemgrep(sourceDir),
    runTrufflehog(sourceDir),
  ]);

  // Union findings across scanners. We deliberately don't dedupe — Semgrep
  // and the regex scan often report the same leak via different rule ids,
  // and surfacing both confirms the finding rather than burying it.
  const findings: SecretFinding[] = [
    ...regexResult.findings,
    ...externalToInternal(semgrepResult.findings),
    ...externalToInternal(trufflehogResult.findings),
  ];

  return {
    findings,
    filesScanned: regexResult.filesScanned,
    score: findings.length === 0 ? 1 : 0,
    scanners: {
      regex: { available: true, findingCount: regexResult.findings.length },
      semgrep: scannerStatus(semgrepResult),
      trufflehog: scannerStatus(trufflehogResult),
    },
  };
}

interface RegexScanResult {
  findings: SecretFinding[];
  filesScanned: number;
}

async function runRegexScan(sourceDir: string): Promise<RegexScanResult> {
  const files = await collectFiles(sourceDir);
  const findings: SecretFinding[] = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (!text) continue;
    const lines = text.split('\n');
    for (const { id, label, regex } of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const match = regex.exec(line);
        if (match) {
          const full = match[0];
          findings.push({
            ruleId: `regex/${id}`,
            label,
            file: file.slice(sourceDir.length + 1),
            lineNumber: i + 1,
            snippet: `${full.slice(0, 8)}…`,
            scanner: 'regex',
          });
        }
      }
    }
  }

  return { findings, filesScanned: files.length };
}

function externalToInternal(findings: ExternalFinding[]): SecretFinding[] {
  return findings.map((f) => ({
    ruleId: f.ruleId,
    label: f.label,
    file: f.file,
    lineNumber: f.lineNumber,
    snippet: f.snippet,
    scanner: f.scanner,
  }));
}

function scannerStatus(result: ScannerResult): ScannerStatus {
  return {
    available: result.available,
    findingCount: result.findings.length,
    ...(result.error ? { error: result.error } : {}),
  };
}

interface HeadersResult {
  url: string;
  status: number | null;
  outcomes: HeaderOutcome[];
  score: number;
}

async function auditHeaders(url: string): Promise<HeadersResult | null> {
  let response: Response;
  try {
    // 10s budget — most static deploys respond well under this.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }

  // Lowercase all header names for case-insensitive lookup.
  const headerMap: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headerMap[name.toLowerCase()] = value;
  });

  const outcomes: HeaderOutcome[] = HEADER_CHECKS.map((check) => {
    const matchingHeader = check.headers.find((h) => headerMap[h] !== undefined);
    const value = matchingHeader ? headerMap[matchingHeader]! : '';
    const present = matchingHeader ? check.isPresent(value, headerMap) : false;
    return {
      id: check.id,
      label: check.label,
      present,
      value: matchingHeader ? value : null,
    };
  });

  const passed = outcomes.filter((o) => o.present).length;
  return {
    url,
    status: response.status,
    outcomes,
    score: passed / outcomes.length,
  };
}

function secretsPassed(secrets: SecretsResult | null): boolean {
  // If secrets sub-check didn't run, we can't fail on it.
  return secrets === null || secrets.findings.length === 0;
}

function headersPassed(headers: HeadersResult | null): boolean {
  // If header audit didn't run, we can't fail on it. Otherwise require ≥4/6.
  if (headers === null) return true;
  const passedCount = headers.outcomes.filter((o) => o.present).length;
  return passedCount >= 4;
}

async function collectFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(current, e.name));
      } else {
        const ext = extname(e.name).toLowerCase();
        if (TEXT_EXTS.has(ext) || e.name === '.env.local' || e.name === '.env.development') {
          const full = join(current, e.name);
          const s = await stat(full).catch(() => null);
          if (s && s.size < 1_000_000) result.push(full);
        }
      }
    }
  }
  await walk(dir);
  return result;
}

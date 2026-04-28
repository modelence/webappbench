import { spawn } from 'node:child_process';

// Wrappers around external secret-scanning tools (Semgrep + trufflehog) used
// by S1. Both tools are optional — if not installed, the wrapper returns
// `{ available: false }` and the caller proceeds with whatever scanners are
// available. We never throw on missing tools.

export interface ExternalFinding {
  // Stable id of the rule that fired (e.g. "semgrep/p/secrets/openai-api-key").
  ruleId: string;
  // Human-readable label.
  label: string;
  // Path relative to the scan root.
  file: string;
  // 1-indexed line number (or 0 if unknown).
  lineNumber: number;
  // Short snippet, truncated/redacted.
  snippet: string;
  // Source scanner (for accounting).
  scanner: 'semgrep' | 'trufflehog';
}

export interface ScannerResult {
  available: boolean;
  findings: ExternalFinding[];
  // Filled when the tool ran but emitted an error (timeout, bad JSON, etc.).
  // Distinct from `available: false` (tool not on PATH).
  error?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

// ── Semgrep ──────────────────────────────────────────────────────────────────

const SEMGREP_TIMEOUT_MS = 120_000;

interface SemgrepResult {
  results?: Array<{
    check_id: string;
    path: string;
    start?: { line?: number };
    extra?: { message?: string; lines?: string };
  }>;
}

export async function runSemgrep(sourceDir: string): Promise<ScannerResult> {
  const installed = await commandAvailable('semgrep');
  if (!installed) return { available: false, findings: [] };

  // p/secrets covers the common token formats (Stripe, AWS, Firebase, OAuth, etc.);
  // p/owasp-top-ten broadens to general code-level OWASP issues. Both ship with
  // Semgrep's CLI when registry rules are downloaded; if either is missing
  // Semgrep prints a warning to stderr but still emits valid JSON for the rules
  // it could load, so we don't fail the scorer on registry partial loads.
  const result = await runCommand(
    'semgrep',
    [
      '--config', 'p/secrets',
      '--config', 'p/owasp-top-ten',
      '--json',
      '--quiet',
      '--timeout', '60',
      '--metrics', 'off',
      sourceDir,
    ],
    SEMGREP_TIMEOUT_MS,
  );

  if (result.timedOut) {
    return { available: true, findings: [], error: 'semgrep timed out' };
  }
  // Semgrep exits 1 when findings are present; exit 0 means clean. Anything
  // other than 0 or 1 is a real failure.
  if (result.code !== 0 && result.code !== 1) {
    return {
      available: true,
      findings: [],
      error: `semgrep exit ${result.code}: ${result.stderr.slice(0, 240).trim()}`,
    };
  }

  let parsed: SemgrepResult;
  try {
    parsed = JSON.parse(result.stdout) as SemgrepResult;
  } catch (e) {
    return {
      available: true,
      findings: [],
      error: `semgrep JSON parse failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
    };
  }

  const findings: ExternalFinding[] = (parsed.results ?? []).map((r) => ({
    ruleId: `semgrep/${r.check_id}`,
    label: r.extra?.message?.split('\n')[0]?.slice(0, 120) ?? r.check_id,
    file: relativizePath(sourceDir, r.path),
    lineNumber: r.start?.line ?? 0,
    snippet: redactSnippet(r.extra?.lines ?? ''),
    scanner: 'semgrep',
  }));

  return { available: true, findings };
}

// ── trufflehog ───────────────────────────────────────────────────────────────

const TRUFFLEHOG_TIMEOUT_MS = 120_000;

interface TruffleHogFinding {
  DetectorName?: string;
  Verified?: boolean;
  Raw?: string;
  SourceMetadata?: {
    Data?: {
      Filesystem?: { file?: string; line?: number };
    };
  };
}

export async function runTrufflehog(sourceDir: string): Promise<ScannerResult> {
  const installed = await commandAvailable('trufflehog');
  if (!installed) return { available: false, findings: [] };

  // `--no-update` prevents trufflehog from contacting its update server every
  // run; `--json` emits one finding per line; `--fail` is intentionally omitted
  // so the process exits 0 when findings exist (we score them ourselves).
  const result = await runCommand(
    'trufflehog',
    ['filesystem', '--json', '--no-update', sourceDir],
    TRUFFLEHOG_TIMEOUT_MS,
  );

  if (result.timedOut) {
    return { available: true, findings: [], error: 'trufflehog timed out' };
  }
  if (result.code !== 0) {
    return {
      available: true,
      findings: [],
      error: `trufflehog exit ${result.code}: ${result.stderr.slice(0, 240).trim()}`,
    };
  }

  // trufflehog emits one JSON object per line (NDJSON). Skip blanks; warn
  // (silently in details) on un-parseable lines but don't fail the scorer.
  const findings: ExternalFinding[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: TruffleHogFinding;
    try {
      obj = JSON.parse(trimmed) as TruffleHogFinding;
    } catch {
      continue;
    }
    const detector = obj.DetectorName ?? 'unknown';
    const file = obj.SourceMetadata?.Data?.Filesystem?.file ?? '';
    const lineNumber = obj.SourceMetadata?.Data?.Filesystem?.line ?? 0;
    findings.push({
      ruleId: `trufflehog/${detector}${obj.Verified ? '/verified' : ''}`,
      label: `${detector}${obj.Verified ? ' (verified live)' : ''}`,
      file: relativizePath(sourceDir, file),
      lineNumber,
      snippet: redactSnippet(obj.Raw ?? ''),
      scanner: 'trufflehog',
    });
  }

  return { available: true, findings };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function commandAvailable(command: string): Promise<boolean> {
  // POSIX `command -v` is the portable check. Wrap in /bin/sh so PATH lookup
  // matches the user's shell environment.
  const result = await runCommand('/bin/sh', ['-c', `command -v ${command} >/dev/null 2>&1`], 5_000);
  return result.code === 0;
}

function relativizePath(root: string, abs: string): string {
  if (!abs) return '';
  if (abs === root) return '.';
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  return abs;
}

function redactSnippet(raw: string): string {
  // Show first 8 chars + ellipsis. Sufficient to identify the leak class
  // without echoing the full credential into artifact JSON.
  const trimmed = raw.trim().split('\n')[0] ?? '';
  if (trimmed.length === 0) return '';
  return trimmed.length > 8 ? `${trimmed.slice(0, 8)}…` : trimmed;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args);
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

import { extname, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { ScorerResult } from '../types.ts';

export const C8_VERSION = '0.1.0';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.json', '.env', '.config', '.yaml', '.yml', '.toml', '.sh']);

// Each pattern: { id, label, regex }
// Patterns are ordered from most specific to least to reduce false positives.
const SECRET_PATTERNS = [
  { id: 'openai_key',       label: 'OpenAI API key',          regex: /sk-[a-zA-Z0-9]{20,}/ },
  { id: 'anthropic_key',    label: 'Anthropic API key',       regex: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { id: 'aws_access_key',   label: 'AWS access key ID',       regex: /AKIA[A-Z0-9]{16}/ },
  { id: 'github_pat',       label: 'GitHub personal token',   regex: /ghp_[a-zA-Z0-9]{36,}/ },
  { id: 'private_key_pem',  label: 'PEM private key',         regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'long_jwt',         label: 'Hardcoded JWT token',     regex: /eyJ[a-zA-Z0-9_-]{150,}/ },
  { id: 'hardcoded_password', label: 'Hardcoded password',    regex: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },
  { id: 'hardcoded_secret', label: 'Hardcoded secret/token',  regex: /(?:secret|token|api_key|apikey)\s*[:=]\s*["'][a-zA-Z0-9_/+=-]{20,}["']/i },
];

interface SecretFinding {
  patternId: string;
  label: string;
  file: string;
  lineNumber: number;
  snippet: string;  // redacted — shows only first 10 chars of matched value
}

export async function runC8(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
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
            patternId: id,
            label,
            file: file.slice(sourceDir.length + 1),
            lineNumber: i + 1,
            snippet: `${full.slice(0, 8)}…`,
          });
        }
      }
    }
  }

  const uniquePatterns = new Set(findings.map((f) => f.patternId));

  return {
    scorer: 'c8',
    version: C8_VERSION,
    passed: findings.length === 0,
    score: findings.length === 0 ? 1 : 0,
    details: {
      findingsCount: findings.length,
      uniquePatternCount: uniquePatterns.size,
      patternsSeen: [...uniquePatterns],
      findings: findings.slice(0, 20),
      filesScanned: files.length,
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

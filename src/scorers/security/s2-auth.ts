import { extname, join, relative } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { ScorerResult } from '../types.ts';

export const S2_VERSION = '0.2.0';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);

// Client-side file indicators: paths whose components suggest browser execution.
// A file is "client-side" if any path segment matches one of these names.
const CLIENT_PATH_SEGMENTS = new Set([
  'src', 'app', 'pages', 'components', 'hooks', 'lib', 'utils', 'store', 'context',
  'views', 'features', 'modules', 'client', 'frontend', 'ui',
]);

// Severity weights used to compute the penalty score.
// critical = service-role key exposure, RLS disabled — immediate data breach risk.
// high = JWT decode without verification, Firebase test mode — auth bypass.
// medium = admin email hardcode, password bypass — privilege escalation.
const SEVERITY_WEIGHT: Record<string, number> = { critical: 10, high: 5, medium: 2 };

interface AuthFinding {
  patternId: string;
  label: string;
  severity: 'critical' | 'high' | 'medium';
  file: string;
  lineNumber: number;
  snippet: string;
}

interface AuthPattern {
  id: string;
  label: string;
  severity: 'critical' | 'high' | 'medium';
  // When true, only flag if the file looks like client-side code.
  clientSideOnly: boolean;
  // File extensions this pattern applies to.
  exts: Set<string>;
  match: (line: string, fileContent: string, filePath: string) => boolean;
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// Source extensions plus `.vue`, for patterns (XSS) that also apply to Vue SFCs.
const MARKUP_SOURCE_EXTS = new Set([...SOURCE_EXTS, '.vue']);
const SCHEMA_EXTS = new Set(['.sql', '.prisma', '.graphql']);
const ALL_EXTS = new Set([...SOURCE_EXTS, ...SCHEMA_EXTS, '.json', '.yaml', '.yml', '.env', '.toml', '.vue']);

const AUTH_PATTERNS: AuthPattern[] = [
  // ── Supabase ──────────────────────────────────────────────────────────────

  {
    id: 'supabase_service_role_client',
    label: 'Supabase service-role key used in client-side code',
    severity: 'critical',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    // Matches: createClient(..., process.env.SUPABASE_SERVICE_ROLE_KEY) or the literal string
    match: (line) =>
      /SUPABASE_SERVICE_ROLE_KEY/.test(line) ||
      /service_role/.test(line) && /createClient/.test(line),
  },

  {
    id: 'supabase_rls_disabled',
    label: 'Supabase table created without RLS enabled',
    severity: 'critical',
    clientSideOnly: false,
    exts: new Set(['.sql', '.ts', '.js']),
    // Matches SQL: CREATE TABLE without a following ALTER TABLE ... ENABLE ROW LEVEL SECURITY,
    // or the Supabase JS helper disableRLS() / RLS: false patterns.
    match: (line) =>
      /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(line) ||
      /\.disableRls\(\)/.test(line) ||
      /rls\s*[:=]\s*false/i.test(line),
  },

  {
    id: 'supabase_anon_key_rpc',
    label: 'Supabase anon key used to call privileged RPC/admin endpoint',
    severity: 'high',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    // Flags .rpc() calls on a client initialised without service-role — commonly
    // means the developer confused anon-key and service-role semantics.
    match: (line) =>
      /\.rpc\(\s*['"`](?:admin|delete_user|promote|set_role|update_role)/i.test(line),
  },

  // ── JWT ───────────────────────────────────────────────────────────────────

  {
    id: 'jwt_decode_no_verify',
    label: 'JWT decoded client-side without signature verification',
    severity: 'high',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    // jwt-decode (the npm package) only base64-decodes — it never verifies the signature.
    // Flag its import in client-side code; server-side use for display is acceptable.
    match: (line) =>
      /from\s+['"`]jwt-decode['"`]/.test(line) ||
      /require\(['"`]jwt-decode['"`]\)/.test(line),
  },

  {
    id: 'jwt_secret_client',
    label: 'JWT secret or signing key referenced from client-side code',
    severity: 'critical',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    match: (line) =>
      /JWT_SECRET|NEXTAUTH_SECRET|SESSION_SECRET/.test(line) &&
      !/process\.env/.test(line) === false,   // only flag literal values, not env refs
  },

  // ── Firebase ──────────────────────────────────────────────────────────────

  {
    id: 'firebase_test_mode',
    label: 'Firebase Realtime Database or Firestore rules in test/open mode',
    severity: 'high',
    clientSideOnly: false,
    exts: new Set(['.json', '.rules', '.js', '.ts']),
    // Matches the canonical Firebase "allow all" rules pattern.
    match: (line) =>
      /allow\s+read\s*,\s*write\s*:\s*if\s+true/.test(line) ||
      /allow\s+read\s*:\s*if\s+true/.test(line) ||
      /allow\s+write\s*:\s*if\s+true/.test(line) ||
      /"rules"\s*:\s*\{\s*"\.read"\s*:\s*"true"/.test(line) ||
      /"\.write"\s*:\s*"true"/.test(line),
  },

  {
    id: 'firebase_database_url_client',
    label: 'Firebase databaseURL exposed in client bundle',
    severity: 'high',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    match: (line) =>
      /databaseURL\s*:\s*['"`]https:\/\/[^'"` ]+\.firebaseio\.com/.test(line),
  },

  // ── Third-party secrets in client code ────────────────────────────────────

  {
    id: 'stripe_secret_client',
    label: 'Stripe secret key referenced from client-side code',
    severity: 'critical',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    match: (line) =>
      /STRIPE_SECRET_KEY/.test(line) ||
      /sk_live_[a-zA-Z0-9]{24,}/.test(line) ||
      /sk_test_[a-zA-Z0-9]{24,}/.test(line),
  },

  {
    id: 'openai_key_client',
    label: 'OpenAI API key referenced from client-side code',
    severity: 'critical',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    match: (line) =>
      /OPENAI_API_KEY/.test(line) ||
      /sk-[a-zA-Z0-9]{20,}/.test(line),
  },

  {
    id: 'third_party_secret_client',
    label: 'Third-party secret key referenced from client-side code',
    severity: 'critical',
    clientSideOnly: true,
    exts: SOURCE_EXTS,
    // Generic: any env var whose name contains SECRET/KEY/TOKEN used in client code.
    // Excludes framework-conventional public prefixes:
    //   - NEXT_PUBLIC_ (Next.js)
    //   - VITE_ (Vite)
    //   - EXPO_PUBLIC_ (Expo / React Native)
    //   - PUBLIC_ (SvelteKit/Astro)
    //   - REACT_APP_ (Create React App)
    //   - NUXT_PUBLIC_ (Nuxt)
    // These are intentionally exposed to the client by the bundler.
    match: (line) =>
      /process\.env\.(?!NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_)[A-Z_]*(?:SECRET|_KEY|_TOKEN)[A-Z_]*/.test(line),
  },

  // ── Auth bypass patterns ──────────────────────────────────────────────────

  {
    id: 'hardcoded_admin_email',
    label: 'Hardcoded admin email used for privilege check',
    severity: 'medium',
    clientSideOnly: false,
    exts: SOURCE_EXTS,
    match: (line) =>
      /(?:admin|role|isAdmin)\s*[=:]+\s*.*?['"`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}['"`]/.test(line),
  },

  {
    id: 'hardcoded_admin_password',
    label: 'Hardcoded admin or default password constant',
    severity: 'medium',
    clientSideOnly: false,
    exts: SOURCE_EXTS,
    match: (line) =>
      /(?:ADMIN_PASSWORD|DEFAULT_PASSWORD|ROOT_PASSWORD|MASTER_PASSWORD)\s*[:=]\s*['"`][^'"` ]{4,}['"`]/i.test(line),
  },

  {
    id: 'password_reset_no_token',
    label: 'Password reset that updates password without verifying a token',
    severity: 'high',
    clientSideOnly: false,
    exts: SOURCE_EXTS,
    // Common anti-pattern: update password using only email, skipping token verification.
    match: (line, content) => {
      if (!/updatePassword|resetPassword|changePassword/i.test(line)) return false;
      // Flag if the surrounding function doesn't mention token/otp/code verification.
      // Heuristic: find the function block (±20 lines context in full content) and check
      // for the absence of token/otp/code references near the password update call.
      const lineIdx = content.indexOf(line);
      if (lineIdx === -1) return false;
      const context = content.slice(Math.max(0, lineIdx - 500), lineIdx + 500);
      const hasTokenCheck = /(?:token|otp|code|hash|verify|resetToken)/i.test(context);
      return !hasTokenCheck;
    },
  },

  // ── Secure-by-default (P2) ──────────────────────────────────────────────────

  {
    id: 'xss_unsanitized_html',
    label: 'Unsanitized HTML injection (XSS sink) without a sanitizer',
    severity: 'high',
    clientSideOnly: true,
    exts: MARKUP_SOURCE_EXTS,
    // Flags dangerouslySetInnerHTML / .innerHTML = / Vue v-html only when no
    // sanitizer (DOMPurify, sanitize-html, xss) is imported or used in the file.
    match: (line, content) => {
      const isSink =
        /dangerouslySetInnerHTML/.test(line) ||
        /\.innerHTML\s*=/.test(line) ||
        /\sv-html\s*=/.test(line);
      if (!isSink) return false;
      // Suppress CSS injection into a <style> element. The canonical shadcn/ui
      // `<ChartStyle>` component sets dangerouslySetInnerHTML on a <style> tag to
      // emit theme CSS custom properties from code-controlled config — not a
      // markup-XSS sink. Check the nearest preceding element-open tag.
      if (/dangerouslySetInnerHTML/.test(line)) {
        const lineIdx = content.indexOf(line);
        if (lineIdx !== -1) {
          const before = content.slice(Math.max(0, lineIdx - 300), lineIdx);
          const lastTag = before.match(/<([a-zA-Z][a-zA-Z0-9]*)\b(?![^<]*<)/);
          if (lastTag && lastTag[1]?.toLowerCase() === 'style') return false;
        }
      }
      const hasSanitizer =
        /from\s+['"`](?:dompurify|isomorphic-dompurify|sanitize-html|xss)['"`]/i.test(content) ||
        /require\(['"`](?:dompurify|isomorphic-dompurify|sanitize-html|xss)['"`]\)/i.test(content) ||
        /\bDOMPurify\.sanitize\b/.test(content) ||
        /\bsanitizeHtml\b/.test(content);
      return !hasSanitizer;
    },
  },

  {
    id: 'insecure_transport',
    label: 'Insecure transport — plaintext URL or disabled TLS verification',
    severity: 'medium',
    clientSideOnly: false,
    exts: SOURCE_EXTS,
    match: (line) => {
      if (/rejectUnauthorized\s*:\s*false/.test(line)) return true;
      if (/strictSSL\s*:\s*false/.test(line)) return true;
      if (/NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"`]?0/.test(line)) return true;
      // Plaintext http:// used as a request target or base URL, excluding
      // localhost/loopback and XML namespace / schema identifiers.
      const httpUrl = /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'"` ]+['"`]/;
      if (!httpUrl.test(line)) return false;
      if (/w3\.org|schema\.org|xmlns|\.dtd|\.xsd/.test(line)) return false;
      return /\b(?:fetch|axios|baseURL|apiUrl|apiBase|endpoint|url)\b/i.test(line);
    },
  },

  {
    id: 'sensitive_data_logged',
    label: 'Sensitive data written to logs (request body, auth header, secret, or PII)',
    severity: 'medium',
    clientSideOnly: false,
    exts: SOURCE_EXTS,
    match: (line) => {
      const isLogCall = /\b(?:console\.(?:log|info|warn|error|debug)|logger\.\w+)\s*\(/.test(line);
      if (!isLogCall) return false;
      return (
        /\breq\.body\b/.test(line) ||
        /\breq\.headers\b/.test(line) ||
        /\b(?:authorization|auth_header)\b/i.test(line) ||
        /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\b/i.test(line)
      );
    },
  },
];

// Path patterns that unambiguously indicate server-only execution.
// These take priority over CLIENT_PATH_SEGMENTS — e.g. `app/api/route.ts`
// lives under `app/` but is server-side in Next.js.
const SERVER_PATH_SEGMENTS = new Set(['server', 'backend', 'api']);

function isServerSidePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  const segments = normalized.split('/');
  // Next.js / Remix file conventions.
  const basename = segments[segments.length - 1] ?? '';
  if (/^route\.(ts|tsx|js|mjs|cjs)$/.test(basename)) return true;
  if (/\.server\.(ts|tsx|js|mjs|cjs)$/.test(basename)) return true;
  // Next.js API routes — `pages/api/**` (Pages Router) and `app/**/api/**`
  // (App Router) are always server-side.
  if (/(^|\/)pages\/api\//.test(normalized)) return true;
  if (/(^|\/)app\/.*\/api\//.test(normalized) || /(^|\/)app\/api\//.test(normalized)) return true;
  // Conventional server-only directory names.
  if (segments.some((seg) => SERVER_PATH_SEGMENTS.has(seg))) return true;
  return false;
}

function isClientSidePath(filePath: string): boolean {
  if (isServerSidePath(filePath)) return false;
  const segments = filePath.toLowerCase().replace(/\\/g, '/').split('/');
  return segments.some((seg) => CLIENT_PATH_SEGMENTS.has(seg));
}

// Heuristic: a file beginning with the `'use server'` directive is server-only.
// Checked against file content rather than path so it works for App Router
// Server Actions placed inside `components/`, `lib/`, etc.
function hasUseServerDirective(text: string): boolean {
  // Match within the first ~200 chars to avoid false hits in string literals.
  const head = text.slice(0, 200);
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(head);
}

// Files importing known server-only modules can't run in the browser. This
// catches cases where the path looks client-side (e.g. `src/auth/create.js`)
// but the imports prove otherwise — common for auth/middleware glue code.
const SERVER_ONLY_IMPORTS = [
  /from\s+['"]hono(?:\/[^'"]*)?['"]/,
  /from\s+['"]next\/server['"]/,
  /from\s+['"]next\/headers['"]/,
  /from\s+['"]@auth\/core(?:\/[^'"]*)?['"]/,
  /from\s+['"]next-auth(?:\/[^'"]*)?['"]/,
  /from\s+['"]express['"]/,
  /from\s+['"]fastify['"]/,
  /from\s+['"]node:[a-z]+['"]/,
  /require\(['"]node:[a-z]+['"]\)/,
];

function importsServerOnlyModule(text: string): boolean {
  // Only scan the top of the file for imports — keeps the check cheap and
  // avoids matching strings buried in code.
  const head = text.slice(0, 4000);
  return SERVER_ONLY_IMPORTS.some((re) => re.test(head));
}

export async function runS2(sourceDir: string): Promise<ScorerResult> {
  const start = Date.now();
  const files = await collectFiles(sourceDir);
  const findings: AuthFinding[] = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase() as `.${string}`;
    const relPath = relative(sourceDir, file);

    const text = await readFile(file, 'utf8').catch(() => null);
    if (!text) continue;
    // Path-based classification, plus content-based override: any file with a
    // top-level `'use server'` directive or imports of known server-only
    // modules is server-side regardless of where it lives (Next.js Server
    // Actions and auth glue code can be co-located in client dirs).
    const isClient =
      isClientSidePath(file) &&
      !hasUseServerDirective(text) &&
      !importsServerOnlyModule(text);
    const lines = text.split('\n');

    for (const pattern of AUTH_PATTERNS) {
      if (!pattern.exts.has(ext)) continue;
      if (pattern.clientSideOnly && !isClient) continue;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (pattern.match(line, text, file)) {
          findings.push({
            patternId: pattern.id,
            label: pattern.label,
            severity: pattern.severity,
            file: relPath,
            lineNumber: i + 1,
            snippet: line.trim().slice(0, 120),
          });
          // One finding per pattern per file — avoid flooding from repeated lines.
          break;
        }
      }
    }
  }

  // Weighted penalty: sum severity weights across unique (patternId, file) findings.
  const penalty = findings.reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.severity] ?? 0), 0);
  // Linear decay to 0 at 20+ penalty points (2 critical findings = 0 score).
  const score = Math.max(0, 1 - penalty / 20);
  // Pass only if no critical or high findings.
  const passed = !findings.some((f) => f.severity === 'critical' || f.severity === 'high');

  const bySeverity = { critical: 0, high: 0, medium: 0 };
  for (const f of findings) bySeverity[f.severity]++;

  return {
    scorer: 's2',
    version: S2_VERSION,
    passed,
    score,
    details: {
      findingsCount: findings.length,
      bySeverity,
      penalty,
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
        if (ALL_EXTS.has(ext) || e.name.endsWith('.rules')) {
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

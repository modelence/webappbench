import type { ScorerResult } from './types.ts';

export function formatScorerDetail(id: string, result: ScorerResult): string {
  const d = result.details as Record<string, unknown>;
  try {
    switch (id) {
      case 'f1':
        return `HTTP ${d['httpStatus'] ?? '?'} · ${d['bodyTextLength'] ?? 0} chars`;

      case 'f2': {
        const must = `${d['mustPassed'] ?? 0}/${d['mustTotal'] ?? 0} must`;
        const should = `${d['shouldPassed'] ?? 0}/${d['shouldTotal'] ?? 0} should`;
        const failures = ((d['criteria'] as Array<Record<string, unknown>>) ?? [])
          .filter((c) => c['passed'] === false)
          .map((c) => String(c['id']))
          .slice(0, 3);
        const suffix = failures.length ? ` — failed: ${failures.join(', ')}` : '';
        return `${must} · ${should}${suffix}`;
      }

      case 'f5': {
        const total = Number(d['totalErrors'] ?? 0);
        if (total === 0) return 'no errors';
        const ce = Number(d['consoleErrorCount'] ?? 0);
        const ne = Number(d['networkErrorCount'] ?? 0);
        const parts: string[] = [];
        if (ce > 0) parts.push(`${ce} console error${ce === 1 ? '' : 's'}`);
        if (ne > 0) parts.push(`${ne} network error${ne === 1 ? '' : 's'}`);
        return parts.join(' · ');
      }

      case 'f6': {
        const passed = Number(d['passed'] ?? 0);
        const total = Number(d['total'] ?? 0);
        const failures = ((d['constraints'] as Array<Record<string, unknown>>) ?? [])
          .filter((c) => c['passed'] === false)
          .map((c) => `"${String(c['value']).slice(0, 20)}"`)
          .slice(0, 3);
        const suffix = failures.length ? ` — missing: ${failures.join(', ')}` : '';
        return `${passed}/${total} verbatim${suffix}`;
      }

      case 'v2': {
        const checks = (d['checks'] as Array<Record<string, unknown>>) ?? [];
        const scorable = checks.filter((c) => c['passed'] !== null && c['passed'] !== undefined);
        const passed = scorable.filter((c) => c['passed'] === true).length;
        const failures = scorable.filter((c) => c['passed'] === false).map((c) => String(c['name']));
        const skipped = checks.length - scorable.length;
        const suffixParts: string[] = [];
        if (failures.length) suffixParts.push(`failed: ${failures.join(', ')}`);
        if (skipped > 0) suffixParts.push(`${skipped} skipped`);
        const suffix = suffixParts.length ? ` — ${suffixParts.join(' · ')}` : '';
        return `${passed}/${scorable.length} checks${suffix}`;
      }

      case 'v1': {
        const mean = typeof d['meanRaw'] === 'number' ? d['meanRaw'] : null;
        const notes = (d['overallNotes'] ?? d['overall_notes']) as string | null;
        const note = d['note'] as string | null;
        const error = d['error'] as string | null;
        if (note) return note.slice(0, 80);
        if (error) return `error: ${error.slice(0, 80)}`;
        if (mean === null) return 'N/A';
        const pct = ((mean - 1) / 4 * 100).toFixed(0);
        const models = d['models'] as string[] | undefined;
        const modelLabel = models
          ? models.map((m) => m.split('/').pop()).join('+')
          : String(d['model'] ?? '?').split('/').pop();
        const disagreements = d['disagreements'] as string[] | undefined;
        const flagSuffix = disagreements && disagreements.length > 0 ? ` ⚑ ${disagreements.join(',')}` : '';
        const notesSuffix = notes ? ` — ${notes.slice(0, 40)}` : '';
        return `${mean.toFixed(1)}/5 (${pct}%) via ${modelLabel}${flagSuffix}${notesSuffix}`;
      }

      case 'f4': {
        const note = d['note'] as string | null;
        const error = d['error'] as string | null;
        if (note) return note.slice(0, 80);
        if (error) return `error: ${error.slice(0, 80)}`;
        const mean = typeof d['meanRaw'] === 'number' ? d['meanRaw'] : null;
        if (mean === null) return 'N/A';
        const pct = ((mean - 1) / 4 * 100).toFixed(0);
        const missing = (d['missingFeatures'] as string[] | undefined) ?? [];
        const suffix = missing.length > 0 ? ` — missing: ${missing.slice(0, 3).join(', ')}` : '';
        return `${mean.toFixed(1)}/5 (${pct}%)${suffix}`;
      }

      case 'c7': {
        const note = d['note'] as string | null;
        const error = d['error'] as string | null;
        if (note) return note.slice(0, 80);
        if (error) return `error: ${error.slice(0, 80)}`;
        const mean = typeof d['meanRaw'] === 'number' ? d['meanRaw'] : null;
        if (mean === null) return 'N/A';
        const pct = ((mean - 1) / 4 * 100).toFixed(0);
        const fileCount = Number(d['sampledFileCount'] ?? 0);
        return `${mean.toFixed(1)}/5 (${pct}%) · ${fileCount} files sampled`;
      }

      case 'v4': {
        const passing = Number(d['passingChecks'] ?? 0);
        const total = Number(d['totalChecks'] ?? 0);
        const checks = (d['checks'] as Array<Record<string, unknown>>) ?? [];
        const failures = checks.filter((c) => c['pass'] === false).map((c) => String(c['name']));
        const suffix = failures.length ? ` — failed: ${failures.join(', ')}` : '';
        return `${passing}/${total} checks${suffix}`;
      }

      case 'c2': {
        const errors = Number(d['totalErrors'] ?? 0);
        const loc = Number(d['totalLoc'] ?? 0);
        const per1k = (d['errorsPer1kLoc'] as number | undefined) ?? 0;
        if (errors === 0) return `no type errors (${loc} LOC)`;
        return `${errors} type error${errors === 1 ? '' : 's'} / ${loc} LOC (${per1k.toFixed(1)}/1k)`;
      }

      case 'c6': {
        if (d['note']) return String(d['note']).slice(0, 60);
        const v = Number(d['totalViolations'] ?? 0);
        const per1k = (d['violationsPer1kLoc'] as number | undefined) ?? 0;
        if (v === 0) return 'no complex functions';
        const hotspots = (d['hotspots'] as Array<Record<string, unknown>>) ?? [];
        const top = hotspots[0];
        const suffix = top ? ` — worst: ${String(top['file']).split('/').pop()}:${top['line']} (${top['complexity']})` : '';
        return `${v} violation${v === 1 ? '' : 's'} (${per1k.toFixed(1)}/1k)${suffix}`;
      }

      case 's1': {
        if (d['note']) return String(d['note']).slice(0, 60);
        const secrets = d['secrets'] as Record<string, unknown> | undefined;
        const headers = d['headers'] as Record<string, unknown> | undefined;
        const parts: string[] = [];
        if (secrets && !secrets['note']) {
          const count = Number(secrets['findingsCount'] ?? 0);
          const scanners = secrets['scanners'] as Record<string, Record<string, unknown>> | undefined;
          // Show which external scanners actually contributed (regex always runs).
          const ranScanners = scanners
            ? Object.entries(scanners)
                .filter(([name, s]) => name !== 'regex' && s['available'])
                .map(([name]) => name)
            : [];
          const scannerSuffix = ranScanners.length ? ` (+${ranScanners.join(',')})` : '';
          if (count === 0) {
            parts.push(`no secrets${scannerSuffix}`);
          } else {
            const rules = (secrets['rulesSeen'] as string[] | undefined) ?? [];
            // Trim long rule ids for terminal output.
            const compactRules = rules.slice(0, 3).map((r) => r.split('/').pop() ?? r);
            const more = rules.length > 3 ? ` +${rules.length - 3} more` : '';
            parts.push(`${count} secret${count === 1 ? '' : 's'}${scannerSuffix}: ${compactRules.join(', ')}${more}`);
          }
        }
        if (headers && !headers['note']) {
          const passed = Number(headers['passedCount'] ?? 0);
          const total = Number(headers['totalCount'] ?? 0);
          const outcomes = (headers['outcomes'] as Array<Record<string, unknown>>) ?? [];
          const missing = outcomes.filter((o) => !o['present']).map((o) => String(o['id'])).slice(0, 3);
          const suffix = missing.length ? ` — missing: ${missing.join(', ')}` : '';
          parts.push(`${passed}/${total} headers${suffix}`);
        }
        return parts.join(' · ') || 'N/A';
      }

      case 's2': {
        if (d['note']) return String(d['note']).slice(0, 60);
        const count = Number(d['findingsCount'] ?? 0);
        if (count === 0) return 'no auth issues found';
        const by = d['bySeverity'] as Record<string, number> | undefined;
        const parts: string[] = [];
        if (by?.['critical']) parts.push(`${by['critical']} critical`);
        if (by?.['high']) parts.push(`${by['high']} high`);
        if (by?.['medium']) parts.push(`${by['medium']} medium`);
        return parts.join(', ');
      }

      case 's3': {
        if (d['note']) return String(d['note']).slice(0, 60);
        const critical = Number(d['critical'] ?? 0);
        const high = Number(d['high'] ?? 0);
        const moderate = Number(d['moderate'] ?? 0);
        const low = Number(d['low'] ?? 0);
        const total = critical + high + moderate + low;
        if (total === 0) return 'no vulnerabilities';
        const parts: string[] = [];
        if (critical > 0) parts.push(`${critical} critical`);
        if (high > 0) parts.push(`${high} high`);
        if (moderate > 0) parts.push(`${moderate} moderate`);
        if (low > 0) parts.push(`${low} low`);
        return parts.join(', ');
      }

      case 's4': {
        if (d['note']) return String(d['note']).slice(0, 60);
        if (d['crossTenantLeak']) return 'CROSS-TENANT LEAK — user A read user B data';
        const run = Number(d['probesRun'] ?? 0);
        const failed = Number(d['failedCount'] ?? 0);
        if (run === 0) return 'no probes run';
        return failed === 0 ? `${run} probe${run === 1 ? '' : 's'} passed` : `${failed}/${run} probes failed`;
      }

      case 'f7': {
        if (d['note'] && d['passed'] === null) return String(d['note']).slice(0, 60);
        const passedSteps = Number(d['passedSteps'] ?? 0);
        const totalSteps = Number(d['totalSteps'] ?? 0);
        return `${passedSteps}/${totalSteps} round-trip steps`;
      }

      case 'f8': {
        if (d['note'] && d['passed'] === null) return String(d['note']).slice(0, 60);
        return d['crossedSessions'] ? 'record crossed sessions (real backend)' : 'record did not persist across sessions';
      }

      case 'c1': {
        const errors = Number(d['totalErrors'] ?? 0);
        const warns = Number(d['totalWarnings'] ?? 0);
        const loc = Number(d['totalLoc'] ?? 0);
        const ePer = (d['errorsPer1kLoc'] as number | undefined) ?? 0;
        return `${errors}e ${warns}w / ${loc} LOC (${ePer.toFixed(1)}/1k)`;
      }

      case 'c3': {
        const v = Number(d['violationsCount'] ?? 0);
        if (v === 0) return 'no violations';
        const impact = d['impactCounts'] as Record<string, number> | undefined;
        const parts = Object.entries(impact ?? {}).map(([k, n]) => `${n} ${k}`);
        return `${v} violation${v === 1 ? '' : 's'}: ${parts.join(', ')}`;
      }

      case 'c4': {
        if (d['note']) return String(d['note']).slice(0, 80);
        const p = fmt(d['perfScore']);
        const a = fmt(d['a11yScore']);
        const b = fmt(d['bestPracticesScore']);
        const s = fmt(d['seoScore']);
        const m = d['metrics'] as Record<string, number | null> | undefined;
        const lcp = m?.['lcpMs'] != null ? ` LCP=${(m['lcpMs']! / 1000).toFixed(1)}s` : '';
        const successful = Number(d['successfulRuns'] ?? 0);
        const total = Number(d['runs'] ?? 0);
        // Only show run-count when not all runs succeeded — otherwise it's noise.
        const runSuffix = successful > 0 && successful < total ? ` (${successful}/${total} runs ok)` : '';
        return `perf=${p} a11y=${a} bp=${b} seo=${s}${lcp}${runSuffix}`;
      }

      case 'c5': {
        if (d['note']) return String(d['note']).slice(0, 60);
        const source = String(d['scoringSource'] ?? '');
        if (source === 'network') {
          const bytes = Number(d['networkBytesTransferred'] ?? 0);
          const js = Number(d['networkJsResponseCount'] ?? 0);
          const css = Number(d['networkCssResponseCount'] ?? 0);
          const compressed = d['compressedMeasurement'] === true;
          const label = compressed ? 'gzipped' : 'transferred';
          return `${(bytes / 1024).toFixed(0)}KB ${label} · ${js} JS, ${css} CSS`;
        }
        // source-fallback: uncompressed source-tree byte total
        const bytes = Number(d['scoredBytes'] ?? 0);
        const js = Number(d['sourceJsFileCount'] ?? 0);
        return `${(bytes / 1024).toFixed(0)}KB source (no network) · ${js} JS files`;
      }

      case 'c8': {
        const issues = d['lockfileIssues'] as Array<{ kind: string }> | undefined;
        const issueKinds = issues?.length ? [...new Set(issues.map((i) => i.kind))].join(', ') : '';
        // Pass path: `exitCode === 0` means a lockfile installed cleanly. Append
        // any lock-file hygiene defects that docked the score.
        if (d['exitCode'] === 0 && !d['timedOut']) {
          const mgr = String(d['manager'] ?? '?');
          return issueKinds ? `${mgr} install ok — lockfile issues: ${issueKinds}` : `${mgr} install ok`;
        }
        // "No lockfile" / "not on PATH" notes have no manager to name.
        if (d['note'] && d['lockfilesPresent'] === undefined) return String(d['note']).slice(0, 60);
        // Fail path: one or more managers were tried and none installed. Name
        // which lockfiles were present so a stale-extra-lockfile failure reads
        // clearly (e.g. "pnpm,npm install failed — pnpm: ...").
        const present = (d['lockfilesPresent'] as string[] | undefined)?.join(',') ?? String(d['manager'] ?? '?');
        // Private-registry lock-in gets its own clear summary line.
        if (d['failureCause'] === 'private_registry') {
          const hosts = (d['privateRegistryHosts'] as string[] | undefined)?.join(', ') ?? 'private registry';
          return `${present} install failed — private registry (${hosts})`;
        }
        const errSuffix = issueKinds ? ` — ${issueKinds}` : (d['errorSummary'] ? ` — ${String(d['errorSummary']).slice(0, 60)}` : '');
        return `${present} install failed${errSuffix}`;
      }

      case 'c9': {
        const passedCount = Number(d['passedCount'] ?? 0);
        const total = Number(d['applicableCount'] ?? 0);
        const failures = ((d['outcomes'] as Array<Record<string, unknown>>) ?? [])
          .filter((o) => o['passed'] === false)
          .map((o) => String(o['check']))
          .slice(0, 4);
        const suffix = failures.length ? ` — failed: ${failures.join(', ')}` : '';
        return `${passedCount}/${total} checks${suffix}`;
      }

      case 'cost': {
        const ttfr = d['ttfrMs'] as number | null;
        const ttwb = d['ttwbMs'] as number | null;
        const usd = d['cost'] as number | null;
        if (ttfr == null && ttwb == null && usd == null) return 'no data';
        const parts: string[] = [];
        if (ttfr != null) parts.push(`TTFR ${(ttfr / 1000).toFixed(1)}s`);
        if (ttwb != null) parts.push(`TTWB ${(ttwb / 1000).toFixed(1)}s`);
        if (usd != null) parts.push(`$${usd.toFixed(2)}`);
        return parts.join(' · ');
      }

      default:
        return d['note'] ? String(d['note']).slice(0, 50) : '';
    }
  } catch {
    return '';
  }
}

function fmt(val: unknown): string {
  if (typeof val !== 'number') return '?';
  return (val * 100).toFixed(0);
}

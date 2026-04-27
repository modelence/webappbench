import { formatScorerDetail } from './format.ts';
import type { ProgressEvent } from './orchestrate.ts';
import type { ScorerResult } from './types.ts';

const ORDER = ['f1', 'f2', 'f5', 'f6', 'v1', 'v2', 'v4', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'cost'];

interface Completed {
  name: string;
  elapsedMs: number;
  result: ScorerResult;
}

/**
 * Returns an onProgress handler that:
 * - Shows a live "running…" spinner for the active scorer
 * - Buffers completed results
 * - After each completion, flushes any newly printable results in canonical order
 */
export function makeProgressHandler(): {
  onProgress: (e: ProgressEvent) => void;
  flush: () => void;
} {
  const completed = new Map<string, Completed>();
  let nextFlushIdx = 0;     // index into ORDER of the next line to print
  let spinnerName = '';     // currently displayed "running…" line

  function clearSpinner() {
    if (spinnerName) {
      process.stdout.write(`\r${' '.repeat(spinnerName.length + 16)}\r`);
      spinnerName = '';
    }
  }

  function printLine(c: Completed) {
    const pass = c.result.passed === null ? 'N/A' : c.result.passed ? 'yes' : 'NO ';
    const score = c.result.score === null ? '  N/A' : (c.result.score * 100).toFixed(1).padStart(5);
    const elapsed = formatElapsed(c.elapsedMs);
    const detail = formatScorerDetail(c.name, c.result);
    const suffix = detail ? `   ${detail}` : '';
    process.stdout.write(`  ${c.name.padEnd(5)} ${pass}   ${score}   ${elapsed.padEnd(6)}${suffix}\n`);
  }

  function tryFlush() {
    // Print all consecutive completed scorers from nextFlushIdx onward.
    while (nextFlushIdx < ORDER.length) {
      const id = ORDER[nextFlushIdx]!;
      const c = completed.get(id);
      if (!c) break;
      clearSpinner();
      printLine(c);
      nextFlushIdx++;
    }
    // Reprint spinner if there's still an active one waiting.
    if (spinnerName) {
      process.stdout.write(`  ${spinnerName.padEnd(5)} running…`);
    }
  }

  function onProgress(e: ProgressEvent) {
    if (e.kind === 'scorer_start') {
      clearSpinner();
      spinnerName = e.name;
      process.stdout.write(`  ${e.name.padEnd(5)} running…`);
    } else {
      if (spinnerName === e.name) {
        // Overwrite the spinner line if it's the same scorer finishing.
        process.stdout.write('\r' + ' '.repeat(spinnerName.length + 16) + '\r');
        spinnerName = '';
      }
      completed.set(e.name, { name: e.name, elapsedMs: e.elapsedMs, result: e.result });
      tryFlush();
    }
  }

  // Call after scoreSubmission resolves to print any scorers not in ORDER.
  function flush() {
    clearSpinner();
    for (const [name, c] of completed) {
      if (!ORDER.includes(name)) printLine(c);
    }
  }

  return { onProgress, flush };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

import { formatScorerDetail } from './format.ts';
import type { ProgressEvent } from './orchestrate.ts';
import type { ScorerResult } from './types.ts';

// Display order, grouped by dimension. Independent of execution order in
// orchestrate.ts (which is dependency-driven: F1 gate, then page-state scorers,
// then F7/F8/S4 last because they log in and mutate the page). The flush handler
// buffers completed results and prints them in this order regardless of when
// each finished.
const ORDER = [
  'f1', 'f2', 'f4', 'f5', 'f6', 'f7', 'f8',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9',
  'v1', 'v2', 'v4',
  's1', 's2', 's3', 's4',
  'cost',
];

interface Completed {
  name: string;
  elapsedMs: number;
  result: ScorerResult;
}

const ORDER_INDEX = new Map(ORDER.map((id, i) => [id, i]));
const BAR_WIDTH = 24;

/**
 * Returns an onProgress handler that:
 * - Renders a single in-place progress bar while scorers run (so the live view
 *   doesn't depend on — or expose — execution order)
 * - Buffers all results, then prints them once in display order on flush()
 */
export function makeProgressHandler(): {
  onProgress: (e: ProgressEvent) => void;
  flush: () => void;
} {
  const completed = new Map<string, Completed>();
  let running = '';
  let lastBarLen = 0;
  // Total is unknown upfront (depends on source ZIP / backend block), so we
  // estimate against ORDER and let the count catch up if more arrive.
  const estimatedTotal = ORDER.length;

  const isTTY = Boolean(process.stdout.isTTY);

  function renderBar() {
    if (!isTTY) return; // in non-TTY (CI, piped) skip the live bar; results print on flush
    const done = completed.size;
    const total = Math.max(estimatedTotal, done);
    const filled = Math.round((done / total) * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const label = running ? ` · running ${running}` : '';
    const line = `  [${bar}] ${done}/${total}${label}`;
    process.stdout.write(`\r${line}${' '.repeat(Math.max(0, lastBarLen - line.length))}`);
    lastBarLen = line.length;
  }

  function clearBar() {
    if (!isTTY) return;
    if (lastBarLen > 0) {
      process.stdout.write(`\r${' '.repeat(lastBarLen)}\r`);
      lastBarLen = 0;
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

  function onProgress(e: ProgressEvent) {
    if (e.kind === 'scorer_start') {
      running = e.name;
      renderBar();
    } else {
      completed.set(e.name, { name: e.name, elapsedMs: e.elapsedMs, result: e.result });
      if (running === e.name) running = '';
      renderBar();
    }
  }

  // Print every result once, in display order (ORDER), with any out-of-ORDER
  // scorers appended. Called after scoreSubmission resolves.
  function flush() {
    clearBar();
    const printed = new Set<string>();
    for (const id of ORDER) {
      const c = completed.get(id);
      if (c) {
        printLine(c);
        printed.add(id);
      }
    }
    for (const [name, c] of completed) {
      if (!printed.has(name)) printLine(c);
    }
  }

  return { onProgress, flush };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

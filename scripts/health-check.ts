import { createAllAdapters } from '../src/adapters/index.ts';
import type { Adapter, HealthCheckResult } from '../src/core/types.ts';

interface Row {
  tool: string;
  version: string;
  ok: boolean;
  durationMs: number;
  message: string;
}

async function runOne(adapter: Adapter): Promise<Row> {
  let result: HealthCheckResult;
  try {
    result = await adapter.healthCheck();
  } catch (err) {
    result = {
      ok: false,
      durationMs: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    tool: adapter.name,
    version: adapter.version,
    ok: result.ok,
    durationMs: result.durationMs,
    message: result.message ?? '',
  };
}

function printTable(rows: Row[]): void {
  const header = ['Tool', 'Version', 'OK', 'Duration', 'Message'];
  const widths = [
    Math.max(header[0]!.length, ...rows.map((r) => r.tool.length)),
    Math.max(header[1]!.length, ...rows.map((r) => r.version.length)),
    Math.max(header[2]!.length, 3),
    Math.max(header[3]!.length, ...rows.map((r) => `${r.durationMs}ms`.length)),
    Math.max(header[4]!.length, ...rows.map((r) => Math.min(80, r.message.length))),
  ];
  const pad = (s: string, n: number): string => s.padEnd(n);
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(header.map((h, i) => pad(h, widths[i]!)).join('  '));
  console.log(sep);
  for (const r of rows) {
    console.log(
      [
        pad(r.tool, widths[0]!),
        pad(r.version, widths[1]!),
        pad(r.ok ? 'yes' : 'NO', widths[2]!),
        pad(`${r.durationMs}ms`, widths[3]!),
        r.message.slice(0, 80),
      ].join('  '),
    );
  }
}

async function main(): Promise<void> {
  const adapters = createAllAdapters();
  console.log(`Running health check for ${adapters.length} adapter(s)...\n`);
  const rows = await Promise.all(adapters.map(runOne));
  printTable(rows);
  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${rows.length} adapters failed health check.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${rows.length} adapters healthy.`);
  }
}

await main();

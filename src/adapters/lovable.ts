import type { Adapter, HealthCheckResult, Prompt, RunContext, RunResult } from '../core/types.ts';
import { isoWeek } from '../core/version.ts';

export class LovableAdapter implements Adapter {
  readonly name = 'lovable' as const;
  readonly version: string;

  constructor(version?: string) {
    this.version = version ?? isoWeek();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    return {
      ok: false,
      durationMs: Date.now() - start,
      message:
        'Not implemented — Playwright flow pending (login via storageState, submit prompt, wait for preview URL, export via GitHub)',
    };
  }

  async submit(_prompt: Prompt, _ctx: RunContext): Promise<RunResult> {
    throw new Error('LovableAdapter.submit not yet implemented');
  }
}

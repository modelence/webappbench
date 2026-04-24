import type { Adapter, HealthCheckResult, Prompt, RunContext, RunResult } from '../core/types.ts';
import { isoWeek } from '../core/version.ts';

export class SameNewAdapter implements Adapter {
  readonly name = 'same-new' as const;
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
        'Not implemented — Playwright flow pending (login, prompt submit, preview capture; code export path TBD — may require DOM scrape fallback)',
    };
  }

  async submit(_prompt: Prompt, _ctx: RunContext): Promise<RunResult> {
    throw new Error('SameNewAdapter.submit not yet implemented');
  }
}

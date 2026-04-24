import type { Adapter, HealthCheckResult, Prompt, RunContext, RunResult } from '../core/types.ts';
import { isoWeek } from '../core/version.ts';

export class ReplitAdapter implements Adapter {
  readonly name = 'replit' as const;
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
        'Not implemented — Playwright flow pending (login, Agent prompt, wait for deployment URL, GitHub sync for code export)',
    };
  }

  async submit(_prompt: Prompt, _ctx: RunContext): Promise<RunResult> {
    throw new Error('ReplitAdapter.submit not yet implemented');
  }
}

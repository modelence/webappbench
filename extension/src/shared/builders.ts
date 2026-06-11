import type { BuilderDef } from './types.js';

export const BUILDERS: readonly BuilderDef[] = [
  {
    id: 'base44',
    label: 'Base44',
    hosts: ['base44.com'],
    creditToUsd: 0.2,
    creditRateNote: 'Starter plan: $20/mo for 100 message credits (Builder $50/250 matches).',
  },
];

export function getBuilder(id: string): BuilderDef | undefined {
  return BUILDERS.find((b) => b.id === id);
}

export function builderForUrl(url: string): BuilderDef | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return BUILDERS.find((b) => b.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
}

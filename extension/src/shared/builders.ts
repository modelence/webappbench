import type { BuilderDef } from './types.js';

export const BUILDERS: readonly BuilderDef[] = [
  {
    id: 'base44',
    label: 'Base44',
    hosts: ['base44.com'],
    contentScripts: [
      { file: 'src/content/base44.js', world: 'ISOLATED' },
      { file: 'src/content/base44-main.js', world: 'MAIN' },
    ],
    creditToUsd: 0.2,
    creditRateNote:
      'Monthly billing: $0.20/message credit (flat across Starter $20/100, Builder $50/250, Pro $100/500). 1 prompt = 1 credit.',
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

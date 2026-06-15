import type { BuilderDef } from './types.js';
import { parseBase44Conversation } from './base44-parse.js';
import { parseModelenceConversation } from './modelence-parse.js';
import { parseLovableConversation } from './lovable-parse.js';
import { parseReplitConversation } from './replit-parse.js';
import { parseV0Conversation } from './v0-parse.js';
import { parseBoltConversation } from './bolt-parse.js';
import { parseEmergentConversation } from './emergent-parse.js';

export const BUILDERS: readonly BuilderDef[] = [
  {
    id: 'base44',
    label: 'Base44',
    hosts: ['base44.com'],
    contentScripts: [
      { file: 'src/content/base44.js', world: 'ISOLATED' },
      { file: 'src/content/base44-main.js', world: 'MAIN' },
    ],
    parser: parseBase44Conversation,
    creditToUsd: 0.2,
    creditRateNote:
      'Monthly billing: $0.20/message credit (flat across Starter $20/100, Builder $50/250, Pro $100/500). 1 prompt = 1 credit.',
  },
  {
    id: 'modelence',
    label: 'Modelence',
    hosts: ['modelence.com'],
    contentScripts: [
      { file: 'src/content/modelence.js', world: 'ISOLATED' },
      { file: 'src/content/modelence-main.js', world: 'MAIN' },
    ],
    parser: parseModelenceConversation,
    // Modelence's socket frame carries no per-message cost/token signal, so we
    // can't derive USD yet. Duration is reported; cost stays blank.
    creditToUsd: null,
    creditRateNote: 'No cost signal available yet — duration only.',
  },
  {
    id: 'lovable',
    label: 'Lovable',
    hosts: ['lovable.dev', 'lovable.app'],
    contentScripts: [{ file: 'src/content/lovable.js', world: 'ISOLATED' }],
    parser: parseLovableConversation,
    creditToUsd: 0.25,
    creditRateNote: 'Monthly billing: $0.25/credit (Pro $25/mo ÷ 100 credits).',
  },
  {
    id: 'replit',
    label: 'Replit',
    hosts: ['replit.com', 'replit.app', 'repl.co'],
    contentScripts: [{ file: 'src/content/replit.js', world: 'ISOLATED' }],
    parser: parseReplitConversation,
    // Replit reports "Agent Usage" directly in USD, so cost passes through at a
    // $1/unit rate (not an editable per-credit price).
    creditToUsd: 1,
    creditRateNote: 'Agent Usage is reported in USD directly (no per-credit rate).',
  },
  {
    id: 'v0',
    label: 'v0',
    hosts: ['v0.app', 'v0.dev'],
    contentScripts: [{ file: 'src/content/v0.js', world: 'ISOLATED' }],
    parser: parseV0Conversation,
    // v0 credits are 1:1 with USD ("a $1 credit equals $1 USD"), so cost passes
    // through at a $1/credit rate.
    creditToUsd: 1,
    creditRateNote: 'v0 credits are 1:1 with USD ($1/credit).',
  },
  {
    id: 'bolt',
    label: 'Bolt',
    hosts: ['bolt.new'],
    contentScripts: [
      { file: 'src/content/bolt.js', world: 'ISOLATED' },
      { file: 'src/content/bolt-main.js', world: 'MAIN' },
    ],
    parser: parseBoltConversation,
    // Bolt's chat payload exposes no cost signal — duration only.
    creditToUsd: null,
    creditRateNote: 'No cost signal available yet — duration only.',
  },
  {
    id: 'emergent',
    label: 'Emergent',
    hosts: ['emergent.sh'],
    contentScripts: [
      { file: 'src/content/emergent.js', world: 'ISOLATED' },
      { file: 'src/content/emergent-main.js', world: 'MAIN' },
    ],
    parser: parseEmergentConversation,
    // Emergent bills subscription credits ($20 / 100 = $0.20/credit). The
    // trajectory's cumulative acc_cost is exactly the per-job "Credits Spent"
    // shown in the UI's Run Details, so credits pass through at $0.20 each.
    creditToUsd: 0.2,
    creditRateNote: 'Monthly billing: $0.20/credit ($20 / 100). Credits = the job\'s "Credits Spent".',
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

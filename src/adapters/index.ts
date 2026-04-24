import type { Adapter, ToolName } from '../core/types.ts';
import { LovableAdapter } from './lovable.ts';
import { ReplitAdapter } from './replit.ts';
import { SameNewAdapter } from './same-new.ts';

export const ALL_TOOLS: readonly ToolName[] = ['lovable', 'replit', 'same-new'];

export function createAdapter(tool: ToolName): Adapter {
  switch (tool) {
    case 'lovable':
      return new LovableAdapter();
    case 'replit':
      return new ReplitAdapter();
    case 'same-new':
      return new SameNewAdapter();
  }
}

export function createAllAdapters(): Adapter[] {
  return ALL_TOOLS.map(createAdapter);
}

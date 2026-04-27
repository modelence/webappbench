import type { ScorerResult } from './types.ts';

// Scorers that contribute to the composite (cost is self-reported, excluded)
const QUALITY_SCORERS = ['f1', 'f2', 'f6', 'c1', 'c3', 'c4', 'c5', 'c9'];

export interface CompositeScore {
  score: number;   // 0..1
  pct: string;     // "89.9"
  outOf: number;   // how many scorers contributed
}

export function computeComposite(
  scores: Record<string, ScorerResult>,
): CompositeScore | null {
  const values = QUALITY_SCORERS
    .map((d) => scores[d]?.score)
    .filter((s): s is number => typeof s === 'number');
  if (values.length === 0) return null;
  const score = values.reduce((a, b) => a + b, 0) / values.length;
  return { score, pct: (score * 100).toFixed(1), outOf: values.length };
}

export function formatComposite(c: CompositeScore | null): string {
  if (!c) return 'Score: N/A';
  const bar =
    c.score >= 0.8 ? '█' :
    c.score >= 0.6 ? '▓' : '░';
  return `Score: ${c.pct} / 100  ${bar}  (${c.outOf} scorer${c.outOf === 1 ? '' : 's'})`;
}

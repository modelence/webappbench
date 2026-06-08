import type { ScorerResult } from './types.ts';

// ── Weighting design ─────────────────────────────────────────────────────────
//
// The composite is a weighted mean of dimension scores. Each dimension is
// itself a weighted mean of its scorers. Weights come from the research design
// (METRICS.md "Scoring architecture") with two adjustments for v0.1 scope:
//   1. Cost (T) is informational only — its 15% dimension weight redistributes
//      proportionally across F/C/V/S, giving normalized dimension weights of
//      F 47% / C 18% / V 24% / S 12%.
//   2. Within Functional, F3 (spec-based e2e tests, app-track only) isn't
//      implemented — its 25% redistributes to F2 (+15) and F6 (+10).
//      Within Visual, V3 (reference fidelity) and V5 (animation polish) aren't
//      implemented — their combined 15% redistributes proportionally to V1/V2/V4.
//      Within Code Quality, C5's "env_setup_clean" sub-check ships as a
//      top-level scorer C8 — splits C5's 10% into 5% C5 + 5% C8.
//
// When a scorer's score is null (skipped or N/A), its weight redistributes
// proportionally across the other scorers in its dimension. If every scorer
// in a dimension is null, that dimension drops out and its weight redistributes
// across the other dimensions.

export type Dimension = 'functional' | 'code_quality' | 'visual' | 'security';

// Within-dimension scorer weights. The non-backend scorers in each dimension
// sum to 100; the backend-track scorers (F7/F8/S4) are ADDITIVE on top.
//
// This is deliberate. F7/F8/S4 return null on any submission without a backend
// block, so the null-redistribution rule divides only by the weight-sum of the
// scorers actually present. For Tier 1/2 submissions that means dividing by 100
// → the original proportions are preserved exactly (no silent rescoring). For a
// Tier 3 backend submission all scorers are present and the effective weights
// reflow over the larger sum (Functional → /115, Security → /115), which is the
// intended "the dimension expands when there's a backend to measure" behavior
// from ROADMAP v0.3 — rather than statically narrowing F2/S1/S2/S3 for everyone.
const SCORER_WEIGHTS: Record<string, { dimension: Dimension; weight: number }> = {
  // Functional — non-backend scorers sum to 100 (F1+F2+F4+F5+F6); F7+F8 additive.
  f1: { dimension: 'functional', weight: 15 },
  f2: { dimension: 'functional', weight: 45 },
  f4: { dimension: 'functional', weight: 10 },
  f5: { dimension: 'functional', weight: 5 },
  f6: { dimension: 'functional', weight: 25 },
  f7: { dimension: 'functional', weight: 8 },
  f8: { dimension: 'functional', weight: 7 },

  // Code Quality (C1+C2+C3+C4+C5+C6+C7+C8+C9 = 100)
  c1: { dimension: 'code_quality', weight: 20 },
  c2: { dimension: 'code_quality', weight: 5 },
  c3: { dimension: 'code_quality', weight: 20 },
  c4: { dimension: 'code_quality', weight: 20 },
  c5: { dimension: 'code_quality', weight: 5 },
  c6: { dimension: 'code_quality', weight: 5 },
  c7: { dimension: 'code_quality', weight: 15 },
  c8: { dimension: 'code_quality', weight: 5 },
  c9: { dimension: 'code_quality', weight: 5 },

  // Visual (V1 + V2 + V4 = 100)
  v1: { dimension: 'visual', weight: 55 },
  v2: { dimension: 'visual', weight: 30 },
  v4: { dimension: 'visual', weight: 15 },

  // Security — non-backend scorers sum to 100 (S1+S2+S3 = 40/35/25); S4 additive.
  // On non-backend submissions S4 is null and S1/S2/S3 keep their exact prior
  // 40/35/25 proportions; on backend submissions S4 reflows in at 15/115 ≈ 13%.
  s1: { dimension: 'security', weight: 40 },
  s2: { dimension: 'security', weight: 35 },
  s3: { dimension: 'security', weight: 25 },
  s4: { dimension: 'security', weight: 15 },
};

// Dimension weights — must sum to 100. Cost is excluded (informational only),
// so its 15% is redistributed proportionally across the four scoring dimensions.
const DIMENSION_WEIGHTS: Record<Dimension, number> = {
  functional: 47,
  code_quality: 18,
  visual: 24,
  security: 11,
};

export interface DimensionScore {
  dimension: Dimension;
  score: number;       // 0..1, weighted mean of contributing scorers
  weight: number;      // dimension weight in the composite (0..100)
  contributors: Array<{ id: string; score: number; weight: number }>;
}

export interface CompositeScore {
  score: number;       // 0..1
  pct: string;         // "89.9"
  outOf: number;       // how many scorers contributed
  dimensions: DimensionScore[];
}

export function computeComposite(
  scores: Record<string, ScorerResult>,
): CompositeScore | null {
  // Build per-dimension scorer lists from contributing (non-null) scorers.
  const byDimension = new Map<Dimension, Array<{ id: string; score: number; weight: number }>>();
  let totalContributors = 0;

  for (const [id, meta] of Object.entries(SCORER_WEIGHTS)) {
    const result = scores[id];
    if (!result || typeof result.score !== 'number') continue;
    const list = byDimension.get(meta.dimension) ?? [];
    list.push({ id, score: result.score, weight: meta.weight });
    byDimension.set(meta.dimension, list);
    totalContributors++;
  }

  if (totalContributors === 0) return null;

  // Compute each dimension's weighted-mean score. Null scorers drop out;
  // surviving scorers' weights renormalize within the dimension.
  const dimensionScores: DimensionScore[] = [];
  for (const [dimension, contributors] of byDimension.entries()) {
    if (contributors.length === 0) continue;
    const weightSum = contributors.reduce((a, c) => a + c.weight, 0);
    const score = contributors.reduce((a, c) => a + c.score * c.weight, 0) / weightSum;
    dimensionScores.push({
      dimension,
      score,
      weight: DIMENSION_WEIGHTS[dimension],
      contributors,
    });
  }

  // Composite: weighted mean of dimension scores. Empty dimensions drop out
  // and their dimension weight renormalizes across the rest.
  const dimWeightSum = dimensionScores.reduce((a, d) => a + d.weight, 0);
  const composite = dimensionScores.reduce((a, d) => a + d.score * d.weight, 0) / dimWeightSum;

  return {
    score: composite,
    pct: (composite * 100).toFixed(1),
    outOf: totalContributors,
    dimensions: dimensionScores.sort(
      (a, b) => DIMENSION_WEIGHTS[b.dimension] - DIMENSION_WEIGHTS[a.dimension],
    ),
  };
}

export function formatComposite(c: CompositeScore | null): string {
  if (!c) return 'Score: N/A';
  const bar =
    c.score >= 0.8 ? '█' :
    c.score >= 0.6 ? '▓' : '░';
  return `Score: ${c.pct} / 100  ${bar}  (${c.outOf} scorer${c.outOf === 1 ? '' : 's'})`;
}

const DIMENSION_LABELS: Record<Dimension, string> = {
  functional: 'Functional',
  code_quality: 'Code Quality',
  visual: 'Visual',
  security: 'Security',
};

// Multi-line breakdown to print under formatComposite. Shows each dimension's
// contribution (weight × dim score) and the contributing scorer ids so users
// can see where the headline number came from.
export function formatCompositeBreakdown(c: CompositeScore | null): string {
  if (!c) return '';
  const lines = c.dimensions.map((d) => {
    const label = DIMENSION_LABELS[d.dimension].padEnd(13);
    const pct = (d.score * 100).toFixed(1).padStart(5);
    const weight = `${d.weight}%`.padStart(4);
    const ids = d.contributors.map((x) => x.id).join(' ');
    return `    ${label} ${pct} / 100   weight ${weight}   (${ids})`;
  });
  return lines.join('\n');
}

// Exposed for the report/glossary so users see what each scorer contributes.
export function scorerWeight(id: string): { dimension: Dimension; weight: number } | null {
  return SCORER_WEIGHTS[id] ?? null;
}

export function dimensionWeight(dimension: Dimension): number {
  return DIMENSION_WEIGHTS[dimension];
}

export const ALL_DIMENSION_WEIGHTS: ReadonlyArray<{ dimension: Dimension; weight: number }> =
  Object.entries(DIMENSION_WEIGHTS).map(([dimension, weight]) => ({
    dimension: dimension as Dimension,
    weight,
  }));

export type ToolName =
  | 'lovable'
  | 'replit'
  | 'same-new'
  | 'v0'
  | 'bolt'
  | 'claude-artifacts'
  | 'modelence';

export const ALL_TOOLS: readonly ToolName[] = [
  'lovable',
  'replit',
  'same-new',
  'v0',
  'bolt',
  'claude-artifacts',
  'modelence',
];

export interface Prompt {
  id: string;
  tier: 1 | 2 | 3;
  prompt: string;
  mustHave: AcceptanceCriterion[];
  shouldHave: AcceptanceCriterion[];
  verbatimConstraints: VerbatimConstraint[];
  seoApplicable: SeoCheck[];
  visualChecklist: ChecklistConfig;
  functionalChecklist: ChecklistConfig;
}

export interface ChecklistConfig {
  // Extra criteria added on top of the scorer's default rubric.
  extra: ChecklistItem[];
  // Skip the default copy-quality criteria (no SaaS-speak, no fabricated
  // trust signals, CTA verb specificity) when the prompt explicitly uses
  // placeholder content. Only applies to the visual checklist.
  placeholderCopy: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  description: string;
}

export interface AcceptanceCriterion {
  id: string;
  locator: string;
  assert: string;
  custom?: string;
}

export interface VerbatimConstraint {
  type: 'exact_copy' | 'hex_value' | 'structural';
  value: string;
  where: string;
}

export type SeoCheck =
  | 'title'
  | 'meta_description'
  | 'canonical'
  | 'og_tags'
  | 'twitter_card'
  | 'json_ld'
  | 'lang'
  | 'heading_hierarchy'
  | 'robots_txt'
  | 'sitemap_xml';

export interface UserReportedTiming {
  promptSubmittedAt?: string;
  firstRenderAt?: string;
  workingBuildAt?: string;
}

export interface UserReportedCost {
  credits?: number;
  usdEstimate?: number;
  notes?: string;
}

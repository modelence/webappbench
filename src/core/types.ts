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

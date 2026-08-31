import type { BackendProbe } from './backend.ts';

export type ToolName = string;

export const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
  // Read-only backend security probes (Tier 3 backend track). Empty for prompts
  // that declare none. Consumed by the planned S4 scorer.
  backendProbes: BackendProbe[];
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
  // Optional setup actions performed against the page before the locator is
  // evaluated. Used by stateful prompts (Tier 2+ apps) to drive the page into
  // a specific state — clear localStorage, fill a field, click a button,
  // reload — so the assertion runs against meaningful state instead of a
  // freshly-loaded page. Each step runs sequentially; an error in any step
  // fails the criterion.
  setup?: SetupAction[];
}

export type SetupAction =
  | { kind: 'evaluate'; expr: string }                       // page.evaluate(<expr>)
  | { kind: 'fill'; locator: string; value: string }         // typing into a textbox/textarea
  | { kind: 'click'; locator: string }                       // clicking a button/link
  | { kind: 'press'; locator: string; key: string }          // pressing a keyboard key
  | { kind: 'reload' }                                        // page.reload()
  | { kind: 'waitFor'; locator: string }                     // wait for locator to be visible
  | { kind: 'revealLoginForm' }                              // click through a splash to the login form
  | { kind: 'login'; account?: 'a' | 'b' }                   // sign in with the submission's backend credentials
  | { kind: 'logout' };                                      // click the app's log-out control

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
  // Simpler alternative: total seconds from prompt submission to working build.
  duration?: number;
}

export interface UserReportedCost {
  // Approximate USD spent on the run (platform credits converted at retail rate).
  cost?: number;
  notes?: string;
}

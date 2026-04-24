export type ToolName = 'lovable' | 'replit' | 'same-new';

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

export interface RunContext {
  runIdx: number;
  artifactDir: string;
  startedAt: Date;
}

export interface TimingData {
  promptSubmittedAt: string;
  firstRenderAt?: string;
  workingBuildAt?: string;
  completedAt: string;
  ttfrMs?: number;
  ttwbMs?: number;
  totalMs: number;
}

export interface UsageData {
  credits?: number;
  tokens?: number;
  usdEstimate?: number;
  raw?: Record<string, unknown>;
}

export type TranscriptEvent =
  | { t: string; kind: 'prompt_sent'; text: string }
  | { t: string; kind: 'tool_output'; text: string }
  | { t: string; kind: 'artifact_url'; url: string }
  | { t: string; kind: 'error'; message: string; fatal: boolean };

export interface RunResult {
  artifactUrl?: string;
  sourcePath?: string;
  usage?: UsageData;
  timing: TimingData;
  transcript: TranscriptEvent[];
}

export interface HealthCheckResult {
  ok: boolean;
  artifactUrl?: string;
  durationMs: number;
  message?: string;
}

export interface Adapter {
  readonly name: ToolName;
  readonly version: string;
  healthCheck(): Promise<HealthCheckResult>;
  submit(prompt: Prompt, ctx: RunContext): Promise<RunResult>;
}

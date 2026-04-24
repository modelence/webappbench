import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Prompt, ToolName } from './types.ts';

export interface Manifest {
  schemaVersion: 1;
  harnessVersion: string;
  nodeVersion: string;
  platform: string;
  scorerVersions: Record<string, string>;
  scoredAt: string;
}

export interface ArtifactPaths {
  root: string;
  submission: string;
  prompt: string;
  screenshots: string;
  network: string;
  playwrightResults: string;
  axe: string;
  lighthouse: string;
  acceptance: string;
  seo: string;
  cost: string;
  manifest: string;
}

export function artifactPaths(
  baseDir: string,
  tool: ToolName,
  promptId: string,
  runIdx: number,
): ArtifactPaths {
  const root = join(baseDir, tool, promptId, String(runIdx));
  return {
    root,
    submission: join(root, 'submission.json'),
    prompt: join(root, 'prompt.json'),
    screenshots: join(root, 'screenshots'),
    network: join(root, 'network.har'),
    playwrightResults: join(root, 'playwright_results'),
    axe: join(root, 'axe.json'),
    lighthouse: join(root, 'lighthouse.json'),
    acceptance: join(root, 'acceptance.json'),
    seo: join(root, 'seo.json'),
    cost: join(root, 'cost.json'),
    manifest: join(root, 'manifest.json'),
  };
}

export async function prepareArtifactDir(paths: ArtifactPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.screenshots, { recursive: true });
  await mkdir(paths.playwrightResults, { recursive: true });
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function writePromptJson(paths: ArtifactPaths, prompt: Prompt): Promise<void> {
  await writeJson(paths.prompt, prompt);
}

export async function writeManifest(paths: ArtifactPaths, manifest: Manifest): Promise<void> {
  await writeJson(paths.manifest, manifest);
}

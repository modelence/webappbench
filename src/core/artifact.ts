import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Prompt, RunResult, ToolName, TranscriptEvent } from './types.ts';

export interface Manifest {
  schemaVersion: 1;
  harnessVersion: string;
  adapterName: ToolName;
  adapterVersion: string;
  nodeVersion: string;
  platform: string;
  startedAt: string;
  completedAt: string;
  env: Record<string, string>;
}

export interface ArtifactPaths {
  root: string;
  prompt: string;
  transcript: string;
  artifactUrl: string;
  screenshots: string;
  network: string;
  playwrightResults: string;
  usage: string;
  timing: string;
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
    prompt: join(root, 'prompt.json'),
    transcript: join(root, 'transcript.jsonl'),
    artifactUrl: join(root, 'artifact_url'),
    screenshots: join(root, 'screenshots'),
    network: join(root, 'network.har'),
    playwrightResults: join(root, 'playwright_results'),
    usage: join(root, 'usage.json'),
    timing: join(root, 'timing.json'),
    manifest: join(root, 'manifest.json'),
  };
}

export async function prepareArtifactDir(paths: ArtifactPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.screenshots, { recursive: true });
  await mkdir(paths.playwrightResults, { recursive: true });
}

export async function writePromptJson(paths: ArtifactPaths, prompt: Prompt): Promise<void> {
  await writeFile(paths.prompt, JSON.stringify(prompt, null, 2), 'utf8');
}

export async function writeTranscript(
  paths: ArtifactPaths,
  events: TranscriptEvent[],
): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(paths.transcript, lines, 'utf8');
}

export async function writeRunResult(
  paths: ArtifactPaths,
  result: RunResult,
): Promise<void> {
  await writeTranscript(paths, result.transcript);
  await writeFile(paths.timing, JSON.stringify(result.timing, null, 2), 'utf8');
  if (result.artifactUrl) {
    await writeFile(paths.artifactUrl, result.artifactUrl, 'utf8');
  }
  if (result.usage) {
    await writeFile(paths.usage, JSON.stringify(result.usage, null, 2), 'utf8');
  }
}

export async function writeManifest(
  paths: ArtifactPaths,
  manifest: Manifest,
): Promise<void> {
  await writeFile(paths.manifest, JSON.stringify(manifest, null, 2), 'utf8');
}

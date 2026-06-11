// Generates dist/prompts.json from the benchmark prompt corpus so the
// extension's prompt list has a single source of truth.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const corpusDir = join(extensionRoot, '..', 'prompts', 'corpus');
const outFile = join(extensionRoot, 'dist', 'prompts.json');

const files = (await readdir(corpusDir)).filter((name) => name.endsWith('.yaml')).sort();
if (files.length === 0) {
  throw new Error(`No prompt YAML files found in ${corpusDir}`);
}

const prompts = [];
for (const file of files) {
  const raw = parse(await readFile(join(corpusDir, file), 'utf8'));
  if (!raw || typeof raw.id !== 'string' || typeof raw.prompt !== 'string') {
    throw new Error(`${file}: expected "id" and "prompt" string fields`);
  }
  prompts.push({ id: raw.id, tier: typeof raw.tier === 'number' ? raw.tier : 0, prompt: raw.prompt });
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(prompts, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outFile} (${prompts.length} prompts: ${prompts.map((p) => p.id).join(', ')})`);

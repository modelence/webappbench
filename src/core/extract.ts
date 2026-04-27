import AdmZip from 'adm-zip';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const abs = resolve(zipPath);
  await mkdir(destDir, { recursive: true });
  const zip = new AdmZip(abs);
  // overwrite = true so re-runs are idempotent
  zip.extractAllTo(destDir, true);
}

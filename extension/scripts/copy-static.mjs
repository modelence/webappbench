// Copies public/* into dist/ so dist/ is a complete unpacked extension.
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(extensionRoot, 'public');
const distDir = join(extensionRoot, 'dist');

await mkdir(distDir, { recursive: true });
await cp(publicDir, distDir, { recursive: true });
console.log(`Copied static assets: ${publicDir} -> ${distDir}`);

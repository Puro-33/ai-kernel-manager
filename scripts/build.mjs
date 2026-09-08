import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
await build({ entryPoints: [path.join(root, 'web/app.js')], outfile: path.join(root, 'dist/app.js'), bundle: true, minify: true, sourcemap: false, target: ['es2022'], legalComments: 'eof', loader: { '.woff2': 'file' } });
await copyFile(path.join(root, 'web/index.html'), path.join(root, 'dist/index.html'));
console.log('Built Kernel Deck into dist/');

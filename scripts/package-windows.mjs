import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Package on Windows x64 with a Windows x64 Node runtime.');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const name = `Kernel-Deck-${pkg.version}-windows-x64`;
const output = path.join(root, 'artifacts', 'release');
await fs.mkdir(output, { recursive: true });
const stage = path.join(await fs.mkdtemp(path.join(output, '.build-')), name);
await fs.mkdir(stage, { recursive: true });
// Explicit application files only: never include .data, test logs, or user projects.
for (const filename of ['server', 'dist', 'start.cmd', 'stop.cmd', 'README.md', 'LICENSE']) {
  await fs.cp(path.join(root, filename), path.join(stage, filename), { recursive: true });
}
await fs.mkdir(path.join(stage, 'scripts'), { recursive: true });
for (const filename of ['start-manager.ps1', 'stop-manager.ps1']) await fs.copyFile(path.join(root, 'scripts', filename), path.join(stage, 'scripts', filename));
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', engines: pkg.engines }, null, 2));
const copied = new Set();
async function copyDependency(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = path.join(root, 'node_modules', name);
  const definition = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  await fs.cp(source, path.join(stage, 'node_modules', name), { recursive: true });
  for (const dependency of Object.keys(definition.dependencies || {})) await copyDependency(dependency);
}
for (const dependency of ['node-pty', 'ws']) await copyDependency(dependency);
await fs.mkdir(path.join(stage, 'runtime'), { recursive: true });
await fs.copyFile(process.execPath, path.join(stage, 'runtime', 'node.exe'));
const runtimeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
await fs.copyFile(runtimeLicense, path.join(stage, 'runtime', 'LICENSE'));
const notices = [`Kernel Deck bundles Node.js, ${[...copied].join(', ')}, xterm.js and esbuild output.`, 'Runtime and server dependency licenses are included beside those components.', 'Frontend licenses follow below.'];
for (const dependency of ['@xterm/xterm', '@xterm/addon-fit']) {
  notices.push(`\n--- ${dependency} ---\n${await fs.readFile(path.join(root, 'node_modules', dependency, 'LICENSE'), 'utf8')}`);
}
await fs.writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const archive = path.join(output, `${name}.zip`);
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
// Literal paths remain in the explicit release directory; no recursive delete.
await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `Compress-Archive -LiteralPath ${psQuote(stage)} -DestinationPath ${psQuote(archive)} -Force -CompressionLevel Optimal`], { windowsHide: true, timeout: 180000 });
const bytes = await fs.readFile(archive);
const checksum = `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(archive)}\n`;
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), checksum);
console.log(JSON.stringify({ archive, bytes: bytes.length, checksum: checksum.trim(), runtime: process.version, dependencies: [...copied] }, null, 2));

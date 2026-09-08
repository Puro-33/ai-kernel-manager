import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const exec = promisify(execFile);
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const definition = JSON.parse(await readFile(path.join(projectDirectory, 'package.json'), 'utf8'));
const releaseName = `Kernel-Deck-${definition.version}-windows-x64`;
const archivePath = path.resolve(process.argv[2] || path.join(projectDirectory, 'artifacts', 'release', `${releaseName}.zip`));
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  archive: path.basename(archivePath),
  archiveEntryCount: 0,
  privateFilesExcluded: false,
  systemNodeUnavailable: false,
  bundledNodeVersion: null,
  launcherStartedServer: false,
  bootstrapVerified: false,
  terminal: null,
  shutdownVerified: false,
  temporaryFilesRemoved: false,
  passed: false,
};
let phase = 'platform';
let temporaryDirectory;
let applicationDirectory;
let environment;
let port;
let baseUrl;
let cookie;
let owner;
let socket;
let started = false;
let failure;
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const system32 = path.join(systemRoot, 'System32');
const powerShellDirectory = path.join(system32, 'WindowsPowerShell', 'v1.0');
const powerShell = path.join(powerShellDirectory, 'powershell.exe');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function runPowerShell(script, timeout = 20_000) {
  return exec(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: environment,
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

async function request(route, { method = 'GET', body, timeout = 20_000 } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: baseUrl, 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  assert.ok(response.ok, `Package HTTP request failed with ${response.status}.`);
  return response;
}

async function waitUntil(predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error('Package verification timed out.');
}

async function healthClosed() {
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(700) });
    return false;
  } catch { return true; }
}

async function ownedServerMatches() {
  const lockPath = path.join(applicationDirectory, '.data', 'manager.lock');
  if (!(await exists(lockPath))) return false;
  const current = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.ok(Number.isSafeInteger(current.pid) && current.pid > 0);
  if (owner && (current.pid !== owner.pid || current.token !== owner.token)) return false;
  const node = path.join(applicationDirectory, 'runtime', 'node.exe');
  const server = path.join(applicationDirectory, 'server', 'index.mjs');
  const { stdout } = await runPowerShell(`$ErrorActionPreference='Stop'; $owned=Get-CimInstance Win32_Process -Filter 'ProcessId = ${current.pid}'; [bool]($owned -and $owned.ExecutablePath -eq ${quote(node)} -and $owned.CommandLine.Contains(${quote(server)}))`);
  if (stdout.trim().toLowerCase() !== 'true') return false;
  owner = current;
  return true;
}

async function shutdownOwnedServer() {
  const lockPath = path.join(applicationDirectory, '.data', 'manager.lock');
  if (await healthClosed() && !(await exists(lockPath))) {
    report.shutdownVerified = true;
    return;
  }
  assert.equal(await ownedServerMatches(), true, 'The server is not the owned package verification process.');
  await exec(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(applicationDirectory, 'scripts', 'stop-manager.ps1'), '-Port', String(port)], {
    env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
  });
  await waitUntil(async () => await healthClosed() && !(await exists(lockPath)));
  try {
    process.kill(owner.pid, 0);
    await waitUntil(() => {
      try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    }, 3_000);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  report.shutdownVerified = true;
}

try {
  assert.equal(process.platform, 'win32', 'This package verification requires Windows.');
  assert.equal(process.arch, 'x64', 'This package verification requires x64.');
  phase = 'archive';
  assert.ok((await stat(archivePath)).isFile());
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'kernel-deck-package-smoke-'));
  const cleanProfile = path.join(temporaryDirectory, 'clean-profile');
  await mkdir(cleanProfile);
  environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: path.parse(systemRoot).root.replace(/[\\/]$/, ''),
    ComSpec: path.join(system32, 'cmd.exe'),
    Path: `${system32};${powerShellDirectory}`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: cleanProfile,
    APPDATA: path.join(cleanProfile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(cleanProfile, 'AppData', 'Local'),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  };
  const { stdout: inventoryJson } = await runPowerShell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[System.IO.Compression.ZipFile]::OpenRead(${quote(archivePath)}); try { ConvertTo-Json -InputObject @($archive.Entries | ForEach-Object { $_.FullName }) -Compress } finally { $archive.Dispose() }`);
  const entries = JSON.parse(inventoryJson.trim());
  assert.ok(Array.isArray(entries) && entries.length > 0);
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    const parts = normalized.split('/');
    assert.ok(!normalized.startsWith('/') && !normalized.includes(':') && !normalized.includes('\0') && !parts.includes('..'), 'Archive entry escaped the extraction directory.');
    assert.equal(parts[0], releaseName, 'Archive has an unexpected application directory.');
    assert.ok(!parts.some((part) => /^(?:\.data|\.git|\.codex|\.claude|\.ssh|\.env(?:\..*)?|\.npmrc|auth\.json|manager\.lock|state\.json|PERSONAL_CONTEXT\.md|NOTION_JOURNAL\.md)$/i.test(part)), 'Archive contains private state or environment files.');
    assert.ok(!/\.log$/i.test(normalized), 'Archive contains a private or development log.');
  }
  report.archiveEntryCount = entries.length;
  report.privateFilesExcluded = true;
  const extracted = path.join(temporaryDirectory, 'extracted');
  phase = 'extract';
  await runPowerShell(`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(extracted)}`, 120_000);
  applicationDirectory = path.join(extracted, releaseName);
  for (const filename of ['runtime/node.exe', 'dist/index.html', 'server/index.mjs', 'scripts/start-manager.ps1', 'scripts/stop-manager.ps1']) {
    assert.ok(await exists(path.join(applicationDirectory, filename)), 'A required packaged application file is missing.');
  }
  assert.equal(await exists(path.join(applicationDirectory, '.data')), false);

  phase = 'bundled-runtime';
  await runPowerShell("if (Get-Command node.exe -ErrorAction SilentlyContinue) { exit 1 }");
  report.systemNodeUnavailable = true;
  const bundledNode = path.join(applicationDirectory, 'runtime', 'node.exe');
  const { stdout: nodeVersion } = await exec(bundledNode, ['--version'], { env: environment, windowsHide: true, timeout: 10_000 });
  assert.match(nodeVersion.trim(), /^v\d+\.\d+\.\d+$/);
  report.bundledNodeVersion = nodeVersion.trim();

  phase = 'launcher';
  port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  assert.equal(await healthClosed(), true);
  started = true;
  // Match the process-scoped script policy used by the packaged .cmd launchers.
  await exec(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(applicationDirectory, 'scripts', 'start-manager.ps1'), '-Port', String(port), '-NoBrowser'], {
    cwd: applicationDirectory, env: environment, windowsHide: true, timeout: 35_000, maxBuffer: 128 * 1024,
  });
  assert.equal(await ownedServerMatches(), true);
  const health = await (await request('/health')).json();
  assert.equal(health.app, 'kernel-deck');
  assert.equal(health.version, definition.version);
  report.launcherStartedServer = true;

  phase = 'bootstrap';
  const index = await request('/');
  assert.match(await index.text(), /Kernel Deck/);
  const setCookie = index.headers.get('set-cookie');
  assert.match(setCookie || '', /HttpOnly/i);
  cookie = setCookie.split(';')[0];
  const bootstrap = await (await request('/api/bootstrap')).json();
  assert.equal(bootstrap.version, definition.version);
  assert.deepEqual(bootstrap.sessions, []);
  assert.equal(bootstrap.platform, 'win32');
  report.bootstrapVerified = true;

  phase = 'terminal';
  const fixture = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{input+=data;if(input.includes('package-smoke')){console.log('KERNEL_DECK_PACKAGE_OK');process.exit(0)}});console.log('KERNEL_DECK_PACKAGE_READY');";
  const session = await (await request('/api/sessions', { method: 'POST', body: { name: 'Package verification', command: bundledNode, args: ['-e', fixture], cwd: applicationDirectory, autoStart: true } })).json();
  await waitUntil(async () => {
    const log = await (await request(`/api/sessions/${session.id}/log`)).json();
    return log.data.includes('KERNEL_DECK_PACKAGE_READY');
  });
  socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`, { headers: { Cookie: cookie, Origin: baseUrl } });
  let socketFailed = false;
  socket.on('error', () => { socketFailed = true; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Package terminal connection timed out.')), 10_000);
    socket.once('open', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', () => { clearTimeout(timeout); reject(new Error('Package terminal connection failed.')); });
  });
  socket.send(JSON.stringify({ type: 'subscribe', id: session.id }));
  socket.send(JSON.stringify({ type: 'input', id: session.id, data: 'package-smoke\r' }));
  let finalSession;
  await waitUntil(async () => {
    assert.equal(socketFailed, false);
    const snapshot = await (await request('/api/bootstrap')).json();
    finalSession = snapshot.sessions.find((item) => item.id === session.id);
    return finalSession && ['completed', 'failed', 'stopped'].includes(finalSession.status);
  });
  const log = await (await request(`/api/sessions/${session.id}/log`)).json();
  assert.equal(finalSession.status, 'completed');
  assert.equal(finalSession.exitCode, 0);
  assert.ok(log.data.includes('KERNEL_DECK_PACKAGE_OK'));
  report.terminal = { state: finalSession.status, exitCode: finalSession.exitCode, inputOutputVerified: true, outputBytes: Buffer.byteLength(log.data), hasAnsi: /\x1b\[/.test(log.data) };
  socket.close();

  phase = 'shutdown';
  await shutdownOwnedServer();
} catch (error) {
  failure = error;
  report.failure = `package-verification-failed:${phase}`;
} finally {
  socket?.terminate();
  if (started && applicationDirectory && !report.shutdownVerified) {
    try { await shutdownOwnedServer(); }
    catch (error) {
      failure ||= error;
      report.cleanupFailure = 'owned-package-server-cleanup-unverified';
    }
  }
  if (temporaryDirectory && (!started || report.shutdownVerified)) {
    try {
      const resolvedTemporary = await realpath(temporaryDirectory);
      const allowedRoot = (await realpath(tmpdir())) + path.sep;
      assert.ok(resolvedTemporary.toLowerCase().startsWith(allowedRoot.toLowerCase()));
      assert.ok(path.basename(resolvedTemporary).startsWith('kernel-deck-package-smoke-'));
      await rm(resolvedTemporary, { recursive: true, force: true });
      report.temporaryFilesRemoved = true;
    } catch (error) {
      failure ||= error;
      report.cleanupFailure = 'temporary-package-cleanup-unverified';
    }
  }
  report.passed = !failure && report.shutdownVerified && report.temporaryFilesRemoved;
  const artifacts = path.join(projectDirectory, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'package-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}

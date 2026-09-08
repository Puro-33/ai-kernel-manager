import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnvironment } from '../server/environment.mjs';

const WINDOWS_HOME = 'C:\\Users\\Tester';
const WINDOWS_SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function windowsEnvironment(files, overrides = {}) {
  const available = new Set(files.map((filename) => filename.toLowerCase()));
  return createEnvironment({
    platform: 'win32',
    env: { Path: 'C:\\Tools;C:\\Scripts', SystemRoot: 'C:\\Windows' },
    homeDirectory: WINDOWS_HOME,
    isExecutable: async (filename) => available.has(filename.toLowerCase()),
    run: async () => { throw new Error('Unexpected child process'); },
    ...overrides,
  });
}

test('finds desktop-bundled Codex and standalone Claude using the supplied user home', async () => {
  const codex = `${WINDOWS_HOME}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`;
  const claude = `${WINDOWS_HOME}\\.local\\bin\\claude.exe`;
  const environment = windowsEnvironment([codex, claude, WINDOWS_SHELL]);
  const presets = await environment.getPresets();
  assert.equal(presets.length, 7);
  assert.deepEqual(presets.find((preset) => preset.id === 'codex'), {
    id: 'codex', name: 'Codex', command: codex, args: [], cwd: WINDOWS_HOME,
    available: true, description: 'Codex 대화형 코딩 세션',
  });
  assert.equal(presets.find((preset) => preset.id === 'claude').command, claude);
  assert.equal(presets.find((preset) => preset.id === 'gemini').available, false);
});

test('quotes apostrophes and shell metacharacters in Windows npm shims as literal paths', async () => {
  const directory = "C:\\Users\\O'Brien $value & Co\\npm";
  const filename = `${directory}\\gemini.cmd`;
  const environment = windowsEnvironment([filename, WINDOWS_SHELL], { env: { Path: directory } });
  const preset = (await environment.getPresets()).find((item) => item.id === 'gemini');
  assert.equal(preset.available, true);
  assert.equal(preset.command, WINDOWS_SHELL);
  assert.deepEqual(preset.args, ['-NoLogo', '-NoExit', '-Command', "& 'C:\\Users\\O''Brien $value & Co\\npm\\gemini.cmd'"]);
});

test('does not claim a Windows shim can run without a shell', async () => {
  const environment = windowsEnvironment(['C:\\Scripts\\claude.ps1']);
  const preset = (await environment.getPresets()).find((item) => item.id === 'claude');
  assert.equal(preset.available, false);
  assert.match(preset.description, /PowerShell/);
});

test('Windows launches a real cmd shim from a path containing shell metacharacters', { skip: process.platform !== 'win32' }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'kernel-deck-environment-'));
  t.after(async () => {
    const allowedRoot = path.resolve(tmpdir()) + path.sep;
    assert.ok(path.resolve(temporaryRoot).startsWith(allowedRoot));
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const directory = path.join(temporaryRoot, "O'Brien $value & Co");
  await mkdir(directory);
  await writeFile(path.join(directory, 'gemini.cmd'), '@echo KERNEL_DECK_SHIM_OK\r\n');
  // Remove inherited Path: JS objects are case-sensitive, Windows env is not.
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const environment = createEnvironment({ env: { ...isolatedEnv, PATH: directory } });
  const preset = (await environment.getPresets()).find((item) => item.id === 'gemini');
  assert.equal(preset.available, true);
  const args = preset.args.filter((argument) => argument !== '-NoExit');
  const { stdout } = await promisify(execFile)(preset.command, args, { timeout: 10_000, windowsHide: true });
  assert.match(stdout, /KERNEL_DECK_SHIM_OK/);
});

test('skips Python Store aliases and finds a real interpreter', async () => {
  const aliasDirectory = `${WINDOWS_HOME}\\AppData\\Local\\Microsoft\\WindowsApps`;
  const actual = `${WINDOWS_HOME}\\anaconda3\\python.exe`;
  const environment = windowsEnvironment([`${aliasDirectory}\\python.exe`, actual], { env: { Path: aliasDirectory } });
  const preset = (await environment.getPresets()).find((item) => item.id === 'python');
  assert.equal(preset.command, actual);
  assert.equal(preset.available, true);
});

test('WSL requires an installed distribution and uses a bounded read-only probe', async () => {
  const filename = 'C:\\Windows\\System32\\wsl.exe';
  const calls = [];
  let stdout = '';
  const environment = windowsEnvironment([filename], {
    run: async (...args) => { calls.push(args); return { stdout }; },
  });
  assert.equal((await environment.getPresets()).find((item) => item.id === 'wsl').available, false);
  stdout = 'U\0b\0u\0n\0t\0u\0\r\0\n\0';
  assert.equal((await environment.getPresets()).find((item) => item.id === 'wsl').available, true);
  assert.equal(calls[0][0], filename);
  assert.deepEqual(calls[0][1], ['--list', '--quiet']);
  assert.equal(calls[0][2].timeout, 10_000);
  assert.equal(calls[0][2].windowsHide, true);
});

test('WSL probe errors disable the preset without disclosing child process output', async () => {
  const environment = windowsEnvironment(['C:\\Windows\\System32\\wsl.exe'], {
    run: async () => { throw new Error('private-token-output'); },
  });
  const preset = (await environment.getPresets()).find((item) => item.id === 'wsl');
  assert.equal(preset.available, false);
  assert.doesNotMatch(JSON.stringify(preset), /private-token/);
});

test('Unix presets find executable CLI paths and do not offer WSL', async () => {
  const environment = createEnvironment({
    platform: 'linux', homeDirectory: '/home/tester', env: { PATH: '/opt/ai/bin:/usr/bin' },
    isExecutable: async (filename) => ['/opt/ai/bin/codex', '/usr/bin/python3', '/usr/bin/pwsh'].includes(filename),
  });
  const presets = await environment.getPresets();
  assert.equal(presets.find((item) => item.id === 'codex').command, '/opt/ai/bin/codex');
  assert.equal(presets.find((item) => item.id === 'python').command, '/usr/bin/python3');
  assert.equal(presets.find((item) => item.id === 'powershell').command, '/usr/bin/pwsh');
  assert.equal(presets.find((item) => item.id === 'wsl').available, false);
});

test('Windows process output exposes only validated provider labels, PID and timestamps', async () => {
  let invocation;
  const environment = windowsEnvironment([WINDOWS_SHELL], {
    run: async (...args) => {
      invocation = args;
      return { stdout: JSON.stringify([
        { pid: 45, name: 'codex', startedAt: '2026-09-08T16:00:00Z', command: 'secret prompt', CommandLine: 'secret-token' },
        { pid: 18, name: 'claude', startedAt: null },
        { pid: 45, name: 'codex', startedAt: '2026-09-08T16:00:00Z' },
        { pid: 0, name: 'gemini' },
        { pid: 99, name: 'private-token' },
      ]) };
    },
  });
  const result = await environment.discoverProcesses();
  assert.deepEqual(result, { processes: [
    { pid: 18, name: 'Claude', command: 'claude', startedAt: null },
    { pid: 45, name: 'Codex', command: 'codex', startedAt: '2026-09-08T16:00:00.000Z' },
  ] });
  assert.equal(invocation[2].timeout, 10_000);
  assert.match(invocation[1].at(-1), /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(JSON.stringify(result), /secret|token|prompt/);
});

test('the Windows collector parses node wrapper paths without exposing or matching prompt arguments', { skip: process.platform !== 'win32' }, async () => {
  const fixture = `
function Get-CimInstance {
  [pscustomobject]@{ ProcessId=100; Name='node.exe'; CommandLine='"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" --prompt secret'; CreationDate=[datetime]'2026-09-08T16:00:00Z' }
  [pscustomobject]@{ ProcessId=101; Name='node.exe'; CommandLine='node.exe "C:\\work\\server.js" --prompt "C:\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"'; CreationDate=$null }
}
`;
  const environment = createEnvironment({
    run: async (command, args, options) => promisify(execFile)(command, [...args.slice(0, -1), fixture + args.at(-1)], options),
  });
  const result = await environment.discoverProcesses();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.processes.map(({ pid, command }) => ({ pid, command })), [{ pid: 100, command: 'codex' }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|--prompt/);
});

test('Unix discovery recognizes native and npm-wrapped AI CLIs but not arbitrary prompt mentions', async () => {
  let invocation;
  const environment = createEnvironment({
    platform: 'linux', env: { PATH: '/usr/bin' }, homeDirectory: '/home/tester',
    run: async (...args) => {
      invocation = args;
      return { stdout: [
        ' 12 Tue Sep  8 16:00:00 2026 codex /bin/codex --prompt secret',
        ' 13 Tue Sep  8 16:00:00 2026 node /bin/node /home/tester/node_modules/@google/gemini-cli/dist/index.js --token secret',
        ' 14 Tue Sep  8 16:00:00 2026 node /bin/node server.js "please explain codex"',
        ' 15 Tue Sep  8 16:00:00 2026 python python script.py --model gemini',
        ' 16 Tue Sep  8 16:00:00 2026 node /bin/node server.js --prompt "/tmp/node_modules/@google/gemini-cli/dist/index.js"',
        'malformed data',
      ].join('\n') };
    },
  });
  const result = await environment.discoverProcesses();
  assert.deepEqual(result.processes.map(({ pid, name, command }) => ({ pid, name, command })), [
    { pid: 12, name: 'Codex', command: 'codex' },
    { pid: 13, name: 'Gemini', command: 'gemini' },
  ]);
  assert.match(result.processes[0].startedAt, /^2026-09-08T/);
  assert.doesNotMatch(JSON.stringify(result), /secret|node_modules|--prompt/);
  assert.equal(invocation[0], 'ps');
  assert.equal(invocation[2].env.LC_ALL, 'C');
});

test('process failures and timeouts return safe actionable errors', async () => {
  for (const [error, expected] of [
    [new Error('secret stderr'), /읽지 못했습니다/],
    [Object.assign(new Error('secret stderr'), { killed: true }), /시간이 초과/],
  ]) {
    const environment = createEnvironment({ platform: 'linux', run: async () => { throw error; } });
    const result = await environment.discoverProcesses();
    assert.deepEqual(result.processes, []);
    assert.match(result.error, expected);
    assert.doesNotMatch(result.error, /secret/);
  }
});

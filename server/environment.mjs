import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const PROVIDERS = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama' };
const COMMAND_TIMEOUT = 10_000;

// Command lines are inspected inside the collector, but never emitted from it.
const WINDOWS_PROCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$observed = @(foreach ($item in Get-CimInstance Win32_Process -ErrorAction Stop) {
  $provider = $null
  if ($item.Name -match '^(codex|claude|gemini|ollama)(?:\\.exe)?$') {
    $provider = $Matches[1].ToLowerInvariant()
  } elseif ($item.Name -match '^node(?:\\.exe)?$') {
    $scriptPath = $null
    if ($item.CommandLine -match '^\\s*(?:"[^"]*"|\\S+)\\s+(?:(?:--[^\\s"]+)\\s+)*(?:"(?<script>[^"]+)"|(?<script>\\S+))') { $scriptPath = $Matches['script'] }
    if ($scriptPath -match '[/\\\\]@openai[/\\\\]codex[/\\\\].*\\.(?:m?js)$') { $provider = 'codex' }
    elseif ($scriptPath -match '[/\\\\]@anthropic-ai[/\\\\]claude-code[/\\\\].*\\.(?:m?js)$') { $provider = 'claude' }
    elseif ($scriptPath -match '[/\\\\]@google[/\\\\]gemini-cli[/\\\\].*\\.(?:m?js)$') { $provider = 'gemini' }
  }
  if ($provider) {
    $started = $null
    if ($item.CreationDate) { $started = $item.CreationDate.ToUniversalTime().ToString('o') }
    [pscustomobject]@{ pid = [int]$item.ProcessId; name = $provider; startedAt = $started }
  }
})
ConvertTo-Json -InputObject $observed -Compress
`;

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

async function fileCanRun(filename, platform) {
  try {
    if (!(await stat(filename)).isFile()) return false;
    await access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function identifyProvider(executable, commandLine = '') {
  const direct = executable.toLowerCase().replace(/\.exe$/, '');
  if (Object.hasOwn(PROVIDERS, direct)) return direct;
  if (direct !== 'node' && direct !== 'nodejs') return null;
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [];
  const script = (tokens.slice(1).find((token) => !token.startsWith('-')) || '').replace(/^(["'])(.*)\1$/, '$2');
  if (/[/\\]@openai[/\\]codex[/\\].*\.(?:m?js)$/i.test(script)) return 'codex';
  if (/[/\\]@anthropic-ai[/\\]claude-code[/\\].*\.(?:m?js)$/i.test(script)) return 'claude';
  if (/[/\\]@google[/\\]gemini-cli[/\\].*\.(?:m?js)$/i.test(script)) return 'gemini';
  return null;
}

function safeProcess(record) {
  const provider = typeof record?.name === 'string' ? record.name.toLowerCase() : '';
  const pid = Number(record?.pid);
  if (!Object.hasOwn(PROVIDERS, provider) || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const date = record.startedAt ? new Date(record.startedAt) : null;
  return {
    pid,
    name: PROVIDERS[provider],
    command: provider,
    startedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

function parseUnixProcesses(output) {
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const provider = identifyProvider(path.posix.basename(match[3]), match[4] || '');
    if (provider) records.push({ pid: match[1], name: provider, startedAt: match[2] });
  }
  return records;
}

/** Dependency injection keeps platform discovery testable without starting AI jobs. */
export function createEnvironment({
  platform = process.platform,
  env = process.env,
  homeDirectory = homedir(),
  isExecutable = (filename) => fileCanRun(filename, platform),
  run = execFile,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const windows = platform === 'win32';
  const systemRoot = environmentValue(env, 'SystemRoot') || 'C:\\Windows';
  const programFiles = environmentValue(env, 'ProgramFiles') || 'C:\\Program Files';
  const localAppData = environmentValue(env, 'LOCALAPPDATA') || paths.join(homeDirectory, 'AppData', 'Local');
  const appData = environmentValue(env, 'APPDATA') || paths.join(homeDirectory, 'AppData', 'Roaming');
  const pathDirectories = (environmentValue(env, 'PATH') || '').split(windows ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry && paths.isAbsolute(entry));
  const extraDirectories = windows ? [
    paths.join(homeDirectory, '.local', 'bin'),
    paths.join(appData, 'npm'),
    paths.join(homeDirectory, 'scoop', 'shims'),
    paths.join(homeDirectory, '.bun', 'bin'),
    paths.join(homeDirectory, '.cargo', 'bin'),
  ] : [
    paths.join(homeDirectory, '.local', 'bin'),
    paths.join(homeDirectory, '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
  const directories = [...new Set([...pathDirectories, ...extraDirectories])];

  async function findCommand(names, additionalFiles = [], { skipPythonAlias = false, nativeOnly = false } = {}) {
    const candidates = [];
    for (const name of names) {
      for (const directory of directories) {
        for (const extension of windows ? nativeOnly ? ['.exe', '.com'] : ['.exe', '.com', '.cmd', '.bat', '.ps1'] : ['']) {
          candidates.push(paths.join(directory, `${name}${extension}`));
        }
      }
    }
    candidates.push(...additionalFiles);
    for (const filename of [...new Set(candidates)]) {
      // Windows Store Python aliases may open the Store instead of an interpreter.
      if (skipPythonAlias && /[/\\]Microsoft[/\\]WindowsApps[/\\]python(?:3)?\.exe$/i.test(filename)) continue;
      if (await isExecutable(filename)) return filename;
    }
    return null;
  }

  async function findPowerShell() {
    return findCommand(['pwsh', 'powershell'], windows ? [
      paths.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ] : [], { nativeOnly: true });
  }

  function invocation(filename, shell, args = []) {
    if (windows && /\.(?:cmd|bat|ps1)$/i.test(filename)) {
      if (!shell) return null;
      return {
        command: shell,
        args: ['-NoLogo', '-NoExit', '-Command', `& ${[filename, ...args].map(quotePowerShell).join(' ')}`],
      };
    }
    return { command: filename, args };
  }

  async function getPresets() {
    const shell = await findPowerShell();
    const definitions = [
      { id: 'codex', name: 'Codex', names: ['codex'], description: 'Codex 대화형 코딩 세션', files: windows ? [paths.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')] : [] },
      { id: 'claude', name: 'Claude Code', names: ['claude'], description: 'Claude Code 대화형 코딩 세션' },
      { id: 'gemini', name: 'Gemini CLI', names: ['gemini'], description: 'Gemini CLI 대화형 코딩 세션' },
      { id: 'ollama', name: 'Ollama', names: ['ollama'], description: '로컬 모델 CLI · 채팅하려면 인수에 run과 설치된 모델명을 추가하세요.', files: windows ? [paths.join(localAppData, 'Programs', 'Ollama', 'ollama.exe')] : [] },
      { id: 'powershell', name: 'PowerShell', names: windows ? ['powershell'] : ['pwsh'], description: 'PowerShell 터미널', resolved: shell, args: ['-NoLogo'] },
      { id: 'python', name: 'Python', names: windows ? ['python', 'python3'] : ['python3', 'python'], description: 'Python 대화형 인터프리터', files: windows ? [paths.join(homeDirectory, 'anaconda3', 'python.exe'), paths.join(homeDirectory, 'miniconda3', 'python.exe')] : [], skipPythonAlias: true },
      { id: 'wsl', name: 'WSL', names: ['wsl'], description: '기본 WSL 배포판 터미널', files: windows ? [paths.join(systemRoot, 'System32', 'wsl.exe')] : [] },
    ];
    return Promise.all(definitions.map(async (definition) => {
      const filename = definition.id === 'powershell' ? definition.resolved
        : definition.id === 'wsl' && !windows ? null
          : await findCommand(definition.names, definition.files, definition);
      const launch = filename ? invocation(filename, shell, definition.args || []) : null;
      let available = Boolean(launch);
      let description = definition.description;
      if (!filename) description += ' · 설치된 명령을 찾지 못했습니다.';
      else if (!launch) description += ' · 스크립트 실행에 필요한 PowerShell을 찾지 못했습니다.';
      else if (definition.id === 'wsl') {
        try {
          const { stdout } = await run(filename, ['--list', '--quiet'], { timeout: COMMAND_TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' });
          available = Boolean(stdout.replace(/\0|\uFEFF/g, '').trim());
          if (!available) description += ' · 설치된 배포판이 없습니다.';
        } catch {
          available = false;
          description += ' · WSL 또는 설치된 배포판을 사용할 수 없습니다.';
        }
      }
      return {
        id: definition.id,
        name: definition.name,
        command: launch?.command || filename || definition.names[0],
        args: launch?.args || definition.args || [],
        cwd: homeDirectory,
        available,
        description,
      };
    }));
  }

  async function discoverProcesses() {
    try {
      let records;
      const options = { timeout: COMMAND_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
      if (windows) {
        const shell = await findPowerShell();
        if (!shell) return { processes: [], error: '프로세스 조회에 필요한 PowerShell을 찾지 못했습니다.' };
        const { stdout } = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT], options);
        const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
        records = Array.isArray(parsed) ? parsed : [parsed];
      } else {
        const { stdout } = await run('ps', ['-eo', 'pid=,lstart=,comm=,args='], { ...options, env: { ...env, LC_ALL: 'C' } });
        records = parseUnixProcesses(stdout);
      }
      const unique = new Map();
      for (const record of records) {
        const processRecord = safeProcess(record);
        if (processRecord) unique.set(processRecord.pid, processRecord);
      }
      return { processes: [...unique.values()].sort((a, b) => a.pid - b.pid) };
    } catch (error) {
      const timedOut = error?.killed || error?.code === 'ETIMEDOUT' || error?.code === 'ERR_CHILD_PROCESS_TIMEOUT';
      return { processes: [], error: timedOut ? '외부 프로세스 조회 시간이 초과되었습니다.' : '외부 프로세스 목록을 읽지 못했습니다.' };
    }
  }

  return { getPresets, discoverProcesses };
}

const environment = createEnvironment();
export const getPresets = environment.getPresets;
export const discoverProcesses = environment.discoverProcesses;

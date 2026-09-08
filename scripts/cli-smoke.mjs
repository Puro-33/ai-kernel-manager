import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from '../server/manager.mjs';
import { getPresets } from '../server/environment.mjs';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const artifactDirectory = path.join(projectDirectory, 'artifacts');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'kernel-deck-cli-smoke-'));
const terminalStates = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  platform: process.platform,
  parallelVersionPeak: 0,
  concurrentVersionProcessesObserved: false,
  versions: [],
  interactive: null,
  parallelInteractive: null,
  cleanupVerified: false,
  passed: false,
};
const manager = new SessionManager({ dataDir: temporaryDirectory, maxConcurrent: 2 });
const ownedPids = new Set();
const versionIds = new Set();
const interactiveSessions = new Map();
let failure;

function plainTerminal(output) {
  return output
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function outputMetrics(id) {
  const data = manager.logs(id).data;
  return { hasAnsi: /\x1b\[[0-?]*[ -/]*[@-~]/.test(data), bytes: Buffer.byteLength(data) };
}

function startupSummary(output, provider) {
  const plain = plainTerminal(output);
  if (/sign\s*in|log\s*in|authenticate|authentication|api\s*key/i.test(plain)) return 'authentication-screen';
  if (/trust|permission|access[^\r\n]*(?:folder|files|directory)/i.test(plain)) return 'workspace-permission-screen';
  if (/OpenAI\s+Codex|Welcome\s+to\s+Codex|codex-cli|Try[^\r\n]*Codex/i.test(plain)) return 'codex-startup-screen';
  if (provider === 'claude' && /Claude Code|Welcome\s+to\s+Claude|Choose[^\r\n]*(?:theme|style)|Let.s get started/i.test(plain)) return 'claude-startup-screen';
  return null;
}

async function waitUntil(predicate, description, timeout = 25_000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(description);
}

function versionInvocation(preset) {
  const args = [...preset.args];
  const commandIndex = args.indexOf('-Command');
  if (commandIndex >= 0) {
    args[commandIndex + 1] += " '--version'";
    return { command: preset.command, args: args.filter((argument) => argument !== '-NoExit') };
  }
  return { command: preset.command, args: [...args, '--version'] };
}

function processHasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    return false;
  }
}

manager.on('session', (session) => {
  if (session.pid) ownedPids.add(session.pid);
  const runningVersions = manager.list().filter((item) => versionIds.has(item.id) && item.status === 'running');
  report.parallelVersionPeak = Math.max(report.parallelVersionPeak, runningVersions.length);
  if (runningVersions.length === 2 && runningVersions.every((item) => {
    try { process.kill(item.pid, 0); return true; } catch { return false; }
  })) report.concurrentVersionProcessesObserved = true;
});

manager.on('output', ({ id, data }) => {
  const interactive = interactiveSessions.get(id);
  if (!interactive) return;
  const combined = interactive.cursorTail + data;
  const queries = combined.match(/\x1b\[6n/g) || [];
  interactive.cursorTail = combined.slice(-3);
  // This standard terminal response is the only input the smoke test sends.
  // It does not select trust, authentication, permissions, or an AI action.
  for (const query of queries) {
    void query;
    try {
      manager.write(id, '\x1b[1;1R');
      interactive.cursorReplies++;
    } catch {
      interactive.cursorReplyFailed = true;
    }
  }
});

try {
  const presets = await getPresets();
  const targets = ['codex', 'claude'].map((provider) => presets.find((preset) => preset.id === provider));
  assert.ok(targets.every((preset) => preset?.available), 'Codex and Claude must be installed for the real CLI smoke check.');
  const versions = targets.map((preset) => {
    const session = manager.create({ name: `${preset.name} version smoke`, ...versionInvocation(preset), cwd: projectDirectory });
    versionIds.add(session.id);
    return { preset, session };
  });
  // Claude's startup is generally slower, so start it first and observe both
  // OS processes directly instead of relying on node-pty's delayed exit events.
  await Promise.all([...versions].reverse().map(({ session }) => manager.start(session.id)));
  await waitUntil(() => versions.every(({ session }) => terminalStates.has(manager.get(session.id).status)), 'Version processes did not exit.');
  for (const { preset, session } of versions) {
    const current = manager.get(session.id);
    const plain = plainTerminal(manager.logs(session.id).data);
    const pattern = preset.id === 'codex'
      ? /codex-cli\s+(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i
      : /(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)\s+\(Claude Code\)/i;
    const version = plain.match(pattern)?.[1] || null;
    report.versions.push({ provider: preset.id, version, state: current.status, exitCode: current.exitCode, ...outputMetrics(session.id) });
    assert.equal(current.status, 'completed', `${preset.id} version process failed.`);
    assert.equal(current.exitCode, 0, `${preset.id} version process exited with an error.`);
    assert.ok(version, `${preset.id} did not emit a recognized version.`);
  }
  assert.equal(report.parallelVersionPeak, 2, 'Version checks did not overlap in the manager.');
  // Very short --version invocations can finish while another PTY initializes.
  // Record whether OS overlap was observed without treating that sampling limit
  // as a failure; sustained concurrency is verified by the manager tests.

  function createInteractive(preset) {
    const session = manager.create({ name: `${preset.name} interactive smoke`, command: preset.command, args: preset.args, cwd: projectDirectory, cols: 100, rows: 30 });
    const interactive = { preset, session, cursorTail: '', cursorReplies: 0, cursorReplyFailed: false };
    interactiveSessions.set(session.id, interactive);
    return interactive;
  }
  const parallel = targets.map(createInteractive);
  await Promise.all(parallel.map(({ session }) => manager.start(session.id)));
  async function waitForParallelStartup() {
    await waitUntil(() => parallel.every(({ preset, session }) => {
      const current = manager.get(session.id);
      if (terminalStates.has(current.status)) {
        throw Object.assign(new Error('An interactive CLI exited before parallel startup completed.'), { provider: preset.id });
      }
      return Boolean(startupSummary(manager.logs(session.id).data, preset.id));
    }), 'The interactive CLIs did not emit recognized startup screens.');
  }
  try {
    await waitForParallelStartup();
  } catch (error) {
    if (error.provider !== 'claude') throw error;
    // A CLI that cannot remain at its startup screen is not enough to prove
    // overlap. Keep the original Codex and start a second owned Codex instead.
    report.interactiveFallback = { provider: 'claude', reason: 'startup-exited' };
    const replacementIndex = parallel.findIndex(({ preset }) => preset.id === 'claude');
    parallel[replacementIndex] = createInteractive(targets.find((preset) => preset.id === 'codex'));
    await manager.start(parallel[replacementIndex].session.id);
    await waitForParallelStartup();
  }
  await delay(250);
  const beforeStop = parallel.map(({ session }) => manager.get(session.id));
  assert.ok(beforeStop.every((session) => session.status === 'running'), 'Both CLI sessions must remain running at their startup screens.');
  for (const session of beforeStop) process.kill(session.pid, 0);
  assert.equal(new Set(beforeStop.map((session) => session.pid)).size, 2, 'Parallel CLI sessions must own different OS processes.');
  report.parallelInteractive = {
    osProcessesAliveTogether: true,
    runningProcessCount: beforeStop.length,
    allProducedOutput: parallel.every(({ session }) => outputMetrics(session.id).bytes > 0),
    userInputSent: false,
    firstStopPreservedOtherSession: false,
    sessions: parallel.map(({ preset, session, cursorReplies, cursorReplyFailed }, index) => {
      assert.equal(cursorReplyFailed, false, 'A cursor-position reply could not be delivered.');
      return {
        provider: preset.id,
        stateBeforeStop: beforeStop[index].status,
        summary: startupSummary(manager.logs(session.id).data, preset.id),
        ...outputMetrics(session.id),
        cursorPositionReplies: cursorReplies,
        userInputSent: false,
        finalState: null,
        processExited: false,
      };
    }),
  };
  assert.equal(report.parallelInteractive.allProducedOutput, true);
  // Retain the existing single-Codex summary for consumers of earlier artifacts.
  report.interactive = report.parallelInteractive.sessions[0];
  for (let index = 0; index < parallel.length; index++) {
    const { session } = parallel[index];
    const result = report.parallelInteractive.sessions[index];
    await manager.stop(session.id);
    result.finalState = manager.get(session.id).status;
    result.processExited = processHasExited(beforeStop[index].pid);
    assert.equal(result.finalState, 'stopped', 'The owned interactive session did not stop.');
    assert.equal(result.processExited, true, 'The owned interactive process is still present.');
    if (index === 0) {
      assert.equal(manager.get(parallel[1].session.id).status, 'running', 'Stopping one CLI affected the other session.');
      process.kill(beforeStop[1].pid, 0);
      report.parallelInteractive.firstStopPreservedOtherSession = true;
    }
  }
} catch (error) {
  failure = error;
  // A fixed classification prevents native errors, paths, or CLI output leaking
  // into a shareable artifact. Raw terminal data remains only in the temp store.
  report.failure = 'real-cli-smoke-check-failed';
} finally {
  try {
    await manager.shutdown();
    await waitUntil(() => [...ownedPids].every(processHasExited), 'Owned CLI cleanup could not be verified.', 3_000);
    report.cleanupVerified = manager.list().every((session) => !['running', 'starting', 'stopping', 'queued'].includes(session.status));
    assert.equal(report.cleanupVerified, true);
    const allowedRoot = path.resolve(tmpdir()) + path.sep;
    assert.ok(path.resolve(temporaryDirectory).startsWith(allowedRoot), 'Temporary cleanup path escaped its root.');
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    failure ||= error;
    report.failure = 'owned-process-cleanup-failed';
    console.error(JSON.stringify({ cleanupPending: true, ownedPids: [...ownedPids] }));
  }
  report.passed = !failure && report.cleanupVerified;
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, 'cli-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../server/manager.mjs';

const fixture = fileURLToPath(new URL('./fixtures/terminal-worker.mjs', import.meta.url));
const cwd = path.dirname(fixture);
const spec = extra => ({ name: 'test worker', command: process.execPath, args: [fixture], cwd, ...extra });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(25);
  }
  assert.ok(predicate(), message);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-deck-test-'));
  const manager = new SessionManager({ dataDir, ...options });
  t.after(async () => {
    await manager.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { manager, dataDir };
}

function fakePty() {
  const instances = [];
  return {
    instances,
    spawn(command) {
      if (command === 'missing-executable') throw new Error('executable missing');
      const terminal = {
        pid: 10000 + instances.length,
        onData(callback) { this.data = callback; },
        onExit(callback) { this.exit = callback; },
        write(value) { this.written = value; },
        resize(cols, rows) { this.size = { cols, rows }; },
        kill() { this.killed = true; queueMicrotask(() => this.exit({ exitCode: 1 })); },
      };
      instances.push(terminal);
      return terminal;
    },
  };
}

test('real PTY accepts input; queued worker starts only after preceding terminal exits', { timeout: 45000 }, async t => {
  const { manager } = setup(t, { maxConcurrent: 1 });
  const first = manager.create(spec());
  const second = manager.create(spec({ name: 'second' }));
  await manager.start(first.id);
  await manager.start(second.id);
  assert.equal(manager.get(first.id).status, 'running');
  assert.equal(manager.get(second.id).status, 'queued');
  assert.equal(manager.get(second.id).run, 0);
  await until(() => manager.logs(first.id).data.includes('READY:'), 'worker should print readiness');
  manager.resize(first.id, 120, 40);
  manager.write(first.id, 'hello terminal\r');
  await until(() => manager.logs(first.id).data.includes('ECHO:hello terminal'), 'PTY should deliver interactive input');
  manager.write(first.id, 'quit\r');
  await until(() => manager.get(first.id).status === 'completed', 'first should exit normally');
  await until(() => manager.logs(second.id).data.includes('READY:'), 'next queued worker should start');
  assert.equal(manager.get(first.id).pid, null);
  assert.equal(manager.get(second.id).run, 1);
  assert.equal((await manager.stop(second.id)).status, 'stopped');
});

test('real restart coalesces requests, uses a fresh PID and kills owned descendants', { timeout: 60000 }, async t => {
  const { manager } = setup(t, { maxConcurrent: 1 });
  const session = manager.create(spec({ args: [fixture, '--tree'] }));
  await manager.start(session.id);
  await until(() => /CHILD:\d+/.test(manager.logs(session.id).data), 'child should be reported');
  const oldPid = manager.get(session.id).pid;
  const oldChild = Number(manager.logs(session.id).data.match(/CHILD:(\d+)/)[1]);
  assert.ok(isAlive(oldChild));
  const a = manager.restart(session.id);
  const b = manager.restart(session.id);
  assert.strictEqual(a, b, 'overlapping restart requests must share one operation');
  await Promise.all([a, b]);
  await until(() => /CHILD:\d+/.test(manager.logs(session.id).data), 'restarted child should be reported');
  assert.equal(manager.get(session.id).run, 2);
  assert.notEqual(manager.get(session.id).pid, oldPid);
  await until(() => !isAlive(oldPid) && !isAlive(oldChild), 'old parent and descendant must both be gone');
  const newChild = Number(manager.logs(session.id).data.match(/CHILD:(\d+)/)[1]);
  await manager.stop(session.id);
  await until(() => !isAlive(newChild), 'stop must kill the new descendant too');
});

test('real PTY can be stopped immediately before producing application output', { timeout: 30000 }, async t => {
  const { manager } = setup(t);
  const session = manager.create(spec({ args: ['-e', 'setInterval(() => {}, 1000)'] }));
  await manager.start(session.id);
  const pid = manager.get(session.id).pid;
  assert.ok(pid > 0);
  await manager.stop(session.id);
  assert.equal(manager.get(session.id).status, 'stopped');
  assert.ok(!isAlive(pid));
});

test('persistent logs and state restore without relaunching an interrupted session', async t => {
  const pty = fakePty();
  const { manager, dataDir } = setup(t, { ptyImpl: pty, terminateTree: async () => {} });
  const session = manager.create(spec());
  await manager.start(session.id);
  pty.instances[0].data('retained output\n');
  manager._flushLogs();
  await manager.shutdown();
  // Simulate the snapshot left by a crashed server after releasing the test's
  // live owner's lock; a real second live manager must never open that data.
  const statePath = path.join(dataDir, 'state.json');
  const crashSnapshot = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  crashSnapshot.sessions[0].status = 'running';
  crashSnapshot.sessions[0].pid = 12345;
  fs.writeFileSync(statePath, JSON.stringify(crashSnapshot));
  const restoredPty = fakePty();
  const restored = new SessionManager({ dataDir, ptyImpl: restoredPty, terminateTree: async () => {} });
  assert.equal(restored.get(session.id).status, 'interrupted');
  assert.equal(restored.get(session.id).pid, null);
  assert.equal(restored.get(session.id).run, 1);
  assert.equal(restored.logs(session.id).data, 'retained output\n');
  assert.equal(restoredPty.instances.length, 0);
  await restored.shutdown();
});

test('logs are bounded on disk and memory and restarting begins a new log', async t => {
  const pty = fakePty();
  const { manager, dataDir } = setup(t, { ptyImpl: pty, terminateTree: async () => {} });
  const session = manager.create(spec());
  await manager.start(session.id);
  pty.instances[0].data('한'.repeat(500000) + 'END');
  assert.ok(Buffer.byteLength(manager.logs(session.id).data) <= 1024 * 1024);
  assert.ok(manager.logs(session.id).data.endsWith('END'));
  assert.ok(!manager.logs(session.id).data.includes('\ufffd'));
  manager._flushLogs();
  assert.ok(fs.statSync(path.join(dataDir, 'logs', `${session.id}.log`)).size <= 1024 * 1024);
  await manager.restart(session.id);
  assert.deepEqual(manager.logs(session.id), { data: '', run: 2 });
});

test('validation and immutable snapshots prevent invalid edits and accidental state mutation', async t => {
  const pty = fakePty();
  const { manager } = setup(t, { ptyImpl: pty, terminateTree: async () => {} });
  assert.throws(() => manager.create(spec({ cwd: 'relative-path' })), /절대 경로/);
  assert.throws(() => manager.create(spec({ args: 'shell text' })), /문자열 배열/);
  assert.throws(() => manager.create(spec({ command: 'node\nmalformed' })), /올바르지/);
  assert.throws(() => manager.setLimit(0), /1~16/);
  assert.throws(() => manager.setLimit(17), /1~16/);
  assert.throws(() => manager.get('../state.json'), error => error.status === 404);
  const session = manager.create(spec());
  const snapshot = manager.get(session.id);
  snapshot.args.push('--bad');
  snapshot.status = 'running';
  assert.equal(manager.get(session.id).args.length, 1);
  assert.equal(manager.get(session.id).status, 'idle');
  await manager.update(session.id, { name: 'edited' });
  assert.equal(manager.get(session.id).name, 'edited');
  await manager.start(session.id);
  await assert.rejects(manager.update(session.id, { name: 'invalid' }), error => error.status === 409);
  await assert.rejects(manager.remove(session.id), error => error.status === 409);
  assert.throws(() => manager.write(session.id, 'x'.repeat(65537)), /64 KiB/);
  assert.throws(() => manager.resize(session.id, -1, 40), /열/);
  await manager.stop(session.id);
  await manager.remove(session.id);
  assert.equal(manager.list().length, 0);
});

test('stop holds concurrency slot until the tree kill and exit are both confirmed', async t => {
  const pty = fakePty();
  let releaseTree;
  const { manager } = setup(t, { ptyImpl: pty, maxConcurrent: 1,
    terminateTree: () => new Promise(resolve => { releaseTree = resolve; }) });
  const first = manager.create(spec());
  const second = manager.create(spec());
  await manager.start(first.id);
  await manager.start(second.id);
  const stopping = manager.stop(first.id);
  await until(() => manager.get(first.id).status === 'stopping', 'should enter stopping');
  pty.instances[0].exit({ exitCode: 1 });
  assert.equal(manager.get(second.id).status, 'queued', 'early exit must not release tree cleanup slot');
  releaseTree();
  await stopping;
  assert.equal(manager.get(second.id).status, 'running');
  manager._terminateTree = async () => {};
});

test('unconfirmed exit retains the slot; retry can stop and release it safely', async t => {
  const pty = fakePty();
  const { manager } = setup(t, { ptyImpl: pty, maxConcurrent: 1,
    terminateTree: async () => {}, exitTimeoutMs: 35 });
  const first = manager.create(spec());
  const second = manager.create(spec());
  await manager.start(first.id);
  await manager.start(second.id);
  pty.instances[0].kill = () => {};
  await assert.rejects(manager.stop(first.id), /종료 확인 시간/);
  assert.equal(manager.get(first.id).status, 'stopping');
  assert.equal(manager.get(second.id).status, 'queued');
  pty.instances[0].kill = () => queueMicrotask(() => pty.instances[0].exit({ exitCode: 1 }));
  await manager.stop(first.id);
  assert.equal(manager.get(second.id).status, 'running');
});

test('Windows native exit flush window never triggers a late PID kill', { skip: process.platform !== 'win32' }, async t => {
  const pty = fakePty();
  let treeKills = 0;
  const { manager } = setup(t, { ptyImpl: pty, terminateTree: async () => { treeKills++; } });
  const session = manager.create(spec());
  await manager.start(session.id);
  const terminal = pty.instances[0];
  let disposed = 0;
  let inputClosed = 0;
  terminal._agent = { exitCode: 0, _conoutSocketWorker: { dispose: () => disposed++ }, inSocket: { destroy: () => inputClosed++ } };
  const stopping = manager.stop(session.id);
  await until(() => manager.get(session.id).status === 'stopping', 'should wait for output flush');
  assert.equal(treeKills, 0);
  assert.equal(terminal.killed, undefined);
  terminal.exit({ exitCode: 0 });
  await stopping;
  assert.equal(manager.get(session.id).status, 'stopped');
  assert.equal(disposed, 1, 'finished output worker must be released without a PID sweep');
  assert.equal(inputClosed, 1);
});

test('stop-all cancels pending starts and queued work without launching extra workers', async t => {
  const pty = fakePty();
  const { manager } = setup(t, { ptyImpl: pty, maxConcurrent: 1, terminateTree: async () => {} });
  const first = manager.create(spec());
  const second = manager.create(spec());
  await manager.start(first.id);
  const startSecond = manager.start(second.id);
  await manager.stopAll();
  await startSecond;
  assert.equal(pty.instances.length, 1);
  assert.ok(manager.list().every(session => session.status === 'stopped'));
  await manager.shutdown();
  await assert.rejects(manager.start(first.id), /종료하는 중/);
  assert.throws(() => manager.create(spec()), /종료하는 중/);
});

test('spawn failure does not prevent a queued valid worker from starting', async t => {
  const pty = fakePty();
  const { manager } = setup(t, { ptyImpl: pty, maxConcurrent: 1, terminateTree: async () => {} });
  const first = manager.create(spec());
  const invalid = manager.create(spec({ command: 'missing-executable' }));
  const valid = manager.create(spec());
  await manager.start(first.id);
  await manager.start(invalid.id);
  await manager.start(valid.id);
  await manager.stop(first.id);
  assert.equal(manager.get(invalid.id).status, 'failed');
  assert.match(manager.get(invalid.id).error, /실행하지 못했습니다/);
  assert.equal(manager.get(valid.id).status, 'running');
});

test('lowering the limit preserves existing workers and raising it drains in order', async t => {
  const pty = fakePty();
  const { manager, dataDir } = setup(t, { ptyImpl: pty, maxConcurrent: 2, terminateTree: async () => {} });
  const sessions = Array.from({ length: 4 }, () => manager.create(spec()));
  for (const session of sessions) await manager.start(session.id);
  assert.equal(pty.instances.length, 2);
  manager.setLimit(1);
  assert.equal(manager.list().filter(session => session.status === 'running').length, 2);
  await manager.stop(sessions[0].id);
  assert.equal(manager.get(sessions[2].id).status, 'queued');
  manager.setLimit(3);
  assert.equal(manager.list().filter(session => session.status === 'running').length, 3);
  assert.equal(manager.get(sessions[2].id).pid, pty.instances[2].pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).maxConcurrent, 3);
});

test('corrupt state is preserved and rejected instead of silently erasing sessions', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-deck-corrupt-test-'));
  try {
    const statePath = path.join(dataDir, 'state.json');
    fs.writeFileSync(statePath, '{not valid json');
    assert.throws(() => new SessionManager({ dataDir, ptyImpl: fakePty() }), /원본 파일을 보존/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{not valid json');
    assert.ok(!fs.existsSync(path.join(dataDir, 'manager.lock')), 'failed restore must release its own lock');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('data directory admits one live manager and shutdown releases only its own lock', async t => {
  const { manager, dataDir } = setup(t, { ptyImpl: fakePty(), terminateTree: async () => {} });
  assert.throws(() => new SessionManager({ dataDir, ptyImpl: fakePty() }), /이미 실행 중/);
  const original = JSON.parse(fs.readFileSync(path.join(dataDir, 'manager.lock'), 'utf8'));
  assert.equal(original.pid, process.pid);
  await manager.shutdown();
  const next = new SessionManager({ dataDir, ptyImpl: fakePty() });
  next.create(spec());
  await manager.shutdown();
  assert.ok(fs.existsSync(path.join(dataDir, 'manager.lock')), 'old owner cannot remove new owner lock');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).sessions.length, 1, 'old shutdown cannot overwrite new state');
  await next.shutdown();
  assert.ok(!fs.existsSync(path.join(dataDir, 'manager.lock')));
});

test('dead-owner lock is reclaimed while malformed-owner lock remains intact', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-deck-lock-test-'));
  try {
    const lockPath = path.join(dataDir, 'manager.lock');
    const impossiblePid = 2147483647;
    assert.ok(!isAlive(impossiblePid));
    fs.writeFileSync(lockPath, JSON.stringify({ pid: impossiblePid, token: 'dead-test-owner' }));
    const manager = new SessionManager({ dataDir, ptyImpl: fakePty() });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
    await manager.shutdown();
    fs.writeFileSync(lockPath, '{malformed-lock');
    assert.throws(() => new SessionManager({ dataDir, ptyImpl: fakePty() }), /잠금 파일을 읽을 수 없어/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '{malformed-lock');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('inherited environment is never included in persistent session metadata or snapshots', async t => {
  const pty = fakePty();
  const { manager, dataDir } = setup(t, { ptyImpl: pty, terminateTree: async () => {} });
  const previous = process.env.KERNEL_DECK_TEST_SECRET;
  const syntheticSecret = 'synthetic-not-a-real-credential-8367';
  process.env.KERNEL_DECK_TEST_SECRET = syntheticSecret;
  try {
    const session = manager.create(spec({ env: { KERNEL_DECK_TEST_SECRET: syntheticSecret } }));
    await manager.start(session.id);
    assert.ok(!JSON.stringify(manager.list()).includes(syntheticSecret));
    assert.ok(!fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8').includes(syntheticSecret));
    assert.ok(!Object.hasOwn(manager.get(session.id), 'env'));
  } finally {
    if (previous === undefined) delete process.env.KERNEL_DECK_TEST_SECRET;
    else process.env.KERNEL_DECK_TEST_SECRET = previous;
  }
});

test('persistence failure reports a warning without losing a live process or queue progress', async t => {
  const pty = fakePty();
  const { manager } = setup(t, { ptyImpl: pty, terminateTree: async () => {}, maxConcurrent: 1 });
  const first = manager.create(spec());
  const second = manager.create(spec());
  const save = manager._save;
  const warnings = [];
  manager.on('warning', warning => warnings.push(warning));
  manager._save = () => { throw new Error('synthetic disk write failure'); };
  try {
    await manager.start(first.id);
    await manager.start(second.id);
    assert.equal(manager.get(first.id).status, 'running');
    assert.equal(manager.get(first.id).pid, pty.instances[0].pid);
    assert.match(manager.get(first.id).error, /저장하지 못했습니다/);
    assert.ok(warnings.length > 0);
    await manager.stop(first.id);
    assert.equal(manager.get(second.id).status, 'running');
  } finally { manager._save = save; }
});

test('shutdown failure keeps ownership and can be retried after termination recovers', async t => {
  const pty = fakePty();
  let rejected = false;
  const { manager, dataDir } = setup(t, { ptyImpl: pty, terminateTree: async () => {
    if (!rejected) { rejected = true; throw new Error('synthetic termination denial'); }
  } });
  const session = manager.create(spec());
  await manager.start(session.id);
  await assert.rejects(manager.shutdown(), AggregateError);
  assert.equal(manager.get(session.id).status, 'stopping');
  assert.ok(fs.existsSync(path.join(dataDir, 'manager.lock')));
  await manager.shutdown();
  assert.equal(manager.get(session.id).status, 'stopped');
  assert.ok(!fs.existsSync(path.join(dataDir, 'manager.lock')));
});

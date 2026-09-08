import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ACTIVE = new Set(['queued', 'starting', 'running', 'stopping']);
const STATES = new Set(['idle', ...ACTIVE, 'completed', 'failed', 'stopped', 'interrupted']);
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_SESSIONS = 256;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw fail(`${label}: ${min}~${max} 사이의 정수가 필요합니다.`);
  }
  return value;
}

function text(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail(`${label} 값이 올바르지 않습니다.`);
  }
  const result = value.trim();
  if (!empty && !result) throw fail(`${label}을(를) 입력하세요.`);
  return result;
}

function specOf(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw fail('세션 설정이 필요합니다.');
  const command = text(spec.command, '실행 명령', 4096);
  const name = text(spec.name ?? path.basename(command), '세션 이름', 120);
  const cwd = text(spec.cwd, '작업 폴더', 4096);
  if (!path.isAbsolute(cwd)) throw fail('작업 폴더는 절대 경로여야 합니다.');
  if (!Array.isArray(spec.args ?? []) || (spec.args ?? []).length > 128 ||
      (spec.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0'))) {
    throw fail('인수는 최대 128개의 문자열 배열이어야 합니다.');
  }
  return { name, command, args: [...(spec.args ?? [])], cwd: path.resolve(cwd),
    group: text(spec.group ?? '', '그룹', 80, { empty: true }),
    cols: integer(spec.cols ?? 100, 20, 500, '열'),
    rows: integer(spec.rows ?? 30, 5, 300, '행') };
}

function verifyDirectory(cwd) {
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch { throw fail(`작업 폴더를 찾거나 열 수 없습니다: ${cwd}`); }
}

function boundedLog(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= MAX_LOG_BYTES) return value;
  let start = bytes.length - MAX_LOG_BYTES;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

// node-pty 1.1.x flushes output for a second after the native process exits.
// Consult its native agent as well so that this flush window is never mistaken
// for permission to kill a PID belonging to an already finished process.
function nativeExitObserved(runtime) {
  return runtime.exited || (process.platform === 'win32' && runtime.terminal._agent?.exitCode !== undefined);
}

function ownerIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw fail('기존 관리 잠금의 소유자를 확인할 수 없습니다. 잠금 파일을 보존했습니다.', 409);
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw fail('기존 관리 프로그램의 실행 여부를 확인할 권한이 없습니다. 잠금 파일을 보존했습니다.', 409);
  }
}

/** Kill only a currently owned PTY. The caller retains its slot until onExit. */
function killWindowsTree(runtime) {
  return new Promise((resolve, reject) => {
    if (nativeExitObserved(runtime)) { resolve(true); return; }
    if (!Number.isInteger(runtime.pid) || runtime.pid <= 0 || runtime.pid !== runtime.terminal.pid) {
      reject(fail('소유한 프로세스의 PID를 확인하지 못해 종료하지 않았습니다.', 500));
      return;
    }
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(runtime.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error) => {
        // A process that ended naturally while taskkill started is already closed.
        if (error && !nativeExitObserved(runtime)) reject(fail('프로세스 트리 종료에 실패했습니다. 다시 중지해 주세요.', 500));
        else resolve(true);
      });
  });
}

export class SessionManager extends EventEmitter {
  constructor({ dataDir, maxConcurrent = 4, ptyImpl, terminateTree, exitTimeoutMs = 12000 } = {}) {
    super();
    if (!dataDir || !path.isAbsolute(dataDir)) throw fail('dataDir은 절대 경로여야 합니다.');
    this.dataDir = dataDir;
    this.maxConcurrent = integer(maxConcurrent, 1, 16, '동시 실행 수');
    this._pty = ptyImpl ?? require('node-pty');
    this._terminateTree = terminateTree ?? (process.platform === 'win32' ? killWindowsTree : async runtime => {
      if (runtime.exited) return true;
      try { process.kill(-runtime.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      return true;
    });
    this._exitTimeoutMs = exitTimeoutMs;
    this._sessions = new Map();
    this._logs = new Map();
    this._runtime = new Map();
    this._queue = [];
    this._operations = new Map();
    this._restarts = new Map();
    this._dirtyLogs = new Set();
    this._paused = 0;
    this._closed = false;
    this._logDir = path.join(dataDir, 'logs');
    this._statePath = path.join(dataDir, 'state.json');
    this._lockPath = path.join(dataDir, 'manager.lock');
    fs.mkdirSync(this._logDir, { recursive: true, mode: 0o700 });
    this._acquireLock();
    try { this._restore(); }
    catch (error) { this._releaseLock(); throw error; }
  }

  _acquireLock() {
    const token = randomUUID();
    const record = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });
    const claim = () => {
      const descriptor = fs.openSync(this._lockPath, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, record); }
      finally { fs.closeSync(descriptor); }
      this._lockToken = token;
    };
    try { claim(); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Only one stale-lock recovery may run at a time. A contender must never
    // unlink a new owner's lock after observing an older dead owner.
    const recoveryPath = `${this._lockPath}.recovery`;
    let recovery;
    try { recovery = fs.openSync(recoveryPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail('다른 관리 프로그램이 데이터 잠금을 확인 중입니다. 잠시 후 다시 실행하세요.', 409);
      throw error;
    }
    try {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(this._lockPath, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') { claim(); return; }
        throw fail('기존 관리 잠금 파일을 읽을 수 없어 보존했습니다.', 409);
      }
      if (ownerIsAlive(previous.pid)) throw fail('같은 데이터 폴더를 사용하는 관리 프로그램이 이미 실행 중입니다.', 409);
      fs.unlinkSync(this._lockPath);
      try { claim(); }
      catch (error) {
        if (error.code === 'EEXIST') throw fail('다른 관리 프로그램이 데이터 폴더를 먼저 열었습니다.', 409);
        throw error;
      }
    } finally {
      fs.closeSync(recovery);
      fs.unlinkSync(recoveryPath);
    }
  }

  _releaseLock() {
    if (!this._lockToken) return;
    try {
      const current = JSON.parse(fs.readFileSync(this._lockPath, 'utf8'));
      if (current.token === this._lockToken && current.pid === process.pid) fs.unlinkSync(this._lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this._lockToken = undefined;
  }

  _restore() {
    if (!fs.existsSync(this._statePath)) { this._save(); return; }
    let state;
    try {
      if (fs.statSync(this._statePath).size > 8 * 1024 * 1024) throw new Error('state is too large');
      state = JSON.parse(fs.readFileSync(this._statePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.length > MAX_SESSIONS) {
        throw new Error('unsupported state format');
      }
      this.maxConcurrent = integer(state.maxConcurrent, 1, 16, '저장된 동시 실행 수');
      for (const saved of state.sessions) {
        if (!UUID.test(saved.id) || this._sessions.has(saved.id) || !STATES.has(saved.status)) throw new Error('invalid session');
        const session = { ...specOf(saved), id: saved.id, createdAt: saved.createdAt,
          startedAt: saved.startedAt ?? null, endedAt: saved.endedAt ?? null,
          pid: null, exitCode: Number.isInteger(saved.exitCode) ? saved.exitCode : null,
          error: typeof saved.error === 'string' ? saved.error.slice(0, 1000) : null,
          run: integer(saved.run, 0, Number.MAX_SAFE_INTEGER, '저장된 실행 번호'), status: saved.status };
        if (ACTIVE.has(session.status)) {
          session.status = 'interrupted';
          session.endedAt = new Date().toISOString();
          session.error = '관리 프로그램이 재시작되어 이전 실행과의 연결이 끊겼습니다. 자동 재실행하지 않았습니다.';
        }
        this._sessions.set(session.id, session);
        const logfile = this._logPath(session.id);
        let log = '';
        if (fs.existsSync(logfile)) {
          const file = fs.openSync(logfile, 'r');
          try {
            const size = fs.fstatSync(file).size;
            const bytes = Buffer.alloc(Math.min(size, MAX_LOG_BYTES));
            fs.readSync(file, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
            log = boundedLog(bytes.toString('utf8'));
          } finally { fs.closeSync(file); }
        }
        this._logs.set(session.id, log);
      }
    } catch (error) {
      throw fail(`저장된 세션을 읽을 수 없습니다. 원본 파일을 보존했습니다: ${this._statePath} (${error.message})`, 500);
    }
    this._save();
  }

  _logPath(id) { return path.join(this._logDir, `${id}.log`); }
  _save() {
    const temporary = `${this._statePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, maxConcurrent: this.maxConcurrent,
      sessions: [...this._sessions.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this._statePath);
  }
  _flushLogs() {
    clearTimeout(this._logTimer);
    this._logTimer = undefined;
    for (const id of this._dirtyLogs) {
      if (this._sessions.has(id)) fs.writeFileSync(this._logPath(id), this._logs.get(id) ?? '', { mode: 0o600 });
      this._dirtyLogs.delete(id);
    }
  }
  _dirtyLog(id) {
    this._dirtyLogs.add(id);
    this._logTimer ??= setTimeout(() => {
      try { this._flushLogs(); }
      catch (error) { this.emit('warning', { error: `터미널 기록 저장 실패: ${error.message}` }); }
    }, 200).unref();
  }
  _require(id) {
    const session = this._sessions.get(id);
    if (!session) throw fail('세션을 찾을 수 없습니다.', 404);
    return session;
  }
  _open() { if (this._closed) throw fail('관리 프로그램을 종료하는 중입니다.', 409); }
  _publish(session) {
    try { this._save(); }
    catch (error) {
      // A disk failure must not turn a successfully spawned, still-owned PTY
      // into an apparently failed session or hide it from connected clients.
      session.error = `세션 상태를 저장하지 못했습니다: ${error.message}`;
      this.emit('warning', { id: session.id, error: session.error });
    }
    this.emit('session', this.get(session.id));
  }
  _safeFlushLogs(session) {
    try { this._flushLogs(); }
    catch (error) {
      session.error = `터미널 기록을 저장하지 못했습니다: ${error.message}`;
      this.emit('warning', { id: session.id, error: session.error });
      this.emit('session', this.get(session.id));
    }
  }
  _serialize(id, operation) {
    const before = this._operations.get(id) ?? Promise.resolve();
    const current = before.catch(() => {}).then(operation);
    this._operations.set(id, current);
    current.finally(() => { if (this._operations.get(id) === current) this._operations.delete(id); }).catch(() => {});
    return current;
  }
  list() { return [...this._sessions.values()].map(session => ({ ...session, args: [...session.args] })); }
  get(id) { const session = this._require(id); return { ...session, args: [...session.args] }; }
  logs(id) { return { data: this._logs.get(this._require(id).id) ?? '', run: this._require(id).run }; }

  create(spec) {
    this._open();
    if (this._sessions.size >= MAX_SESSIONS) throw fail(`세션은 최대 ${MAX_SESSIONS}개까지 만들 수 있습니다.`);
    const values = specOf(spec);
    verifyDirectory(values.cwd);
    const session = { ...values, id: randomUUID(), status: 'idle', createdAt: new Date().toISOString(),
      startedAt: null, endedAt: null, pid: null, exitCode: null, error: null, run: 0 };
    this._sessions.set(session.id, session);
    this._logs.set(session.id, '');
    this._publish(session);
    return this.get(session.id);
  }
  update(id, spec) {
    return this._serialize(id, () => {
      this._open();
      const session = this._require(id);
      if (ACTIVE.has(session.status)) throw fail('세션을 중지한 뒤 설정을 변경하세요.', 409);
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw fail('세션 설정이 필요합니다.');
      const values = specOf({ ...session, ...spec });
      verifyDirectory(values.cwd);
      Object.assign(session, values);
      this._publish(session);
      return this.get(id);
    });
  }
  start(id) {
    return this._serialize(id, () => { this._open(); this._enqueue(id); return this.get(id); });
  }
  _enqueue(id) {
    const session = this._require(id);
    if (ACTIVE.has(session.status)) return;
    session.status = 'queued';
    session.error = null;
    session.exitCode = null;
    session.endedAt = null;
    this._queue.push(id);
    this._publish(session);
    this._drain();
  }
  _drain() {
    if (this._closed || this._paused) return;
    while (this._runtime.size < this.maxConcurrent && this._queue.length) {
      const id = this._queue.shift();
      const session = this._sessions.get(id);
      if (session?.status === 'queued') this._launch(session);
    }
  }
  _launch(session) {
    session.status = 'starting';
    session.run++;
    session.startedAt = new Date().toISOString();
    session.endedAt = null;
    session.pid = null;
    session.error = null;
    this._logs.set(session.id, '');
    this._dirtyLog(session.id);
    this._publish(session);
    try {
      verifyDirectory(session.cwd);
      if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(session.command)) {
        throw fail('Windows 스크립트는 설치된 CLI 프리셋을 선택하거나 powershell.exe의 인수로 지정하세요.');
      }
      const terminal = this._pty.spawn(session.command, session.args, {
        name: 'xterm-256color', cwd: session.cwd, cols: session.cols, rows: session.rows,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        useConpty: true, conptyInheritCursor: false,
      });
      const runtime = { terminal, pid: terminal.pid, run: session.run, exited: false,
        stopRequested: false, cleanupPending: false, finalized: false };
      runtime.exit = new Promise(resolve => { runtime.resolveExit = resolve; });
      this._runtime.set(session.id, runtime);
      session.pid = terminal.pid;
      session.status = 'running';
      terminal.onData(data => {
        if (this._runtime.get(session.id) !== runtime) return;
        this._logs.set(session.id, boundedLog((this._logs.get(session.id) ?? '') + data));
        this._dirtyLog(session.id);
        this.emit('output', { id: session.id, run: runtime.run, data });
      });
      terminal.onExit(({ exitCode, signal }) => {
        if (runtime.exited) return;
        runtime.exited = true;
        runtime.exitCode = exitCode;
        runtime.signal = signal;
        runtime.resolveExit();
        if (!runtime.cleanupPending) this._finalize(session, runtime);
      });
      this._publish(session);
    } catch (error) {
      session.status = 'failed';
      session.pid = null;
      session.endedAt = new Date().toISOString();
      session.error = `실행하지 못했습니다: ${error.message}`.slice(0, 1000);
      this._publish(session);
      this._safeFlushLogs(session);
    }
  }
  _finalize(session, runtime) {
    if (runtime.finalized || !runtime.exited || this._runtime.get(session.id) !== runtime) return;
    runtime.finalized = true;
    // node-pty 1.1.0 leaves its ConPTY output worker alive on a natural exit.
    // Release pipe resources directly after onExit has drained output. Calling
    // terminal.kill() here would start node-pty's delayed sweep of a stale PID.
    if (process.platform === 'win32') {
      runtime.terminal._agent?._conoutSocketWorker?.dispose();
      runtime.terminal._agent?.inSocket?.destroy();
    }
    this._runtime.delete(session.id);
    session.status = runtime.stopRequested ? 'stopped' : runtime.exitCode === 0 ? 'completed' : 'failed';
    session.exitCode = Number.isInteger(runtime.exitCode) ? runtime.exitCode : null;
    session.endedAt = new Date().toISOString();
    session.pid = null;
    if (!runtime.stopRequested && session.status === 'failed') {
      session.error = `프로세스가 종료 코드 ${runtime.exitCode ?? '?'}${runtime.signal ? ` (신호 ${runtime.signal})` : ''}로 끝났습니다.`;
    } else session.error = null;
    this._publish(session);
    this._safeFlushLogs(session);
    this._drain();
  }
  stop(id) { return this._serialize(id, () => this._stop(id)); }
  async _stop(id) {
    const session = this._require(id);
    if (session.status === 'queued') {
      this._queue = this._queue.filter(value => value !== id);
      session.status = 'stopped';
      session.endedAt = new Date().toISOString();
      session.pid = null;
      this._publish(session);
      return this.get(id);
    }
    const runtime = this._runtime.get(id);
    if (!runtime) return this.get(id);
    runtime.stopRequested = true;
    runtime.cleanupPending = true;
    session.status = 'stopping';
    this._publish(session);
    try {
      // Never delay a PID kill until after an observed exit, and never reuse old
      // runtime references for a later run. Windows must kill the tree first.
      let treeTerminated = false;
      if (!nativeExitObserved(runtime) && this._runtime.get(id) === runtime) treeTerminated = await this._terminateTree(runtime);
      // A successful OS tree termination needs only the real exit event. A
      // second pty.kill() would run node-pty's asynchronous stale-PID sweep.
      if (!nativeExitObserved(runtime) && treeTerminated !== true) runtime.terminal.kill();
      let timeout;
      try {
        await Promise.race([runtime.exit, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(fail('종료 확인 시간이 초과되었습니다. 실행 슬롯을 유지합니다. 다시 중지해 주세요.', 500)), this._exitTimeoutMs);
        })]);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      session.error = error.message;
      this._publish(session);
      throw error;
    } finally {
      runtime.cleanupPending = false;
      if (runtime.exited) this._finalize(session, runtime);
    }
    return this.get(id);
  }
  restart(id) {
    if (this._restarts.has(id)) return this._restarts.get(id);
    const operation = this._serialize(id, async () => {
      this._open();
      await this._stop(id);
      this._open();
      this._enqueue(id);
      return this.get(id);
    });
    this._restarts.set(id, operation);
    operation.finally(() => { if (this._restarts.get(id) === operation) this._restarts.delete(id); }).catch(() => {});
    return operation;
  }
  remove(id) {
    return this._serialize(id, () => {
      this._open();
      const session = this._require(id);
      if (ACTIVE.has(session.status)) throw fail('세션을 중지한 뒤 삭제하세요.', 409);
      this._sessions.delete(id);
      this._logs.delete(id);
      this._dirtyLogs.delete(id);
      this._save();
      fs.rmSync(this._logPath(id), { force: true });
      this.emit('deleted', { id });
    });
  }
  write(id, data) {
    this._open();
    const session = this._require(id);
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw fail('터미널 입력은 64 KiB 이하여야 합니다.');
    const runtime = this._runtime.get(id);
    if (session.status !== 'running' || !runtime || nativeExitObserved(runtime)) throw fail('실행 중인 터미널만 입력할 수 있습니다.', 409);
    runtime.terminal.write(data);
  }
  resize(id, cols, rows) {
    this._open();
    const session = this._require(id);
    integer(cols, 20, 500, '열');
    integer(rows, 5, 300, '행');
    if (session.cols === cols && session.rows === rows) return this.get(id);
    const runtime = this._runtime.get(id);
    if (runtime && session.status === 'running' && !nativeExitObserved(runtime)) runtime.terminal.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    this._save();
    return this.get(id);
  }
  setLimit(value) {
    this._open();
    this.maxConcurrent = integer(value, 1, 16, '동시 실행 수');
    this._save();
    this.emit('settings', { maxConcurrent: this.maxConcurrent });
    this._drain();
    return this.maxConcurrent;
  }
  async stopAll() {
    this._paused++;
    try {
      // Include accepted starts/restarts whose serialized operation has not run
      // yet. They can enqueue while paused, but cannot launch behind stop-all.
      await Promise.allSettled([...this._operations.values()]);
      const ids = this.list().filter(session => ACTIVE.has(session.status)).map(session => session.id);
      const results = await Promise.allSettled(ids.map(id => this.stop(id)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, `${errors.length}개 세션의 종료를 확인하지 못했습니다.`);
    } finally { this._paused--; this._drain(); }
  }
  shutdown() {
    if (this._shutdownComplete) return Promise.resolve();
    if (this._shutdownPromise) return this._shutdownPromise;
    this._closed = true;
    const operation = (async () => {
      try { await this.stopAll(); }
      finally {
        this._flushLogs();
        this._save();
        if (this._runtime.size === 0) {
          this._releaseLock();
          this._shutdownComplete = true;
        }
      }
    })();
    this._shutdownPromise = operation;
    operation.finally(() => { if (!this._shutdownComplete) this._shutdownPromise = undefined; }).catch(() => {});
    return operation;
  }
}

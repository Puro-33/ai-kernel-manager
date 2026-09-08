import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.mjs';

const fixture = fileURLToPath(new URL('./fixtures/terminal-worker.mjs', import.meta.url));
const workerSpec = extra => ({ name: 'API worker', command: process.execPath,
  args: [fixture], cwd: path.dirname(fixture), group: 'integration', ...extra });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  assert.ok(predicate(), label);
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-deck-http-test-'));
  const app = await createApp({ dataDir });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  let cookie;
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const request = (method, pathname, options = {}) => new Promise((resolve, reject) => {
    const raw = options.raw ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined);
    const headers = { Host: `127.0.0.1:${port}`,
      ...(cookie && options.auth !== false ? { Cookie: cookie } : {}),
      ...(raw !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}),
      ...options.headers };
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('HTTP test request timed out')));
    req.end(raw);
  });
  const login = async () => {
    const response = await request('GET', '/', { auth: false });
    assert.equal(response.status, 200, 'build dist/ before running HTTP integration tests');
    assert.ok(response.headers['set-cookie']?.[0]);
    cookie = response.headers['set-cookie'][0].split(';')[0];
    return response;
  };
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: origin } });
    sockets.add(ws);
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return {
      ws, messages,
      send: data => ws.send(JSON.stringify(data)),
      output: (id, run) => messages.filter(message => message.type === 'output' && message.id === id && (run === undefined || message.run === run)).map(message => message.data).join(''),
      wait: (predicate, label) => until(() => messages.some(predicate), label),
      close: async () => {
        if (ws.readyState === WebSocket.CLOSED) return;
        await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
      },
    };
  };
  return { app, dataDir, origin, request, login, connect };
}

test('HTTP and WebSocket enforce local host, session cookie, origin and JSON boundaries', { timeout: 60000 }, async t => {
  const { request, login, origin } = await setup(t);
  assert.equal((await request('GET', '/health', { auth: false })).status, 200);
  assert.equal((await request('GET', '/api/bootstrap', { auth: false })).status, 401);
  assert.equal((await request('POST', '/api/shutdown', { auth: false, json: {} })).status, 401);
  const page = await login();
  assert.match(page.headers['set-cookie'][0], /HttpOnly/);
  assert.match(page.headers['set-cookie'][0], /SameSite=Strict/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await request('GET', '/api/bootstrap', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request('GET', '/api/bootstrap', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await request('POST', '/api/sessions', { json: workerSpec(), headers: { 'Sec-Fetch-Site': site } })).status, 403);
  }
  assert.equal((await request('GET', '/api/bootstrap', { headers: { Cookie: `kernel_deck_session=${'a'.repeat(64)}` } })).status, 401);
  assert.equal((await request('GET', '/api/bootstrap', { headers: { Cookie: `kernel_deck_session=${'é'.repeat(64)}` } })).status, 401);
  assert.equal((await request('POST', '/api/sessions', { raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('POST', '/api/sessions', { raw: '{' })).status, 400);
  assert.equal((await request('POST', '/api/sessions', { json: [] })).status, 400);
  assert.equal((await request('POST', '/api/sessions', { json: workerSpec({ autoStart: 'false' }) })).status, 400);
  assert.equal((await request('GET', '/api/bootstrap')).data.sessions.length, 0, 'invalid autoStart must not create a session');
  assert.equal((await request('POST', '/api/sessions', { raw: JSON.stringify({ value: 'x'.repeat(65536) }) })).status, 413);
  const upgradedHeaders = {
    Connection: 'Upgrade', Upgrade: 'websocket',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
  };
  assert.equal((await request('GET', '/ws', { headers: upgradedHeaders })).status, 403, 'WebSocket requires an explicit matching Origin');
  assert.equal((await request('GET', '/ws', { auth: false, headers: { ...upgradedHeaders, Origin: origin } })).status, 403);
  assert.equal((await request('GET', '/ws', { headers: { ...upgradedHeaders, Origin: origin,
    Cookie: `kernel_deck_session=${'é'.repeat(64)}` } })).status, 403, 'malformed cookie must reject upgrade without crashing');
  const created = await request('POST', '/api/sessions', { json: workerSpec({ autoStart: false }), headers: { Origin: origin } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request('GET', `/api/sessions/${id}/start`)).status, 405);
  assert.equal((await request('POST', `/api/sessions/${id}/start`, { raw: '', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('GET', '/api/sessions/does-not-exist/log')).status, 404);
  const bootstrap = await request('GET', '/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.sessions.length, 1);
  assert.equal(bootstrap.data.sessions[0].status, 'idle', 'rejected mutation requests must not start a process');
  assert.ok(Array.isArray(bootstrap.data.presets));
});

test('real PTY lifecycle is reflected through REST, isolated subscriptions and reconnect replay', { timeout: 60000 }, async t => {
  const { request, login, connect } = await setup(t);
  await login();
  const created = await request('POST', '/api/sessions', { json: workerSpec() });
  assert.equal(created.status, 201);
  const first = created.data;
  assert.equal(first.status, 'idle');
  assert.deepEqual((await request('GET', `/api/sessions/${first.id}/log`)).data, { data: '', run: 0 });
  const firstClient = await connect();
  await firstClient.wait(message => message.type === 'snapshot' && message.sessions.some(session => session.id === first.id), 'initial snapshot should include saved session');
  firstClient.send({ type: 'subscribe', id: first.id });
  await firstClient.wait(message => message.type === 'replay' && message.id === first.id && message.run === 0, 'subscription starts with an empty replay');
  assert.equal((await request('POST', `/api/sessions/${first.id}/start`, { json: {} })).data.status, 'running');
  await until(() => firstClient.output(first.id, 1).includes('READY:'), 'first terminal readiness should stream over WS');
  firstClient.send({ type: 'input', id: first.id, data: 'FIRST-ONLY\r' });
  await until(() => firstClient.output(first.id, 1).includes('ECHO:FIRST-ONLY'), 'WS input should reach the real PTY');
  firstClient.send({ type: 'resize', id: first.id, cols: 120, rows: 40 });
  firstClient.send({ type: 'resize', id: first.id, cols: 19, rows: 4 });
  await firstClient.wait(message => message.type === 'error', 'invalid terminal size should be rejected');
  const second = (await request('POST', '/api/sessions', { json: workerSpec({ name: 'second API worker', autoStart: true }) })).data;
  const secondClient = await connect();
  secondClient.send({ type: 'subscribe', id: second.id });
  await secondClient.wait(message => message.type === 'replay' && message.id === second.id, 'second subscription has its own replay');
  secondClient.send({ type: 'input', id: second.id, data: 'SECOND-ONLY\r' });
  await until(() => secondClient.output(second.id, 1).includes('ECHO:SECOND-ONLY'), 'second input should reach its own terminal');
  assert.ok(!firstClient.messages.some(message => message.type === 'output' && message.id === second.id));
  assert.ok(!secondClient.messages.some(message => message.type === 'output' && message.id === first.id));
  const beforeReconnect = (await request('GET', '/api/bootstrap')).data.sessions.find(session => session.id === first.id);
  await firstClient.close();
  const reconnected = await connect();
  reconnected.send({ type: 'subscribe', id: first.id });
  await reconnected.wait(message => message.type === 'replay' && message.id === first.id && message.run === 1 && message.data.includes('ECHO:FIRST-ONLY'), 'reconnection should replay existing terminal output');
  const afterReconnect = (await request('GET', '/api/bootstrap')).data.sessions.find(session => session.id === first.id);
  assert.equal(afterReconnect.pid, beforeReconnect.pid, 'closing the browser connection must preserve the process');
  assert.equal(afterReconnect.run, 1);
  assert.equal(afterReconnect.cols, 120);
  assert.equal(afterReconnect.rows, 40);
  const log = await request('GET', `/api/sessions/${first.id}/log`);
  assert.equal(log.data.run, 1);
  assert.match(log.data.data, /ECHO:FIRST-ONLY/);
  const exported = await request('GET', `/api/sessions/${first.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], /attachment/);
  assert.match(exported.text, /ECHO:FIRST-ONLY/);
  assert.ok(!exported.text.includes('\x1b'));
  const restarted = await request('POST', `/api/sessions/${first.id}/restart`, { json: {} });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.data.run, 2);
  await until(() => reconnected.output(first.id, 2).includes('READY:'), 'new run should stream with run number 2');
  const freshLog = (await request('GET', `/api/sessions/${first.id}/log`)).data;
  assert.equal(freshLog.run, 2);
  assert.ok(!freshLog.data.includes('FIRST-ONLY'), 'restart should not replay a previous run as current output');
  assert.equal((await request('DELETE', `/api/sessions/${first.id}`, { json: {} })).status, 409);
  const stopped = await request('POST', `/api/sessions/${first.id}/stop`, { json: {} });
  assert.equal(stopped.data.status, 'stopped');
  await reconnected.wait(message => message.type === 'session' && message.session.id === first.id && message.session.status === 'stopped', 'stopped status should broadcast');
  assert.equal((await request('PATCH', `/api/sessions/${first.id}`, { json: { name: 'renamed session' } })).data.name, 'renamed session');
  assert.equal((await request('DELETE', `/api/sessions/${first.id}`, { json: {} })).status, 200);
  await reconnected.wait(message => message.type === 'deleted' && message.id === first.id, 'deletion should broadcast');
  assert.equal((await request('GET', `/api/sessions/${first.id}/log`)).status, 404);
  reconnected.send({ type: 'subscribe', id: first.id });
  await reconnected.wait(message => message.type === 'error', 'missing subscription should return an error');
  assert.equal((await request('POST', '/api/stop-all', { json: {} })).status, 200);
  assert.equal((await request('GET', '/api/bootstrap')).data.sessions[0].status, 'stopped');
});

test('REST settings control real concurrency and stop-all cancels queued work', { timeout: 45000 }, async t => {
  const { request, login, connect } = await setup(t);
  await login();
  const client = await connect();
  assert.equal((await request('PATCH', '/api/settings', { json: { maxConcurrent: 1 } })).data.maxConcurrent, 1);
  await client.wait(message => message.type === 'settings' && message.maxConcurrent === 1, 'settings should broadcast');
  const sessions = [];
  for (let index = 0; index < 3; index++) {
    const response = await request('POST', '/api/sessions', { json: workerSpec({ name: `queued ${index}`, autoStart: true }) });
    assert.equal(response.status, 201);
    sessions.push(response.data);
  }
  assert.deepEqual(sessions.map(session => session.status), ['running', 'queued', 'queued']);
  const before = (await request('GET', '/api/bootstrap')).data;
  assert.equal(before.settings.maxConcurrent, 1);
  assert.equal(before.sessions.filter(session => session.pid).length, 1);
  assert.equal((await request('PATCH', '/api/settings', { json: { maxConcurrent: 2 } })).status, 200);
  const expanded = (await request('GET', '/api/bootstrap')).data.sessions;
  assert.deepEqual(expanded.map(session => session.status), ['running', 'running', 'queued']);
  assert.equal((await request('PATCH', '/api/settings', { json: { maxConcurrent: 0 } })).status, 400);
  assert.equal((await request('PATCH', '/api/settings', { json: { maxConcurrent: 1 } })).status, 200);
  assert.equal((await request('GET', '/api/bootstrap')).data.sessions.filter(session => session.status === 'running').length, 2, 'lowering a limit does not kill active work');
  assert.equal((await request('POST', '/api/stop-all', { json: {} })).status, 200);
  const final = (await request('GET', '/api/bootstrap')).data.sessions;
  assert.ok(final.every(session => session.status === 'stopped' && session.pid === null));
  assert.equal(final[2].run, 0, 'cancelled queued worker must never have launched');
});

test('authenticated shutdown stops the owned process, cancels its queue and releases the data lock', { timeout: 30000 }, async t => {
  const { app, dataDir, request, login, connect } = await setup(t);
  await login();
  await request('PATCH', '/api/settings', { json: { maxConcurrent: 1 } });
  const running = (await request('POST', '/api/sessions', { json: workerSpec({ autoStart: true }) })).data;
  const queued = (await request('POST', '/api/sessions', { json: workerSpec({ name: 'never launched', autoStart: true }) })).data;
  const client = await connect();
  client.send({ type: 'subscribe', id: running.id });
  await until(() => app.manager.logs(running.id).data.includes('READY:'), 'worker should be live before shutdown');
  const response = await request('POST', '/api/shutdown', { json: {} });
  assert.equal(response.status, 202);
  await until(() => !app.server.listening, 'shutdown should close the HTTP listener');
  assert.equal(app.manager.get(running.id).status, 'stopped');
  assert.equal(app.manager.get(queued.id).status, 'stopped');
  assert.equal(app.manager.get(queued.id).run, 0);
  assert.ok(!fs.existsSync(path.join(dataDir, 'manager.lock')));
  assert.throws(() => process.kill(running.pid, 0), error => error.code === 'ESRCH');
});

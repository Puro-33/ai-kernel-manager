import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './manager.mjs';
import { getPresets, discoverProcesses } from './environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.0.0';
const cookieName = 'kernel_deck_session';
const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const body = async req => {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('JSON 형식으로 요청해 주세요.'), { statusCode: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('요청이 너무 큽니다.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw Object.assign(new Error('올바른 JSON 객체가 필요합니다.'), { statusCode: 400 }); }
};

export async function createApp({ dataDir = process.env.KERNEL_DECK_DATA_DIR || path.join(root, '.data'), manager: suppliedManager } = {}) {
  const manager = suppliedManager || new SessionManager({ dataDir });
  const secret = randomBytes(32).toString('hex');
  let closing = false;
  let presetCache;
  const presets = () => presetCache ||= getPresets().catch(error => { presetCache = null; throw error; });
  const authenticate = req => {
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='));
    const value = cookie?.slice(cookieName.length + 1) || '';
    return /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
  };
  const localRequest = req => {
    const port = server.address()?.port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host)) return false;
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
    return !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!localRequest(req)) return json(res, 403, { error: '이 컴퓨터의 관리 화면에서만 접근할 수 있습니다.' });
    if (closing) return json(res, 503, { error: '관리 서버가 종료 중입니다.' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { app: 'kernel-deck', version });
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const data = await readFile(path.join(root, 'dist', file));
        if (file === 'index.html') res.setHeader('Set-Cookie', `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(data);
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: '페이지가 없습니다.' });
      if (!authenticate(req)) return json(res, 401, { error: '관리 화면을 새로고침해 연결해 주세요.' });
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        return json(res, 200, { sessions: manager.list(), settings: { maxConcurrent: manager.maxConcurrent }, presets: await presets(), platform: process.platform, homeDirectory: os.homedir(), version });
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const spec = await body(req);
        if (spec.autoStart !== undefined && typeof spec.autoStart !== 'boolean') return json(res, 400, { error: 'autoStart는 true 또는 false여야 합니다.' });
        let session = await manager.create(spec);
        if (spec.autoStart) session = await manager.start(session.id);
        return json(res, 201, session);
      }
      if (url.pathname === '/api/settings' && req.method === 'PATCH') {
        await manager.setLimit((await body(req)).maxConcurrent);
        return json(res, 200, { maxConcurrent: manager.maxConcurrent });
      }
      if (url.pathname === '/api/stop-all' && req.method === 'POST') {
        await body(req);
        await manager.stopAll();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        await body(req);
        json(res, 202, { ok: true });
        setImmediate(() => close().catch(error => console.error('Shutdown failed:', error.message)));
        return;
      }
      if (url.pathname === '/api/processes' && req.method === 'GET') return json(res, 200, await discoverProcesses());
      const match = /^\/api\/sessions\/([a-zA-Z0-9-]+)(?:\/(start|stop|restart|log|export))?$/.exec(url.pathname);
      if (!match) return json(res, 404, { error: '요청 경로가 없습니다.' });
      const [, id, action] = match;
      const existing = manager.get(id);
      if (!existing) return json(res, 404, { error: '세션이 없습니다.' });
      if (req.method === 'GET' && ['log', 'export'].includes(action)) {
        const log = await manager.logs(id);
        if (action === 'log') return json(res, 200, log);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="kernel-deck-${id}.txt"`, 'Cache-Control': 'no-store' });
        return res.end(stripVTControlCharacters(log.data));
      }
      if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
        await body(req);
        return json(res, 200, await manager[action](id));
      }
      if (req.method === 'PATCH' && !action) return json(res, 200, await manager.update(id, await body(req)));
      if (req.method === 'DELETE' && !action) {
        await body(req);
        await manager.remove(id);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: '지원하지 않는 요청 방식입니다.' });
    } catch (error) {
      const code = error.statusCode || (error.code === 'ENOENT' ? 404 : 400);
      if (!res.headersSent) json(res, code, { error: error.message || '요청을 처리할 수 없습니다.' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (closing || req.url !== '/ws' || !localRequest(req) || !authenticate(req) || req.headers.origin !== `http://${req.headers.host}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (ws, message) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, 'Reconnect to restore terminal output');
    ws.send(JSON.stringify(message));
  };
  const broadcast = message => { for (const ws of wss.clients) send(ws, message); };
  const listeners = {
    warning: event => broadcast({ type: 'error', error: event.error || '기록을 저장하지 못했습니다.' }),
    session: session => broadcast({ type: 'session', session }),
    deleted: event => broadcast({ type: 'deleted', id: typeof event === 'string' ? event : event.id }),
    settings: settings => broadcast({ type: 'settings', ...settings }),
    output: event => { for (const ws of wss.clients) if (ws.subscriptions.has(event.id)) send(ws, { type: 'output', ...event }); }
  };
  for (const [event, handler] of Object.entries(listeners)) manager.on(event, handler);
  wss.on('connection', ws => {
    ws.subscriptions = new Set();
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    send(ws, { type: 'snapshot', sessions: manager.list(), settings: { maxConcurrent: manager.maxConcurrent } });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || typeof message.id !== 'string') throw new Error('잘못된 터미널 요청입니다.');
        if (message.type === 'unsubscribe') return ws.subscriptions.delete(message.id);
        if (!manager.get(message.id)) throw new Error('세션이 없습니다.');
        if (message.type === 'subscribe') {
          if (ws.subscriptions.size >= 8 && !ws.subscriptions.has(message.id)) throw new Error('한 화면에 최대 8개 터미널을 연결할 수 있습니다.');
          ws.subscriptions.add(message.id);
          send(ws, { type: 'replay', id: message.id, ...manager.logs(message.id) });
        } else if (message.type === 'input') {
          if (typeof message.data !== 'string' || message.data.length > 32768) throw new Error('입력 크기를 줄여 주세요.');
          manager.write(message.id, message.data);
        } else if (message.type === 'resize') {
          if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 20 || message.cols > 500 || message.rows < 5 || message.rows > 300) throw new Error('잘못된 터미널 크기입니다.');
          manager.resize(message.id, message.cols, message.rows);
        } else throw new Error('지원하지 않는 터미널 요청입니다.');
      } catch (error) { send(ws, { type: 'error', error: error.message }); }
    });
    ws.on('error', () => {});
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 30000);
  heartbeat.unref();
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      try { await manager.shutdown(); }
      catch (error) { closing = false; closePromise = null; throw error; }
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      for (const [event, handler] of Object.entries(listeners)) manager.off(event, handler);
      await new Promise(resolve => server.close(resolve));
    })();
    return closePromise;
  };
  return { server, manager, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
  const app = await createApp();
  app.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or choose another PORT.` : error.message);
    app.close().finally(() => { process.exitCode = 1; });
  });
  app.server.listen(port, '127.0.0.1', () => console.log(`Kernel Deck http://127.0.0.1:${app.server.address().port}`));
  const shutdown = () => app.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-deck-e2e-'));
const dataDir = path.join(temporaryRoot, 'sessions');
const fixture = path.join(temporaryRoot, 'terminal-fixture.cjs');
const milestones = [];
const pageErrors = [];
let app;
let browser;
let page;
let passed = false;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

function record(message) { milestones.push(message); console.log(`PASS ${message}`); }

async function startServer(port = 0) {
  const instance = await createApp({ dataDir });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, '127.0.0.1', resolve);
  });
  return instance;
}

async function bootstrap() {
  const response = await page.request.get('/api/bootstrap');
  assert.equal(response.status(), 200);
  return response.json();
}

async function getSession(id) { return (await bootstrap()).sessions.find(session => session.id === id); }
async function status(id, expected) { return until(async () => (await getSession(id))?.status === expected, `${id} becomes ${expected}`); }
function card(id) { return page.locator(`.terminal-card[data-session-id="${id}"]`); }
async function log(id) { const response = await page.request.get(`/api/sessions/${id}/log`); assert.equal(response.status(), 200); return (await response.json()).data; }

async function createSession(name, label, autoStart = true) {
  await page.getByRole('button', { name: '새 세션', exact: true }).click();
  await page.locator('#preset-select').selectOption('custom');
  await page.locator('#session-name').fill(name);
  await page.locator('#session-group').fill('병렬 작업 검증');
  await page.locator('#session-command').fill(process.execPath);
  await page.locator('#session-args').fill(`${fixture}\n${label}`);
  await page.locator('#session-cwd').fill(temporaryRoot);
  await page.locator('#session-auto-start').setChecked(autoStart);
  await page.getByRole('button', { name: '세션 만들기', exact: true }).click();
  await until(() => page.locator('#session-dialog').evaluate(element => !element.open), 'creation dialog closes');
  const session = await until(async () => (await bootstrap()).sessions.find(item => item.name === name), `${name} created`);
  await card(session.id).waitFor({ state: 'visible' });
  return session.id;
}

async function terminalInput(id, text) {
  await until(async () => (await log(id)).includes(':READY'), `${id} fixture accepts input`);
  await card(id).locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
  await until(async () => (await log(id)).includes(text), `${id} receives terminal input`);
}

async function menuAction(id, text) {
  await card(id).locator('.terminal-menu summary').click();
  await card(id).getByRole('button', { name: text, exact: true }).click();
}

async function setLimit(value) {
  await page.locator('#concurrency-limit').fill(String(value));
  await page.locator('#concurrency-limit').press('Tab');
  await until(async () => (await bootstrap()).settings.maxConcurrent === value, `concurrency limit ${value}`);
}

async function dismissSuccessNotifications() {
  assert.equal(await page.locator('.toast.error').count(), 0, 'No unexpected error before screenshot');
  for (const close of await page.locator('.toast:not(.error) button').all()) await close.click();
}

try {
  await mkdir(artifacts, { recursive: true });
  await writeFile(fixture, String.raw`
const label = process.argv[2];
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let line = '';
process.stdout.write(label + ':READY 한글 준비\r\n');
process.stdin.on('data', chunk => {
  for (const char of chunk) {
    if (char === '\x03') {
      process.stdout.write(label + ':INTERRUPTED\r\n');
      setTimeout(() => process.exit(130), 30);
    } else if (char === '\r' || char === '\n') {
      if (line) process.stdout.write(label + ': ' + line + ' / 한글 응답\r\n');
      line = '';
    } else if (char === '\x7f') line = line.slice(0, -1);
    else line += char;
  }
});
setInterval(() => {}, 1000);
`, 'utf8');
  app = await startServer();
  const port = app.server.address().port;
  const baseURL = `http://127.0.0.1:${port}`;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) {
    if (!/Executable doesn't exist|browserType\.launch.*executable/i.test(error.message)) throw error;
    // Use a fresh automation profile, never an existing user browser session.
    for (const channel of ['chrome', 'msedge']) {
      try { browser = await chromium.launch({ channel, headless: true }); console.log(`Browser: installed ${channel} (isolated headless profile)`); break; }
      catch (fallbackError) { if (!/distribution.*not found|executable.*doesn't exist/i.test(fallbackError.message)) throw fallbackError; }
    }
    if (!browser) { console.error('Chromium is missing. Run: npx playwright install chromium'); throw error; }
  }
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 960 }, locale: 'ko-KR', acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });
  await until(() => page.locator('#connection-status').evaluate(element => element.classList.contains('connected')), 'initial websocket connection', 30000);
  // Inspect actual rendered controls before using them; no mock API or fake app state.
  const renderedButtons = await page.getByRole('button').allTextContents();
  assert(renderedButtons.some(text => text.includes('새 세션')));
  assert.equal(await page.locator('.terminal-card').count(), 0);
  assert.equal(await page.locator('#empty-state').isVisible(), true);
  assert.equal((await bootstrap()).sessions.length, 0);
  await page.screenshot({ path: path.join(artifacts, 'e2e-empty.png'), fullPage: true });
  record('Empty workspace, real server connection, accessible creation action');

  await setLimit(2);
  const first = await createSession('코드 작성', 'ALPHA');
  const second = await createSession('테스트 실행', 'BETA');
  const third = await createSession('문서 작성', 'GAMMA');
  await status(first, 'running');
  await status(second, 'running');
  await status(third, 'queued');
  assert.equal(await card(third).locator('.status-badge').textContent(), '대기 중');
  await card(first).getByRole('button', { name: '종료', exact: true }).click();
  await status(first, 'stopped');
  await status(third, 'running');
  await card(first).getByRole('button', { name: '재시작', exact: true }).click();
  await status(first, 'queued');
  await setLimit(3);
  await status(first, 'running');
  assert.equal((await bootstrap()).sessions.filter(session => session.status === 'running').length, 3);
  record('Concurrency limit, FIFO queue, stop, restart, and three parallel real PTYs');

  const markers = ['ALPHA_UNIQUE_INPUT', 'BETA_UNIQUE_INPUT', 'GAMMA_UNIQUE_INPUT'];
  const ids = [first, second, third];
  for (let index = 0; index < ids.length; index++) await terminalInput(ids[index], markers[index]);
  await terminalInput(first, '한국어_입력_확인');
  for (let index = 0; index < ids.length; index++) {
    const output = await log(ids[index]);
    assert(output.includes(markers[index]));
    assert(output.includes('한글 응답'));
    for (let other = 0; other < ids.length; other++) if (other !== index) assert(!output.includes(markers[other]), 'Terminal output must stay isolated');
  }
  await until(() => card(first).locator('.xterm-rows').textContent().then(text => text.includes('ALPHA_UNIQUE_INPUT')), 'output rendered in xterm');
  record('Independent terminal input/output and Korean Unicode round trip');

  await card(first).locator('.xterm-helper-textarea').focus();
  await page.evaluate(async () => {
    const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConcurrent: 4 }) });
    if (!response.ok) throw new Error('Settings request failed');
  });
  await until(() => page.locator('#concurrency-limit').inputValue().then(value => value === '4'), 'websocket state update');
  assert(await card(first).locator('.xterm-helper-textarea').evaluate(element => element === document.activeElement), 'State updates must preserve terminal focus');
  await setLimit(3);

  const beforeResize = await getSession(first);
  await page.setViewportSize({ width: 1120, height: 760 });
  await until(async () => (await getSession(first)).cols !== beforeResize.cols, 'PTY resized with viewport');
  await card(first).locator('.terminal-mount').evaluate(element => { element.style.width = '70px'; element.style.height = '20px'; });
  await until(async () => { const session = await getSession(first); return session.cols === 20 && session.rows === 5; }, 'tiny tile clamps to supported PTY dimensions');
  await card(first).locator('.terminal-mount').evaluate(element => { element.style.removeProperty('width'); element.style.removeProperty('height'); });
  await page.setViewportSize({ width: 1440, height: 960 });
  await until(async () => (await getSession(first)).cols > 20, 'PTY size restores after fitting');
  record('Terminal focus survives state events; viewport and minimum resize bounds match PTY');

  await card(first).getByRole('button', { name: '코드 작성 집중 보기', exact: true }).click();
  assert.equal(await page.locator('.terminal-card').count(), 1);
  await page.locator(`.session-item[data-session-id="${second}"]`).click();
  await card(second).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.terminal-card').count(), 1);
  await page.getByRole('button', { name: '분할 보기', exact: true }).click();
  assert.equal(await page.locator('.terminal-card').count(), 3);
  await until(() => card(first).locator('.xterm-rows').textContent().then(text => text.includes(markers[0])), 'log replay after reselecting terminal');
  const replayText = await card(first).locator('.xterm-rows').textContent();
  assert.equal(replayText.split(markers[0]).length - 1, 1, 'Replay must not duplicate existing output');
  await page.locator('#session-search').fill('문서');
  assert.equal(await page.locator('.session-item').count(), 1);
  await page.locator('#session-search').fill('');
  assert.equal(await page.locator('.session-item').count(), 3);
  record('Grid/focus switching, terminal disposal/replay without duplication, and search');

  const previousSecond = await getSession(second);
  await card(second).getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  await status(second, 'failed');
  assert((await log(second)).includes('BETA:INTERRUPTED'));
  await menuAction(second, '세션 설정');
  await page.locator('#session-name').fill('테스트 실행 수정');
  await page.locator('#session-group').fill('검증 완료');
  await page.getByRole('button', { name: '변경 저장', exact: true }).click();
  await until(async () => (await getSession(second)).name === '테스트 실행 수정', 'edited session persisted');
  await until(() => page.locator('#session-dialog').evaluate(element => !element.open), 'edit dialog closes');
  await card(second).getByRole('button', { name: '재시작', exact: true }).click();
  await status(second, 'running');
  const restartedSecond = await getSession(second);
  assert(restartedSecond.run > previousSecond.run);
  assert.notEqual(restartedSecond.pid, previousSecond.pid);
  await until(async () => (await log(second)).includes('BETA:READY'), 'restarted terminal ready');
  assert(!(await log(second)).includes(markers[1]), 'Restart must reset the prior run log');
  await terminalInput(second, 'BETA_RESTARTED');
  record('Ctrl+C reaches PTY; stopped-session editing and restart create a fresh run');

  const fourth = await createSession('다음 작업', 'DELTA', false);
  await status(fourth, 'idle');
  await dismissSuccessNotifications();
  await page.screenshot({ path: path.join(artifacts, 'e2e-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => (await getSession(first)).cols < 70, 'mobile terminal fit');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout must not overflow horizontally');
  assert.equal(await page.getByRole('button', { name: '외부 AI 프로세스 확인', exact: true }).isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'e2e-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  record('Four-tile desktop and narrow mobile layouts captured; external observation remains reachable');

  const beforeReload = (await bootstrap()).sessions.map(({ id, pid, run }) => ({ id, pid, run }));
  await page.reload({ waitUntil: 'networkidle' });
  await until(() => page.locator('#connection-status').evaluate(element => element.classList.contains('connected')), 'connection after browser reload');
  assert.deepEqual((await bootstrap()).sessions.map(({ id, pid, run }) => ({ id, pid, run })), beforeReload, 'Browser refresh must not relaunch or stop processes');
  assert.equal(await page.locator('.terminal-card').count(), 4);
  await until(() => card(first).locator('.xterm-rows').textContent().then(text => text.includes(markers[0])), 'history restored after browser reload');
  assert.equal((await card(first).locator('.xterm-rows').textContent()).split(markers[0]).length - 1, 1);
  const downloadPromise = page.waitForEvent('download');
  await menuAction(first, '기록 다운로드');
  const download = await downloadPromise;
  assert((await readFile(await download.path(), 'utf8')).includes(markers[0]));
  record('Browser reload preserves PID/run and restores history; log export contains real output');

  await page.getByRole('button', { name: '외부 AI 프로세스 확인', exact: true }).click();
  await until(() => page.locator('#refresh-processes').isEnabled(), 'external process lookup completes', 20000);
  assert((await page.locator('#process-dialog').textContent()).includes('조회만'));
  assert.equal(await page.locator('#process-dialog').getByRole('button', { name: '종료', exact: true }).count(), 0);
  await page.locator('#process-dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
  await page.getByRole('button', { name: '모두 종료', exact: true }).click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '취소', exact: true }).click();
  assert.equal((await bootstrap()).sessions.filter(session => session.status === 'running').length, 3);
  await page.getByRole('button', { name: '모두 종료', exact: true }).click();
  await page.locator('#confirm-accept').click();
  await until(async () => (await bootstrap()).sessions.every(session => !['running', 'starting', 'stopping', 'queued'].includes(session.status)), 'stop all completes');
  record('External processes are read-only; stop-all cancellation and confirmation work');

  await app.close();
  app = null;
  await until(() => page.locator('#new-session').isDisabled(), 'disconnection disables process mutations');
  app = await startServer(port);
  await until(() => page.locator('#connection-status').evaluate(element => element.classList.contains('connected')), 'automatic reconnect after server restart and cookie rotation', 45000);
  assert.equal((await bootstrap()).sessions.length, 4);
  assert.equal((await bootstrap()).sessions.filter(session => session.status === 'running').length, 0);
  record('Server restart automatically reconnects with rotated cookie and restores saved sessions without relaunching');

  for (const id of [first, second, third, fourth]) {
    await menuAction(id, '세션 삭제');
    if (id === first) {
      await page.locator('#confirm-dialog').getByRole('button', { name: '취소', exact: true }).click();
      assert(await getSession(id));
      await menuAction(id, '세션 삭제');
    }
    await page.locator('#confirm-accept').click();
    await until(async () => !(await getSession(id)), 'confirmed deletion removes session');
  }
  assert.equal((await bootstrap()).sessions.length, 0);
  assert.equal(await page.locator('#empty-state').isVisible(), true);
  assert.equal(await page.locator('.terminal-card').count(), 0);
  assert.deepEqual(pageErrors, [], 'No uncaught browser JavaScript errors');
  assert.equal(await page.locator('.toast.error').count(), 0, 'No unexpected application error notifications');
  record('Deletion confirmation, full cleanup, final empty state, and no browser/application errors');
  passed = true;
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'e2e-failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { await app?.close(); } catch (error) { cleanupErrors.push(error); }
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'e2e-report.json'), JSON.stringify({ passed: passed && !cleanupErrors.length, milestones, pageErrors, cleanupErrors: cleanupErrors.map(error => error.message), checkedAt: new Date().toISOString() }, null, 2));
  if (cleanupErrors.length) {
    console.error(`Temporary test data preserved for cleanup: ${temporaryRoot}`);
    throw new AggregateError(cleanupErrors, 'Test cleanup failed; check process permissions before retrying.');
  }
  // Only remove the concrete mkdtemp directory, after verifying its workspace boundary.
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedTempDirectory = path.resolve(os.tmpdir());
  if (path.dirname(resolvedTemporaryRoot) !== resolvedTempDirectory || !path.basename(resolvedTemporaryRoot).startsWith('kernel-deck-e2e-')) throw new Error('Refusing to remove an unexpected temporary path');
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}

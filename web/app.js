import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import './style.css';

const $ = id => document.getElementById(id);
const sessions = new Map();
const cards = new Map();
const busy = new Set();
const activeStates = new Set(['queued', 'starting', 'running', 'stopping']);
const statusNames = { idle: '준비', queued: '대기 중', starting: '시작 중', running: '실행 중', stopping: '종료 중', completed: '완료', failed: '실패', stopped: '종료됨', interrupted: '중단됨' };
let presets = [];
let homeDirectory = '';
let maxConcurrent = 4;
let selected = [];
let focusId = null;
let filter = 'all';
let connected = false;
let socket = null;
let reconnectTimer = null;
let connectionAttempt = 0;
let retryCount = 0;
let selectionLoaded = false;
let editingId = null;
let submitting = false;
let processRequest = 0;
let settingsRequest = false;

const icons = {
  start: '<path d="m8 4 12 8-12 8z"></path>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"></rect>',
  restart: '<path d="M4 11a8 8 0 1 1 2.2 6M4 4v7h7"></path>',
  focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"></path>',
  close: '<path d="m6 6 12 12M6 18 18 6"></path>',
  more: '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  // Only constant, application-owned SVG paths are inserted as markup.
  svg.innerHTML = icons[name] || '';
  return svg;
}

function button(text, className, onClick, iconName) {
  const element = node('button', className);
  element.type = 'button';
  if (iconName) element.append(icon(iconName));
  if (text) element.append(node('span', '', text));
  element.addEventListener('click', onClick);
  return element;
}

function notify(message, error = false) {
  if (!error) for (const previous of $('toast-region').querySelectorAll('.toast:not(.error)')) previous.remove();
  const toast = node('div', `toast${error ? ' error' : ''}`);
  toast.append(node('span', '', message));
  const close = button('×', '', () => toast.remove());
  close.setAttribute('aria-label', '알림 닫기');
  toast.append(close);
  $('toast-region').append(toast);
  while ($('toast-region').children.length > 3) $('toast-region').firstElementChild.remove();
  setTimeout(() => toast.remove(), error ? 12000 : 5500);
}

async function api(path, method = 'GET', data = {}) {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(20000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`서버 응답을 읽지 못했습니다 (${response.status}).`); }
  if (!response.ok) throw new Error(result.error || `요청이 실패했습니다 (${response.status}).`);
  return result;
}

function send(message) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function saveSelection() {
  try { localStorage.setItem('kernel-deck.view.v1', JSON.stringify({ selected, focusId })); } catch { /* Storage may be unavailable in private browsing. */ }
}

function reconcileSelection() {
  if (!selectionLoaded) {
    selectionLoaded = true;
    let saved;
    try { saved = JSON.parse(localStorage.getItem('kernel-deck.view.v1')); } catch { /* Default to current sessions. */ }
    selected = Array.isArray(saved?.selected) ? [...new Set(saved.selected)].filter(id => sessions.has(id)).slice(0, 4) : [...sessions.keys()].slice(0, 4);
    focusId = selected.includes(saved?.focusId) ? saved.focusId : null;
  }
  selected = selected.filter(id => sessions.has(id));
  if (focusId && !selected.includes(focusId)) focusId = selected[0] || null;
  saveSelection();
}

function selectSession(id) {
  if (focusId && selected.includes(id) && focusId !== id) {
    focusId = id;
    saveSelection();
    render();
    return;
  }
  if (selected.includes(id)) {
    selected = selected.filter(value => value !== id);
    if (focusId === id) focusId = selected[0] || null;
  } else if (selected.length === 4) {
    notify('한 번에 4개까지 볼 수 있습니다. 왼쪽에서 다른 세션의 선택을 해제하세요.');
    return;
  } else {
    selected.push(id);
    if (focusId) focusId = id;
  }
  saveSelection();
  render();
}

function showSession(id) {
  if (!selected.includes(id)) {
    if (selected.length === 4) selected.pop();
    selected.push(id);
  }
  if (focusId) focusId = id;
  saveSelection();
  render();
}

function setFocus(id) {
  focusId = focusId === id ? null : id;
  saveSelection();
  render();
  requestAnimationFrame(() => cards.get(id)?.terminal.focus());
}

function renderSidebar() {
  const list = $('session-list');
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
  const query = $('session-search').value.toLocaleLowerCase().trim();
  const matches = [...sessions.values()].filter(session => {
    if (filter === 'active' && !activeStates.has(session.status)) return false;
    if (filter === 'attention' && !['failed', 'interrupted'].includes(session.status)) return false;
    return `${session.name} ${session.group || ''} ${session.command} ${session.cwd}`.toLocaleLowerCase().includes(query);
  });
  const groups = new Map();
  for (const session of matches) {
    const group = session.group || '그룹 없음';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(session);
  }
  const fragment = document.createDocumentFragment();
  if (!matches.length) fragment.append(node('p', 'list-empty', sessions.size ? '조건에 맞는 세션이 없습니다.' : '새 세션을 만들면 이곳에 표시됩니다.'));
  for (const [name, groupSessions] of groups) {
    const group = node('section', 'session-group');
    group.append(node('h3', '', name));
    for (const session of groupSessions) {
      const item = button('', 'session-item', () => selectSession(session.id));
      item.dataset.sessionId = session.id;
      item.setAttribute('aria-pressed', String(selected.includes(session.id)));
      if (focusId === session.id) item.setAttribute('aria-current', 'true');
      item.title = `${session.name}\n${session.command}\n${session.cwd}\n${focusId && selected.includes(session.id) && focusId !== session.id ? '클릭하여 이 세션에 집중' : '클릭하여 작업대에서 선택 / 해제'}`;
      const check = node('span', 'session-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      const content = node('span', 'session-item-content');
      content.append(node('span', 'session-item-name', session.name));
      const meta = node('span', 'session-item-meta');
      meta.append(node('i', `status-dot ${session.status}`), node('span', '', statusNames[session.status] || session.status));
      if (session.pid) meta.append(node('span', '', `PID ${session.pid}`));
      content.append(meta);
      item.append(check, content);
      group.append(item);
    }
    fragment.append(group);
  }
  list.replaceChildren(fragment);
  if (focusedId) [...list.querySelectorAll('[data-session-id]')].find(element => element.dataset.sessionId === focusedId)?.focus({ preventScroll: true });
  $('session-count').textContent = String(sessions.size);
}

function createCard(session) {
  const id = session.id;
  const element = node('section', 'terminal-card');
  element.dataset.sessionId = id;
  const header = node('div', 'terminal-card-header');
  const title = node('h2', 'terminal-card-title', session.name);
  const badge = node('span', 'status-badge');
  const focusButton = button('', 'icon-button', () => setFocus(id), 'focus');
  header.append(title, badge, focusButton);
  const meta = node('p', 'terminal-meta');
  const actions = node('div', 'terminal-actions');
  const start = button('시작', 'terminal-action primary-action', () => sessionAction(id, 'start'), 'start');
  const stop = button('종료', 'terminal-action danger-text', () => sessionAction(id, 'stop'), 'stop');
  const restart = button('재시작', 'terminal-action', () => sessionAction(id, 'restart'), 'restart');
  const interrupt = button('Ctrl+C', 'terminal-action', () => {
    if (send({ type: 'input', id, data: '\x03' })) cards.get(id)?.terminal.focus();
  });
  interrupt.title = '터미널에 Ctrl+C 보내기';
  const menu = node('details', 'terminal-menu');
  const menuToggle = node('summary', 'icon-button');
  menuToggle.append(icon('more'));
  menuToggle.setAttribute('aria-label', `${session.name} 더 보기`);
  const menuItems = node('div', 'menu-popover');
  const edit = button('세션 설정', '', () => { menu.open = false; openSessionDialog(id); });
  const download = button('기록 다운로드', '', () => {
    menu.open = false;
    const link = node('a');
    link.href = `/api/sessions/${encodeURIComponent(id)}/export`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  });
  const remove = button('세션 삭제', 'danger-text', async () => {
    menu.open = false;
    const current = sessions.get(id);
    if (!current) return;
    if (await confirmAction('세션 삭제', `“${current.name}” 세션과 저장된 터미널 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`, '삭제')) await sessionAction(id, 'delete');
  });
  menuItems.append(edit, download, remove);
  menu.append(menuToggle, menuItems);
  actions.append(start, stop, restart, node('span', 'action-spacer'), interrupt, menu);
  const body = node('div', 'terminal-body');
  const mount = node('div', 'terminal-mount');
  const placeholder = node('div', 'terminal-placeholder');
  const placeholderTitle = node('strong');
  const placeholderText = node('span');
  placeholder.append(placeholderTitle, placeholderText);
  body.append(mount, placeholder);
  const error = node('p', 'terminal-error');
  error.hidden = true;
  const footer = node('div', 'terminal-footer');
  const processInfo = node('span');
  const dimensions = node('span');
  footer.append(processInfo, dimensions);
  element.append(header, meta, actions, error, body, footer);
  $('terminal-grid').append(element);
  const terminal = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, "Malgun Gothic", monospace', fontSize: 12,
    lineHeight: 1.18, cursorBlink: true, cursorStyle: 'bar', scrollback: 5000,
    convertEol: false, allowTransparency: false, disableStdin: true,
    theme: { background: '#121d2c', foreground: '#dce5f4', cursor: '#a4beff', selectionBackground: '#38587f', black: '#26374b', red: '#e58b83', green: '#87c9a5', yellow: '#e2c48d', blue: '#89a8ed', magenta: '#c1a0e6', cyan: '#84c6d0', white: '#dce5f4', brightBlack: '#7b8da6', brightRed: '#ffafa7', brightGreen: '#a4e2be', brightYellow: '#ffe0a5', brightBlue: '#abc4ff', brightMagenta: '#dbb9ff', brightCyan: '#a1e1eb', brightWhite: '#f7f9fd' },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(mount);
  terminal.textarea?.setAttribute('aria-label', `${session.name} 터미널 입력`);
  const card = { id, element, title, badge, focusButton, meta, start, stop, restart, interrupt, edit, remove, menuToggle, error, terminal, fit, mount, placeholder, placeholderTitle, placeholderText, processInfo, dimensions, run: null, hasOutput: false, disposed: false, subscribedSocket: null, writes: Promise.resolve(), fitFrame: null };
  cards.set(id, card);
  terminal.onData(data => {
    if (sessions.get(id)?.status === 'running') send({ type: 'input', id, data });
  });
  terminal.onResize(({ cols, rows }) => {
    dimensions.textContent = `${cols} × ${rows}`;
    send({ type: 'resize', id, cols, rows });
  });
  card.observer = new ResizeObserver(() => scheduleFit(card));
  card.observer.observe(mount);
  scheduleFit(card);
  subscribe(card);
  return card;
}

function scheduleFit(card) {
  if (card.fitFrame || card.disposed) return;
  card.fitFrame = requestAnimationFrame(() => {
    card.fitFrame = null;
    if (card.disposed || card.mount.clientWidth < 20 || card.mount.clientHeight < 20) return;
    try {
      const size = card.fit.proposeDimensions();
      if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
        // Keep the browser terminal and PTY at the same supported dimensions.
        card.terminal.resize(Math.max(20, Math.min(500, size.cols)), Math.max(5, Math.min(300, size.rows)));
      }
    } catch { /* A tile can be removed between observer delivery and this frame. */ }
  });
}

function subscribe(card) {
  if (card.subscribedSocket === socket || !connected) return;
  if (send({ type: 'subscribe', id: card.id })) {
    card.subscribedSocket = socket;
    send({ type: 'resize', id: card.id, cols: card.terminal.cols, rows: card.terminal.rows });
  }
}

function disposeCard(card) {
  send({ type: 'unsubscribe', id: card.id });
  card.disposed = true;
  card.observer.disconnect();
  cancelAnimationFrame(card.fitFrame);
  card.terminal.dispose();
  card.element.remove();
  cards.delete(card.id);
}

function writeTerminal(card, data, reset = false) {
  card.writes = card.writes.then(() => new Promise(resolve => {
    if (card.disposed) return resolve();
    if (reset) card.terminal.reset();
    if (!data) return resolve();
    card.terminal.write(data, resolve);
  })).catch(() => { /* Disposing an offscreen terminal can cancel its pending parser callback. */ });
}

function receiveOutput(message) {
  const card = cards.get(message.id);
  if (!card || (card.run !== null && message.run < card.run)) return;
  const reset = message.type === 'replay' || card.run !== message.run;
  card.run = message.run;
  if (reset) card.hasOutput = false;
  card.hasOutput ||= Boolean(message.data);
  writeTerminal(card, message.data, reset);
  updatePlaceholder(card, sessions.get(card.id));
}

function updatePlaceholder(card, session) {
  if (!session) return;
  card.placeholder.hidden = card.hasOutput || session.status === 'running' || session.status === 'stopping';
  const descriptions = {
    idle: ['실행 준비가 되었습니다', '위의 시작 버튼으로 터미널을 실행하세요.'],
    queued: ['실행 순서를 기다립니다', '실행 중인 세션이 끝나면 자동으로 시작합니다.'],
    starting: ['터미널을 시작하는 중입니다', 'CLI를 불러오고 있습니다.'],
    completed: ['실행이 완료되었습니다', '이 세션에는 출력된 기록이 없습니다.'],
    stopped: ['세션이 종료되었습니다', '시작 버튼을 눌러 다시 실행할 수 있습니다.'],
    failed: ['실행을 확인해 주세요', '위의 오류를 확인한 후 세션 설정을 수정하세요.'],
    interrupted: ['관리 서버 종료로 중단되었습니다', '시작 버튼을 눌러 다시 실행할 수 있습니다.'],
  };
  const [title, text] = descriptions[session.status] || ['', ''];
  card.placeholderTitle.textContent = title;
  card.placeholderText.textContent = text;
}

function updateCard(card, session) {
  if (card.run !== null && card.run !== session.run) {
    card.run = session.run;
    card.hasOutput = false;
    writeTerminal(card, '', true);
  }
  card.title.textContent = session.name;
  card.title.title = session.name;
  card.element.setAttribute('aria-label', `${session.name} 터미널`);
  card.terminal.textarea?.setAttribute('aria-label', `${session.name} 터미널 입력`);
  card.badge.className = `status-badge ${session.status}`;
  card.badge.textContent = statusNames[session.status] || session.status;
  card.meta.textContent = `${session.command}  ·  ${session.cwd}`;
  card.meta.title = `${session.command}${session.args.length ? ' ' + session.args.join(' ') : ''}\n${session.cwd}`;
  const unavailable = !connected || busy.has(session.id) || busy.has('all');
  const active = activeStates.has(session.status);
  card.start.disabled = unavailable || active;
  card.stop.disabled = unavailable || !active || session.status === 'stopping';
  card.stop.querySelector('span').textContent = session.status === 'queued' ? '대기 취소' : '종료';
  card.restart.disabled = unavailable || session.status === 'stopping';
  card.interrupt.disabled = unavailable || session.status !== 'running';
  card.edit.disabled = unavailable || active;
  card.edit.title = active ? '세션을 종료한 후 설정을 수정할 수 있습니다.' : '';
  card.remove.disabled = unavailable || active;
  card.remove.title = active ? '세션을 종료한 후 삭제할 수 있습니다.' : '';
  card.menuToggle.setAttribute('aria-label', `${session.name} 더 보기`);
  card.focusButton.setAttribute('aria-label', focusId === session.id ? '분할 보기로 돌아가기' : `${session.name} 집중 보기`);
  card.focusButton.title = focusId === session.id ? '분할 보기로 돌아가기' : '집중 보기';
  card.terminal.options.disableStdin = !connected || session.status !== 'running';
  card.error.hidden = !session.error;
  card.error.textContent = session.error || '';
  card.processInfo.textContent = session.pid ? `PID ${session.pid}${session.run ? ` · 실행 ${session.run}` : ''}` : session.exitCode !== null && session.exitCode !== undefined ? `종료 코드 ${session.exitCode}${session.run ? ` · 실행 ${session.run}` : ''}` : session.run ? `실행 ${session.run}` : '아직 실행하지 않음';
  card.dimensions.textContent = `${card.terminal.cols} × ${card.terminal.rows}`;
  updatePlaceholder(card, session);
}

function render() {
  renderSidebar();
  const all = [...sessions.values()];
  const running = all.filter(session => ['starting', 'running', 'stopping'].includes(session.status)).length;
  const queued = all.filter(session => session.status === 'queued').length;
  $('workspace-summary').textContent = sessions.size ? `${sessions.size}개 세션 중 ${running}개 실행 중${queued ? ` · ${queued}개 대기 중` : ''}` : '병렬로 실행하는 AI 터미널을 한곳에서 관리하세요.';
  $('new-session').disabled = !connected || busy.has('all');
  $('empty-create').disabled = !connected || busy.has('all');
  $('stop-all').disabled = !connected || !all.some(session => activeStates.has(session.status)) || busy.has('all');
  $('concurrency-limit').disabled = !connected || settingsRequest || busy.has('all');
  if (document.activeElement !== $('concurrency-limit')) $('concurrency-limit').value = String(maxConcurrent);
  $('save-session').disabled = !connected || submitting || busy.has('all');
  $('grid-view').setAttribute('aria-pressed', String(!focusId));
  $('focus-view').setAttribute('aria-pressed', String(Boolean(focusId)));
  $('focus-view').disabled = !selected.length;
  $('selection-hint').textContent = focusId ? `${sessions.get(focusId)?.name || ''} 집중 보기` : selected.length ? `${selected.length} / 4개 선택 · 왼쪽에서 선택 / 해제` : '최대 4개 세션을 함께 봅니다';
  $('selection-hint').title = $('selection-hint').textContent;
  const visible = focusId ? [focusId] : selected;
  for (const [id, card] of cards) if (!visible.includes(id) || !sessions.has(id)) disposeCard(card);
  const grid = $('terminal-grid');
  grid.className = `terminal-grid${focusId ? ' focus-mode' : visible.length === 1 ? ' single' : visible.length === 2 ? ' two' : ''}`;
  grid.hidden = !visible.length;
  visible.forEach((id, index) => {
    const session = sessions.get(id);
    if (!session) return;
    const card = cards.get(id) || createCard(session);
    if (grid.children[index] !== card.element) grid.insertBefore(card.element, grid.children[index] || null);
    updateCard(card, session);
    scheduleFit(card);
  });
  $('empty-state').hidden = Boolean(visible.length);
  $('empty-title').textContent = sessions.size ? '작업대에 세션을 펼쳐 보세요.' : '여러 AI, 하나의 작업대.';
  $('empty-description').textContent = sessions.size ? '왼쪽에서 세션을 선택하면 터미널이 이곳에 표시됩니다.\n최대 4개를 나란히 보거나 하나에 집중할 수 있습니다.' : 'Codex, Claude Code, Gemini CLI를 나란히 실행하고\n입력과 상태를 한곳에서 관리하세요.';
  $('empty-create').textContent = sessions.size ? '새 세션 만들기 ＋' : '첫 세션 만들기 ＋';
}

function renderPresets() {
  const select = $('preset-select');
  select.replaceChildren();
  const custom = node('option', '', '직접 입력');
  custom.value = 'custom';
  select.append(custom);
  for (const preset of presets) {
    const option = node('option', '', `${preset.name}${preset.available ? '' : ' — 설치 확인 안 됨'}`);
    option.value = preset.id;
    option.disabled = !preset.available;
    select.append(option);
  }
  $('empty-presets').replaceChildren();
  for (const preset of presets.filter(item => item.id !== 'custom')) {
    const item = node('span', `empty-preset${preset.available ? ' available' : ''}`);
    item.append(node('i', `status-dot${preset.available ? ' running' : ''}`), node('span', '', `${preset.name} ${preset.available ? '감지됨' : '미감지'}`));
    $('empty-presets').append(item);
  }
}

function setConnection(state, detail = '') {
  connected = state === 'connected';
  $('connection-status').className = `connection-indicator ${state}`;
  $('connection-status').lastElementChild.textContent = connected ? '로컬 서버 연결됨' : state === 'connecting' ? '연결 중' : '연결 끊김';
  $('connection-alert').hidden = connected;
  $('connection-alert-text').textContent = detail || (state === 'connecting' ? '관리 서버에 연결하는 중입니다.' : '서버와 연결이 끊겼습니다. 자동으로 다시 연결합니다.');
  $('retry-connection').disabled = state === 'connecting';
  render();
}

async function connect() {
  clearTimeout(reconnectTimer);
  const attempt = ++connectionAttempt;
  const previous = socket;
  socket = null;
  if (previous) previous.close();
  for (const card of cards.values()) card.subscribedSocket = null;
  setConnection('connecting', retryCount ? '관리 서버에 다시 연결하는 중입니다. 기존 세션 상태를 확인합니다.' : '관리 서버에 연결하는 중입니다.');
  try {
    // The server rotates its local cookie on restart; refresh it before reconnecting.
    const page = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!page.ok) throw new Error(`서버 응답 ${page.status}`);
    const bootstrap = await api('/bootstrap');
    if (attempt !== connectionAttempt) return;
    sessions.clear();
    for (const session of bootstrap.sessions) sessions.set(session.id, session);
    presets = bootstrap.presets;
    homeDirectory = bootstrap.homeDirectory;
    maxConcurrent = bootstrap.settings.maxConcurrent;
    $('platform-label').textContent = `${bootstrap.platform === 'win32' ? 'Windows' : bootstrap.platform} · v${bootstrap.version}`;
    if (!$('session-dialog').open) renderPresets();
    reconcileSelection();
    render();
    const next = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    socket = next;
    const snapshotTimeout = setTimeout(() => { if (!connected && socket === next) next.close(); }, 10000);
    next.addEventListener('message', event => {
      if (attempt !== connectionAttempt || socket !== next) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'snapshot') {
        clearTimeout(snapshotTimeout);
        retryCount = 0;
        sessions.clear();
        for (const session of message.sessions) sessions.set(session.id, session);
        maxConcurrent = message.settings.maxConcurrent;
        reconcileSelection();
        setConnection('connected');
        for (const card of cards.values()) subscribe(card);
      } else if (message.type === 'session') {
        sessions.set(message.session.id, message.session);
        render();
      } else if (message.type === 'output' || message.type === 'replay') {
        receiveOutput(message);
      } else if (message.type === 'deleted') {
        sessions.delete(message.id);
        reconcileSelection();
        render();
      } else if (message.type === 'settings') {
        maxConcurrent = message.maxConcurrent;
        render();
      } else if (message.type === 'error') {
        notify(message.error, true);
      }
    });
    next.addEventListener('error', () => { /* The close handler owns reconnection. */ });
    next.addEventListener('close', () => {
      clearTimeout(snapshotTimeout);
      if (attempt !== connectionAttempt || socket !== next) return;
      scheduleReconnect(attempt);
    });
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    scheduleReconnect(attempt, error.name === 'TimeoutError' ? '서버 응답을 기다리는 시간이 초과되었습니다.' : error.message);
  }
}

function scheduleReconnect(attempt, error = '') {
  if (attempt !== connectionAttempt) return;
  retryCount++;
  const seconds = Math.min(15, 2 ** Math.min(retryCount - 1, 4));
  setConnection('disconnected', `${error ? `${error} ` : '서버와 연결이 끊겼습니다. '}입력과 실행 제어를 잠시 멈추고 ${seconds}초 후 다시 연결합니다.`);
  reconnectTimer = setTimeout(connect, seconds * 1000);
}

async function sessionAction(id, action) {
  if (!connected || busy.has(id) || busy.has('all')) return;
  const session = sessions.get(id);
  if (!session) return;
  busy.add(id);
  render();
  try {
    if (action === 'delete') {
      await api(`/sessions/${encodeURIComponent(id)}`, 'DELETE');
      sessions.delete(id);
      reconcileSelection();
      notify(`“${session.name}” 세션을 삭제했습니다.`);
    } else {
      await api(`/sessions/${encodeURIComponent(id)}/${action}`, 'POST');
    }
  } catch (error) { notify(error.message, true); }
  finally { busy.delete(id); render(); }
}

function openSessionDialog(id = null) {
  if (!connected || submitting || busy.has('all')) return;
  const session = id ? sessions.get(id) : null;
  if (id && (!session || activeStates.has(session.status))) return;
  editingId = id;
  $('session-form').reset();
  renderPresets();
  $('session-dialog-title').textContent = session ? '세션 설정' : '새 세션';
  $('save-session').textContent = session ? '변경 저장' : '세션 만들기';
  $('auto-start-field').hidden = Boolean(session);
  $('session-form-error').hidden = true;
  $('preset-description').textContent = '설치된 CLI를 선택하거나 직접 명령을 지정하세요.';
  if (session) {
    $('preset-select').value = 'custom';
    $('session-name').value = session.name;
    $('session-command').value = session.command;
    $('session-args').value = session.args.join('\n');
    $('session-cwd').value = session.cwd;
    $('session-group').value = session.group || '';
  } else {
    $('session-cwd').value = homeDirectory;
    const first = presets.find(preset => preset.available && preset.id !== 'custom');
    if (first) { $('preset-select').value = first.id; applyPreset(); }
  }
  $('session-dialog').showModal();
  $('session-name').focus();
}

function applyPreset() {
  const preset = presets.find(item => item.id === $('preset-select').value);
  if (!preset || !preset.available) {
    $('preset-description').textContent = '실행 파일과 인수를 직접 입력하세요.';
    return;
  }
  $('session-command').value = preset.command;
  $('session-args').value = preset.args.join('\n');
  if (!$('session-name').value) $('session-name').value = preset.name;
  if (!$('session-cwd').value) $('session-cwd').value = preset.cwd || homeDirectory;
  $('preset-description').textContent = preset.description || `${preset.name} 실행 명령을 불러왔습니다.`;
}

function confirmAction(title, message, accept) {
  const dialog = $('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-accept').textContent = accept;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.querySelector('[value="cancel"]').focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

async function loadProcesses() {
  const request = ++processRequest;
  $('refresh-processes').disabled = true;
  $('process-content').replaceChildren(node('p', 'process-empty', '실행 중인 AI 프로세스를 확인하는 중입니다.'));
  try {
    const result = await api('/processes');
    if (request !== processRequest) return;
    const content = document.createDocumentFragment();
    if (result.error) content.append(node('p', 'process-error', result.error));
    if (!result.processes.length) content.append(node('p', 'process-empty', result.error ? '프로세스 목록을 불러오지 못했습니다. 새로고침으로 다시 확인하세요.' : '감지된 AI CLI 프로세스가 없습니다.'));
    else {
      const table = node('table', 'process-table');
      const head = node('thead');
      const heading = node('tr');
      for (const text of ['PID', '프로그램', '시작 시각']) { const th = node('th', '', text); th.scope = 'col'; heading.append(th); }
      head.append(heading);
      const body = node('tbody');
      for (const process of result.processes) {
        const row = node('tr');
        row.append(node('td', '', String(process.pid)));
        const program = node('td', '', process.name);
        if (process.command && process.command !== process.name) program.append(node('small', '', process.command));
        row.append(program);
        const date = process.startedAt ? new Date(process.startedAt) : null;
        row.append(node('td', '', date && !Number.isNaN(date.getTime()) ? date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '확인 불가'));
        body.append(row);
      }
      table.append(head, body);
      content.append(table);
    }
    $('process-content').replaceChildren(content);
  } catch (error) {
    if (request === processRequest) $('process-content').replaceChildren(node('p', 'process-error', error.message));
  } finally { if (request === processRequest) $('refresh-processes').disabled = false; }
}

$('new-session').addEventListener('click', () => openSessionDialog());
$('empty-create').addEventListener('click', () => openSessionDialog());
$('preset-select').addEventListener('change', applyPreset);
$('session-command').addEventListener('input', () => { $('preset-select').value = 'custom'; $('preset-description').textContent = '직접 지정한 실행 명령입니다.'; });
$('session-args').addEventListener('input', () => { $('preset-select').value = 'custom'; });
$('session-search').addEventListener('input', renderSidebar);
for (const element of document.querySelectorAll('[data-filter]')) element.addEventListener('click', () => {
  filter = element.dataset.filter;
  for (const tab of document.querySelectorAll('[data-filter]')) tab.setAttribute('aria-pressed', String(tab === element));
  renderSidebar();
});
$('grid-view').addEventListener('click', () => { focusId = null; saveSelection(); render(); });
$('focus-view').addEventListener('click', () => { if (selected.length) { focusId = focusId || selected[0]; saveSelection(); render(); } });
$('retry-connection').addEventListener('click', connect);
window.addEventListener('online', () => { if (!connected) connect(); });
window.addEventListener('beforeunload', () => { clearTimeout(reconnectTimer); connectionAttempt++; socket?.close(); });
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.terminal-menu[open]')) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') for (const menu of document.querySelectorAll('.terminal-menu[open]')) menu.open = false;
  if (event.altKey && event.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { event.preventDefault(); openSessionDialog(); }
});
for (const close of document.querySelectorAll('.dialog-close')) close.addEventListener('click', () => { if (!submitting || close.closest('dialog') !== $('session-dialog')) close.closest('dialog').close(); });
$('session-dialog').addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
$('session-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!connected || submitting || busy.has('all') || !$('session-form').reportValidity()) return;
  submitting = true;
  $('session-form-error').hidden = true;
  render();
  const spec = {
    name: $('session-name').value.trim(), command: $('session-command').value.trim(),
    args: $('session-args').value.replace(/\r/g, '').split('\n').filter(argument => argument.length > 0),
    cwd: $('session-cwd').value.trim(), group: $('session-group').value.trim(),
  };
  try {
    const session = editingId ? await api(`/sessions/${encodeURIComponent(editingId)}`, 'PATCH', spec) : await api('/sessions', 'POST', { ...spec, autoStart: $('session-auto-start').checked });
    if (!sessions.has(session.id)) sessions.set(session.id, session);
    showSession(session.id);
    $('session-dialog').close();
    notify(editingId ? '세션 설정을 저장했습니다.' : `“${session.name}” 세션을 만들었습니다.`);
  } catch (error) {
    $('session-form-error').textContent = error.message;
    $('session-form-error').hidden = false;
  } finally { submitting = false; render(); }
});
$('concurrency-limit').addEventListener('change', async () => {
  const input = $('concurrency-limit');
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > 16) { input.value = String(maxConcurrent); notify('동시 실행 수는 1~16 사이의 정수로 입력하세요.', true); return; }
  if (!connected || settingsRequest || value === maxConcurrent) return;
  settingsRequest = true;
  render();
  try { const result = await api('/settings', 'PATCH', { maxConcurrent: value }); maxConcurrent = result.maxConcurrent; notify(`동시 실행 한도를 ${value}개로 변경했습니다. 실행 중인 세션은 계속 유지됩니다.`); }
  catch (error) { notify(error.message, true); }
  finally { settingsRequest = false; input.value = String(maxConcurrent); render(); }
});
$('stop-all').addEventListener('click', async () => {
  if (!connected || busy.has('all')) return;
  if (!await confirmAction('모든 세션 종료', '실행 중인 세션을 모두 종료하고 대기 중인 실행을 취소합니다. CLI에서 아직 저장하지 않은 작업은 손실될 수 있습니다.', '모두 종료')) return;
  if (!connected) return;
  busy.add('all');
  render();
  try { await api('/stop-all', 'POST'); notify('모든 세션의 종료를 요청하고 대기열을 취소했습니다.'); }
  catch (error) { notify(error.message, true); }
  finally { busy.delete('all'); render(); }
});
$('external-processes').addEventListener('click', () => { $('process-dialog').showModal(); loadProcesses(); });
$('refresh-processes').addEventListener('click', loadProcesses);

connect();

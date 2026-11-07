'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { ManagedInstance } = require('../dist/manager/instance');

function driver(sessionPath, invoke) {
  const d = Object.create(TelegramDriver.prototype);
  d.config = { telegram: { sessionPath } };
  d.started = true;
  d.logger = { warn() {}, error() {} };
  d.bus = { emit() {} };
  d.client = { invoke, disconnect: async () => {} };
  return d;
}

test('logout revokes one Telegram session, disconnects and removes only its own local file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logout-'));
  try {
    const current = path.join(dir, 'a.session'), other = path.join(dir, 'b.session');
    fs.writeFileSync(current, 'a'); fs.writeFileSync(other, 'b');
    let method, disconnected = false;
    const d = driver(current, async req => { method = req.className; });
    d.client.disconnect = async () => { disconnected = true; };
    const result = await d.logOut();
    assert.equal(method, 'auth.LogOut');
    assert.equal(result.localSessionRemoved, true);
    assert.equal(disconnected, true);
    assert.equal(d.started, false);
    assert.equal(fs.existsSync(current), false);
    assert.equal(fs.readFileSync(other, 'utf8'), 'b');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed Telegram logout keeps the local session and connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logout-'));
  try {
    const session = path.join(dir, 'a.session'); fs.writeFileSync(session, 'secret');
    const d = driver(session, async () => { throw new Error('offline'); });
    await assert.rejects(d.logOut(), /offline/);
    assert.equal(fs.readFileSync(session, 'utf8'), 'secret');
    assert.equal(d.started, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('local cleanup failure is reported after a successful remote logout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logout-'));
  try {
    const d = driver(dir, async () => {});
    assert.deepEqual(await d.logOut(), { localSessionRemoved: false });
    assert.equal(d.started, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manager serializes logout, stops and clears account only after success', async () => {
  const instance = new ManagedInstance({ id: 'a' });
  instance.self = { id: 42 };
  let finish; instance.accountAction = () => new Promise(resolve => { finish = resolve; });
  let stops = 0; instance.stopWorker = async () => { stops++; };
  const pending = instance.logOut();
  await assert.rejects(instance.logOut(), /正在退出/);
  await assert.rejects(instance.start(), /正在退出/);
  await assert.rejects(instance.stop(), /正在退出/);
  await assert.rejects(instance.restart(), /正在退出/);
  await assert.rejects(ManagedInstance.prototype.accountAction.call(instance, 'send_message'), /正在退出/);
  finish({ localSessionRemoved: true });
  assert.deepEqual(await pending, { localSessionRemoved: true });
  assert.equal(stops, 1); assert.equal(instance.getInfo().self, undefined);

  instance.self = { id: 42 };
  instance.accountAction = async () => { throw new Error('network'); };
  await assert.rejects(instance.logOut(), /network/);
  assert.equal(stops, 2); assert.equal(instance.getInfo().self, undefined);
});

test('two-step password whitespace is transmitted exactly', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const from = app.indexOf('  const submitAuth = async () => {');
  const to = app.indexOf("  document.getElementById('btn-submit-auth').onclick = submitAuth;", from);
  assert.ok(from >= 0 && to > from);
  const fields = {
    'btn-submit-auth': {}, 'auth-input-phone': { value: ' +123 ' },
    'auth-input-code': { value: ' 1234 ' }, 'auth-input-password': { value: ' password with spaces  ' },
  };
  const sent = [];
  const state = { currentAuthInstanceId: 'a', currentAuthStep: 'password' };
  const context = vm.createContext({ state, document: { getElementById: id => fields[id] }, api: async (...args) => sent.push(args), showToast() {} });
  vm.runInContext(app.slice(from, to) + '\nthis.submitAuth = submitAuth;', context);
  await context.submitAuth();
  assert.equal(sent[0][2].value, ' password with spaces  ');
  state.currentAuthStep = 'phone'; await context.submitAuth(); assert.equal(sent[1][2].value, '+123');
  state.currentAuthStep = 'code'; await context.submitAuth(); assert.equal(sent[2][2].value, '1234');
});

test('logout waits for an in-flight reconnect before revoking authorization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logout-'));
  try {
    const order = [];
    const d = driver(path.join(dir, 'session'), async () => { order.push('revoke'); });
    let reconnectDone;
    d.keepalivePromise = new Promise(resolve => { reconnectDone = () => { order.push('reconnect finished'); resolve(); }; });
    d.client.disconnect = async () => { order.push('disconnect'); };
    const pending = d.logOut();
    assert.deepEqual(order, []);
    reconnectDone();
    await pending;
    assert.deepEqual(order, ['reconnect finished', 'revoke', 'disconnect']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a disconnect listener failure cannot prevent removal of a revoked local session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logout-'));
  try {
    const session = path.join(dir, 'session'); fs.writeFileSync(session, 'secret');
    const d = driver(session, async () => {});
    d.bus.emit = () => { throw new Error('bad listener'); };
    const result = await d.logOut();
    assert.equal(result.localSessionRemoved, true);
    assert.equal(fs.existsSync(session), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure or timeout during logout stops the old worker before allowing another start', async () => {
  const instance = new ManagedInstance({ id: 'a' });
  let finish, finishStopping;
  instance.accountAction = () => new Promise((_resolve, reject) => { finish = reject; });
  instance.stopWorker = () => new Promise(resolve => { finishStopping = resolve; });
  const pending = instance.logOut();
  finish(new Error('响应超时'));
  await Promise.resolve();
  await assert.rejects(instance.start(), /正在退出/);
  finishStopping();
  await assert.rejects(pending, /未确认.*响应超时/);
  assert.equal(instance.logoutInProgress, false);
});

test('login prompts isolate credentials between accounts and clear them on close', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const from = app.indexOf('let authQrSession = null;');
  const to = app.indexOf('// Event Listeners', from);
  assert.ok(from >= 0 && to > from);
  const fields = {};
  for (const id of ['auth-input-phone','auth-input-code','auth-input-password','auth-modal-title','auth-group-phone','auth-group-code','auth-group-password','auth-hint']) {
    fields[id] = { value: '', style: {}, focus() {} };
  }
  const state = { currentAuthInstanceId: null, currentAuthStep: null };
  const context = vm.createContext({ state, document: { getElementById: id => fields[id] },
    el: { modalAuth: { classList: { add() {}, remove() {} } } }, setTimeout: () => 0 });
  vm.runInContext(app.slice(from, to) + '\nthis.openAuthModal = openAuthModal; this.closeAuthModal = closeAuthModal;', context);
  context.openAuthModal('a', 'password');
  fields['auth-input-password'].value = '  pass  ';
  context.openAuthModal('a', 'password');
  assert.equal(fields['auth-input-password'].value, '  pass  ');
  context.openAuthModal('b', 'password');
  assert.equal(fields['auth-input-password'].value, '');
  fields['auth-input-password'].value = 'another secret';
  context.closeAuthModal();
  assert.equal(fields['auth-input-password'].value, '');
  assert.equal(state.currentAuthInstanceId, null);
});

test('logout HTTP route targets only the requested instance and reports errors', async () => {
  const { Readable } = require('node:stream');
  const { handleApiRoute } = require('../dist/gui/api');
  const calls = [];
  const manager = { getInstance(id) { calls.push(id); return { async logOut() { if (id === 'bad') throw new Error('offline'); return { localSessionRemoved: true }; } }; } };
  async function request(id) {
    const req = Readable.from([]); req.url = `/api/instances/${id}/account/logout`; req.method = 'POST'; req.headers = { host: 'localhost' };
    let status, body;
    const res = { writeHead(code) { status = code; }, end(data) { body = JSON.parse(data); } };
    await handleApiRoute(req, res, manager, '.');
    return { status, body };
  }
  assert.deepEqual(await request('a'), { status: 200, body: { success: true, localSessionRemoved: true } });
  assert.deepEqual(await request('bad'), { status: 400, body: { error: 'offline' } });
  assert.deepEqual(calls, ['a', 'bad']);
});

test('pressing Enter while an authentication submission is pending does not submit twice', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const from = app.indexOf('  const submitAuth = async () => {');
  const to = app.indexOf("  document.getElementById('btn-submit-auth').onclick = submitAuth;", from);
  const fields = { 'btn-submit-auth': {}, 'auth-input-code': { value: '1234' } };
  let finish, count = 0;
  const context = vm.createContext({ state: { currentAuthInstanceId: 'a', currentAuthStep: 'code' },
    document: { getElementById: id => fields[id] },
    api: () => { count++; return new Promise(resolve => { finish = resolve; }); }, showToast() {} });
  vm.runInContext(app.slice(from, to) + '\nthis.submitAuth = submitAuth;', context);
  const first = context.submitAuth();
  await context.submitAuth();
  assert.equal(count, 1);
  finish(); await first;
  assert.equal(fields['btn-submit-auth'].disabled, false);
});

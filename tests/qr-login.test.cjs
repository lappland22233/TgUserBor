'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { ManagedInstance } = require('../dist/manager/instance');
const { TelegramDriver, QR_AUTH_MARKER } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function instance(id) {
  const inst = new ManagedInstance({ id, name:id });
  const child = new EventEmitter();
  child.connected = true;
  child.sent = [];
  child.send = (msg, cb) => { child.sent.push(msg); if (cb) cb(null); };
  inst.child = child;
  inst.pendingAuthStep = 'phone';
  inst.status = 'NEEDS_PHONE';
  return { inst, child };
}

test('QR login uses a per-instance secret and does not expose the token through instance info or events', async () => {
  const a = instance('a'), b = instance('b');
  const events = [];
  a.inst.on('auth_required', value => events.push(value));
  const aKey = await a.inst.beginQrLogin();
  const bKey = await b.inst.beginQrLogin();
  assert.notEqual(aKey, bKey);
  assert.equal(a.child.sent[0].type, 'AUTH_QR_START');
  assert.throws(() => a.inst.getQrLogin(bKey), /无权/);
  assert.equal(a.inst.getQrLogin(aKey), undefined);
  const expires = Math.floor(Date.now() / 1000) + 60;
  a.inst.handleIPC({ type: 'AUTH_QR', token: 'secret-token', expires });
  assert.deepEqual(a.inst.getQrLogin(aKey), { token:'secret-token', expires });
  assert.equal(JSON.stringify(a.inst.getInfo()).includes('secret-token'), false);
  assert.equal(JSON.stringify(events).includes('secret-token'), false);
  a.inst.handleIPC({ type: 'AUTH_REQUIRED', step:'password' });
  assert.throws(() => a.inst.getQrLogin(aKey), /无权/);
});

test('QR login refuses stale prompts and failed IPC restores the phone prompt', async () => {
  const h = instance('a');
  h.child.send = (msg, cb) => cb(new Error('IPC failed'));
  await assert.rejects(h.inst.beginQrLogin(), /IPC failed/);
  assert.equal(h.inst.pendingAuthStep, 'phone');
  h.inst.pendingAuthStep = 'code';
  await assert.rejects(h.inst.beginQrLogin(), /不能/);
});

test('QR cancel terminates the worker and rejects stale credentials', async () => {
  const h = instance('a');
  const key = await h.inst.beginQrLogin();
  let stopped = 0;
  h.inst.stop = async () => { stopped++; h.inst.clearQrLogin(); };
  await assert.rejects(h.inst.cancelQrLogin('not-the-key'), /无权/);
  await h.inst.cancelQrLogin(key);
  assert.equal(stopped, 1);
  assert.throws(() => h.inst.getQrLogin(key), /无权/);
});

test('GramJS phone-to-QR switch provides login token and 2FA callback without logging secrets', async () => {
  const events = [], logs = [];
  const handler = { askPhone: async () => QR_AUTH_MARKER, askCode: async () => '1', askPassword: async () => '  pass  ', onQr: (token, expires) => events.push({ token: token.toString(), expires }) };
  const driver = new TelegramDriver({ telegram: { apiId:1, apiHash:'hash', sessionPath:'/tmp/not-used' } }, { error: v => logs.push(v) }, handler);
  driver.client = { start: async params => {
    await assert.rejects(params.phoneNumber(), e => e.errorMessage === 'RESTART_AUTH_WITH_QR');
    await params.qrCode({ token:Buffer.from('secret-token'), expires:1234 });
    assert.equal(await params.password(), '  pass  ');
  } };
  driver.saveSession = () => {};
  await driver.interactiveLogin();
  assert.deepEqual(events, [{ token:'secret-token', expires:1234 }]);
  assert.equal(JSON.stringify(logs).includes('secret-token'), false);
});

test('QR HTTP endpoint returns no-store image only with the instance access key', async () => {
  const a = instance('a');
  const key = await a.inst.beginQrLogin();
  a.inst.handleIPC({type:'AUTH_QR',token:'secret-token',expires:Math.floor(Date.now()/1000)+60});
  const manager = { getInstance: id => id === 'a' ? a.inst : undefined };
  const request = async headers => {
    const req = Readable.from([]); req.method = 'GET'; req.url = '/api/instances/a/auth/qr'; req.headers = { host:'localhost', ...headers };
    const out = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(data) { this.data = data; } };
    await handleApiRoute(req, out, manager, '/unused'); return out;
  };
  assert.equal((await request({})).status, 403);
  assert.equal((await request({'x-qr-access-key':'wrong'})).status, 403);
  const out = await request({'x-qr-access-key':key});
  assert.equal(out.status, 200);
  assert.match(out.headers['Cache-Control'], /no-store/);
  assert.match(JSON.parse(out.data).image, /^data:image\/png;base64,/);
  assert.equal(out.data.includes('secret-token'), false);
});

test('failed or stopped QR workers invalidate both token and access key', async () => {
  for (const status of ['ERROR', 'STOPPED']) {
    const h = instance('a');
    const key = await h.inst.beginQrLogin();
    h.inst.handleIPC({ type: 'AUTH_QR', token: 'sensitive', expires: Math.floor(Date.now()/1000)+60 });
    h.inst.handleIPC({ type: 'STATUS_CHANGE', status, error: 'unavailable' });
    assert.throws(() => h.inst.getQrLogin(key), /无权/);
    assert.equal(JSON.stringify(h.inst.getInfo()).includes('sensitive'), false);
  }
});

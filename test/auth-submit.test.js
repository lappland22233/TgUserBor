'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ManagedInstance } = require('../dist/manager/instance');
const { handleApiRoute } = require('../dist/gui/api');

test('auth accepts only the requested step once and preserves the password', async () => {
  let sent;
  const instance = new ManagedInstance({ id: 'test' });
  instance.child = { connected: true, send: (msg, done) => { sent = msg; done(null); } };
  instance.pendingAuthStep = 'password';
  await assert.rejects(instance.submitAuth('code', '123'), /验证步骤/);
  await instance.submitAuth('password', ' pass ');
  assert.equal(sent.value, ' pass ');
  await assert.rejects(instance.submitAuth('password', ' pass '), /验证步骤/);
});

test('auth send failures allow retry and disconnected workers reject', async () => {
  const instance = new ManagedInstance({ id: 'test' });
  instance.pendingAuthStep = 'code';
  instance.child = { connected: true, send: (_msg, done) => done(new Error('IPC failed')) };
  await assert.rejects(instance.submitAuth('code', '123'), /IPC failed/);
  assert.equal(instance.pendingAuthStep, 'code');
  instance.child.connected = false;
  await assert.rejects(instance.submitAuth('code', '123'), /验证步骤/);
});

test('auth API reports malformed, stale, and accepted requests', async () => {
  const instance = new ManagedInstance({ id: 'test' });
  instance.pendingAuthStep = 'phone';
  instance.child = { connected: true, send: (_msg, done) => done(null) };
  const manager = { getInstance: () => instance };
  const server = http.createServer((req, res) => { handleApiRoute(req, res, manager, '').catch(err => { res.statusCode = 500; res.end(err.message); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/demo/auth`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({ step: 'bad', value: 'x' }))).status, 400);
    assert.equal((await post(JSON.stringify({ step: 'code', value: '123' }))).status, 409);
    assert.equal((await post(JSON.stringify({ step: 'phone', value: '+123' }))).status, 200);
    assert.equal((await post(JSON.stringify({ step: 'phone', value: '+123' }))).status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

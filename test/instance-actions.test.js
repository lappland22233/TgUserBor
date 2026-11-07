'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagedInstance } = require('../dist/manager/instance');

function setup(send) {
  const instance = new ManagedInstance({ id: 'test' });
  instance.status = 'ONLINE';
  instance.child = { connected: true, send };
  return instance;
}

test('successful account response clears the upload timeout', async () => {
  let message;
  const instance = setup((msg, cb) => { message = msg; cb(null); });
  const result = instance.accountAction('send_media', {});
  const pending = instance.pendingAccountActions.get(message.actionId);
  assert.equal(pending.timer.hasRef(), false);
  instance.handleIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId: message.actionId, success: true, data: 12 });
  assert.equal(await result, 12);
  assert.equal(pending.timer._destroyed, true);
  assert.equal(instance.pendingAccountActions.size, 0);
});

test('IPC send failure and instance stop reject pending actions and clear timers', async () => {
  const failed = setup((_msg, cb) => { setImmediate(() => cb(new Error('IPC failed'))); });
  const result = failed.accountAction('send_media');
  const failedTimer = [...failed.pendingAccountActions.values()][0].timer;
  await assert.rejects(result, /IPC failed/);
  assert.equal(failedTimer._destroyed, true);
  assert.equal(failed.pendingAccountActions.size, 0);

  const stopped = setup(() => {});
  const outstanding = stopped.accountAction('send_media');
  const stoppedTimer = [...stopped.pendingAccountActions.values()][0].timer;
  stopped.child = undefined;
  await stopped.stop();
  await assert.rejects(outstanding, /实例已停止/);
  assert.equal(stoppedTimer._destroyed, true);
  assert.equal(stopped.pendingAccountActions.size, 0);
});

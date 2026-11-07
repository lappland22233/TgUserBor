'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = app.indexOf('// Interactive Auth Modal');
const end = app.indexOf('// Event Listeners', start);
if (start < 0 || end < 0) throw new Error('Cannot locate QR login UI');
function fixture(response) {
  const nodes = new Map(), timers = [];
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { style:{}, value:'', textContent:'', innerText:'', focus(){}, removeAttribute(){} });
    return nodes.get(id);
  } };
  const state = { currentAuthInstanceId:'a', currentAuthStep:'phone' };
  const context = vm.createContext({ state, document, Date, encodeURIComponent,
    el:{ modalAuth:{ classList:{ add(){}, remove(){} } } },
    fetch: async () => response,
    api: async () => ({}), showToast(){},
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeout() {},
  });
  vm.runInContext(app.slice(start,end) + '\nthis.show = openAuthModal; this.poll = pollAuthQr; this.setSession = s => authQrSession = s; this.getSession = () => authQrSession;', context);
  return { context, state, nodes, timers, document };
}
test('late phone and code prompts cannot replace an active QR login', () => {
  const f = fixture({ok:true, json:async()=>({})});
  const session = {instanceId:'a',key:'temporary',timer:null}; f.context.setSession(session);
  f.context.show('a','qr');
  f.context.show('a','phone'); f.context.show('a','code');
  assert.equal(f.state.currentAuthStep, 'qr');
  assert.equal(f.context.getSession(), session);
  f.context.show('a','password');
  assert.equal(f.state.currentAuthStep, 'password');
  assert.equal(f.context.getSession(), null);
});
test('terminal QR status clears the credential and stops polling', async () => {
  const f = fixture({ok:false,status:403});
  const session = {instanceId:'a',key:'temporary',timer:null}; f.context.setSession(session);
  await f.context.poll(session);
  assert.equal(f.context.getSession(), null);
  assert.equal(f.timers.length, 0);
  assert.match(f.document.getElementById('auth-qr-status').textContent, /登录已结束/);
});
test('temporary QR network errors retry without discarding the key', async () => {
  const f = fixture({ok:false,status:503});
  const session = {instanceId:'a',key:'temporary',timer:null}; f.context.setSession(session);
  await f.context.poll(session);
  assert.equal(f.context.getSession(), session);
  assert.equal(f.timers[0].ms, 2000);
});

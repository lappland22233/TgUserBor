'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = app.indexOf('let clientDialogsRequest = 0;');
const end = app.indexOf('function clientDraftKey', start);
if (start < 0 || end < 0) throw new Error('Cannot locate dialog search');
function harness() {
  const state = { clientSelectedInstance:'a', clientDialogs:[] };
  const input = { value:'', maxLength: 128 };
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  const context = vm.createContext({ state, window:{}, document:{ getElementById: () => input },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
    renderClientDialogs() {}, api: url => new Promise((resolve, reject) => calls.push({url,resolve,reject})),
  });
  vm.runInContext(app.slice(start,end) + '\nthis.startSearch=startClientDialogSearch; this.merge=mergeClientDialogSearchResults; this.remote=()=>clientDialogRemoteSearch;',context);
  const runTimer = async () => { const [id,fn] = timers.entries().next().value; timers.delete(id); const result=fn(); await Promise.resolve(); return result; };
  return { state,input,timers,calls,context,runTimer };
}

test('debounced remote search is isolated by account, request and input clearing', async () => {
  const h=harness();
  h.input.value='a'; h.context.startSearch();
  h.input.value='alpha'; h.context.startSearch();
  assert.equal(h.timers.size,1);
  const first=h.runTimer();
  assert.match(h.calls[0].url,/query=alpha/);
  h.state.clientSelectedInstance='b'; h.context.startSearch();
  const second=h.runTimer();
  h.calls[1].resolve([{id:2}]); await second;
  h.calls[0].resolve([{id:1}]); await first;
  assert.equal(h.context.remote().results[0].id,2);
  assert.equal(h.context.remote().instId,'b');
  h.input.value=''; h.context.startSearch();
  assert.equal(h.context.remote().results.length,0);
  assert.equal(h.timers.size,0);
});

test('loaded chats and remote peers are combined without duplicates or losing unread state', () => {
  const h=harness();
  const loaded=[{id:1,title:'Alpha',unreadCount:4},{id:2,title:'Beta',unreadCount:6}];
  const remote=[{id:1,title:'Alpha'},{id:2,title:'Other spelling'},{id:3,title:'Public'}];
  const result=h.context.merge('alpha',loaded,remote);
  assert.deepEqual(Array.from(result,x=>x.id),[1,2,3]);
  assert.equal(result[1].unreadCount,6);
  assert.equal(loaded.length,2);
});

test('stale failures do not replace a newer successful search', async () => {
  const h=harness(); h.input.value='first'; h.context.startSearch(); const first=h.runTimer();
  h.input.value='second'; h.context.startSearch(); const second=h.runTimer();
  h.calls[1].resolve([{id:2}]); await second;
  h.calls[0].reject(new Error('offline')); await first;
  assert.equal(h.context.remote().error,false);
  assert.equal(h.context.remote().query,'second');
});

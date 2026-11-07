'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/js/cloud-drafts.js','utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function tick(){await Promise.resolve();await Promise.resolve();}
function fixture(){
  const state={clientSelectedInstance:'a',clientActiveChatId:1,clientDrafts:{},clientDialogs:[{id:1}],clientEditingMessageId:null};
  const nodes={'client-message-textarea':{value:''},'chat-reply-banner':{style:{}},'reply-banner-sender':{},'reply-banner-text':{},
    'cloud-draft-status':{},'cloud-draft-status-text':{},'cloud-draft-use-remote':{},'cloud-draft-use-local':{},'cloud-draft-retry':{}};
  const requests=[], warnings=[], timers=new Map(); let id=0;
  const window={confirm:()=>true};
  const context=vm.createContext({window,state,document:{getElementById:key=>nodes[key]||null},encodeURIComponent,
    showToast:text=>warnings.push(text),autoResizeTextarea(){},renderClientDialogs(){},
    api:(url,method,body)=>{const d=deferred();requests.push({url,method:method||'GET',body,...d});return d.promise;},
    setTimeout:fn=>{const n=++id;timers.set(n,fn);return n;},clearTimeout:n=>timers.delete(n)});
  vm.runInContext(source,context);
  return {state,nodes,requests,warnings,drafts:window.CloudDrafts,runTimers(){for(const [n,fn] of [...timers]){timers.delete(n);fn();}},get timerCount(){return timers.size;}};
}
test('loads a plain remote draft and restores a basic reply',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);
  f.requests[0].resolve({draft:{text:'hello',replyToMessageId:7,hasUnsupportedFeatures:false,date:1}});await pending;
  assert.equal(f.nodes['client-message-textarea'].value,'hello');
  assert.equal(f.state.clientReplyingTo.id,7);
  assert.equal(f.nodes['chat-reply-banner'].style.display,'flex');
});
test('complex drafts remain protected and never auto-save edited text',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);
  f.requests[0].resolve({draft:{text:'formatted',hasUnsupportedFeatures:true}});await pending;
  f.drafts.changed('a',1,'replacement',null);f.runTimers();await tick();
  assert.equal(f.requests.length,1);assert.match(f.warnings.at(-1),/不会覆盖云端/);
});
test('typing before a remote response does not overwrite existing cloud draft',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);
  f.drafts.changed('a',1,'local',null);
  f.requests[0].resolve({draft:{text:'remote',hasUnsupportedFeatures:false}});await pending;
  f.runTimers();await tick();
  assert.equal(f.requests.length,1);assert.match(f.warnings.at(-1),/未覆盖云端/);
});
test('typing with an empty remote draft debounces and serializes saves',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);
  f.drafts.changed('a',1,'one',null);f.requests[0].resolve({draft:null});await pending;
  f.runTimers();await tick();assert.equal(f.requests[1].body.text,'one');
  f.drafts.changed('a',1,'two',null);f.runTimers();assert.equal(f.requests.length,2);
  f.requests[1].resolve({success:true});await tick();f.runTimers();await tick();
  assert.equal(f.requests[2].body.text,'two');
});
test('a remote change while local edits are pending blocks overwriting',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'local',null);f.drafts.incoming('a',1,{text:'elsewhere',hasUnsupportedFeatures:false});
  f.runTimers();await tick();assert.equal(f.requests.length,1);assert.match(f.warnings.at(-1),/其他设备/);
  assert.equal(f.nodes['cloud-draft-status'].hidden,false);
});
test('a remote conflict during a write remains visible when that write completes',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'local',null);f.runTimers();await tick();
  f.drafts.incoming('a',1,{text:'remote',hasUnsupportedFeatures:false});
  f.requests[1].resolve({success:true});await tick();
  assert.equal(f.nodes['cloud-draft-status'].hidden,false);
  assert.equal(f.drafts.getText('a',1,null),'local');
});
test('resolving with the cloud reads the latest value before discarding local text',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'local',null);f.drafts.incoming('a',1,{text:'remote',hasUnsupportedFeatures:false});
  const resolve=f.drafts.resolveConflict('remote');
  f.requests[1].resolve({draft:{text:'newest',hasUnsupportedFeatures:false}});await resolve;
  assert.equal(f.nodes['client-message-textarea'].value,'newest');
  assert.equal(f.nodes['cloud-draft-status'].hidden,true);
});
test('explicit local overwrite re-reads the cloud and newer changes cancel the choice',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'local',null);f.drafts.incoming('a',1,{text:'remote',hasUnsupportedFeatures:false});
  let resolve=f.drafts.resolveConflict('local');
  f.drafts.changed('a',1,'new input',null);f.requests[1].resolve({draft:{text:'remote',hasUnsupportedFeatures:false}});await resolve;
  f.runTimers();assert.equal(f.requests.length,2);
  resolve=f.drafts.resolveConflict('local');f.requests[2].resolve({draft:{text:'remote',hasUnsupportedFeatures:false}});await resolve;
  f.runTimers();await tick();assert.equal(f.requests[3].body.text,'new input');
});
test('a later remote push wins over an older in-flight read',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);
  f.drafts.incoming('a',1,{text:'new',hasUnsupportedFeatures:false});
  f.requests[0].resolve({draft:{text:'old',hasUnsupportedFeatures:false}});await pending;
  assert.equal(f.nodes['client-message-textarea'].value,'new');
});
test('successful send clears only unchanged drafts; newer typing wins',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'sent',null);const send=f.drafts.beginSend('a',1,'sent',null);
  f.drafts.changed('a',1,'new',null);f.drafts.finishSend(send,true);f.runTimers();await tick();
  assert.equal(f.requests[1].body.text,'new');
});
test('failed send keeps the original draft eligible for retry',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'unsent',null);const send=f.drafts.beginSend('a',1,'unsent',null);
  f.drafts.finishSend(send,false);f.runTimers();await tick();
  assert.equal(f.requests[1].body.text,'unsent');
});
test('a successful send queues an explicit clear after any in-flight draft save',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);f.requests[0].resolve({draft:null});await pending;
  f.drafts.changed('a',1,'sent',null);f.runTimers();await tick();
  const send=f.drafts.beginSend('a',1,'sent',null);f.drafts.finishSend(send,true);
  f.requests[1].resolve({success:true});await tick();f.runTimers();await tick();
  assert.equal(f.requests[2].body.text,'');
});
test('logout invalidates outstanding reads and saved state',async()=>{
  const f=fixture(), pending=f.drafts.open('a',1);
  f.drafts.clearAccount('a');f.state.clientSelectedInstance='b';
  f.requests[0].resolve({draft:{text:'secret',hasUnsupportedFeatures:false}});await pending;
  assert.equal(f.nodes['client-message-textarea'].value,'');assert.equal(f.drafts.getText('b',1,null),'');
});

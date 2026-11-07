'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('let profileEditorVersion = 0;');
const end = source.indexOf('async function doPeerLookup()', start);
if (start < 0 || end < 0) throw new Error('Cannot locate profile editor');

function setup() {
  const ids = ['modal-profile','btn-save-profile','profile-input-firstname','profile-input-lastname','profile-input-bio',
    'profile-editor-display-name','profile-display-username','profile-display-id','profile-display-phone','profile-avatar-large'];
  const nodes = Object.fromEntries(ids.map(id => [id, { value:'', innerText:'', disabled:false }]));
  let active = false;
  nodes['modal-profile'].classList = { add: () => {active=true;}, remove: () => {active=false;}, contains: () => active };
  const calls = [], notices = [];
  const state = { clientSelectedInstance:'a' };
  let nextProfile;
  const context = vm.createContext({state, document:{getElementById:id=>nodes[id]},
    showToast: msg=>notices.push(msg), async loadInstances(){},
    api:(url,method,body)=>{calls.push({url,method,body});return method==='POST' ? Promise.resolve({success:true}) : new Promise((resolve,reject)=>{nextProfile={resolve,reject};});}
  });
  vm.runInContext(source.slice(start,end)+'\nthis.openProfileModal = openProfileModal; this.saveProfileModal = saveProfileModal; this.closeProfileModal = closeProfileModal;', context);
  return {context,nodes,state,calls,notices,profile:()=>nextProfile};
}

test('editing a name does not send or erase the existing bio', async()=>{
  const h=setup(); const opening=h.context.openProfileModal();
  h.profile().resolve({id:1,firstName:'Old',lastName:'Name',bio:'existing bio'}); await opening;
  h.nodes['profile-input-firstname'].value='New'; await h.context.saveProfileModal();
  assert.equal(h.calls[1].body.firstName,'New');
  assert.equal(Object.hasOwn(h.calls[1].body,'bio'),false);
  assert.equal(Object.hasOwn(h.calls[1].body,'lastName'),false);
});
test('explicitly clearing bio remains possible', async()=>{
  const h=setup(); const opening=h.context.openProfileModal();
  h.profile().resolve({id:1,firstName:'Name',bio:'existing bio'}); await opening;
  h.nodes['profile-input-bio'].value=''; await h.context.saveProfileModal();
  assert.equal(h.calls[1].body.bio,'');
});
test('changing bio does not change an unedited name containing whitespace', async()=>{
  const h=setup(); const opening=h.context.openProfileModal();
  h.profile().resolve({id:1,firstName:' Name ',lastName:' Surname ',bio:'bio'}); await opening;
  h.nodes['profile-input-bio'].value='updated'; await h.context.saveProfileModal();
  assert.equal(Object.hasOwn(h.calls[1].body,'firstName'),false);
  assert.equal(Object.hasOwn(h.calls[1].body,'lastName'),false);
});
test('failed or incomplete load disables saving and preserves remote data', async()=>{
  const h=setup(); const opening=h.context.openProfileModal();
  h.profile().resolve({id:1,firstName:'Name'}); await opening;
  assert.equal(h.nodes['btn-save-profile'].disabled,true);
  await h.context.saveProfileModal(); assert.equal(h.calls.length,1);
});
test('late response cannot expose or submit another account profile', async()=>{
  const h=setup(); const first=h.context.openProfileModal();
  const a=h.profile(); h.state.clientSelectedInstance='b'; const second=h.context.openProfileModal();
  h.profile().resolve({id:2,firstName:'B',bio:'B bio'}); await second;
  a.resolve({id:1,firstName:'A',bio:'A bio'}); await first;
  assert.equal(h.nodes['profile-input-firstname'].value,'B');
  assert.equal(h.nodes['profile-input-bio'].value,'B bio');
  h.state.clientSelectedInstance='a'; await h.context.saveProfileModal(); assert.equal(h.calls.length,2);
});
test('switching away and back invalidates the old account request', async()=>{
  const h=setup(); h.state.chatSelectionVersion = 1; const opening=h.context.openProfileModal();
  h.state.clientSelectedInstance='b'; h.state.chatSelectionVersion++;
  h.state.clientSelectedInstance='a'; h.state.chatSelectionVersion++;
  h.profile().resolve({id:1,firstName:'Old account',bio:'old'}); await opening;
  assert.equal(h.nodes['profile-input-firstname'].value,'');
  assert.equal(h.nodes['btn-save-profile'].disabled,true);
});

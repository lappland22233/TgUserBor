'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js','utf8');
const start = source.indexOf('async function initClientView()');
const end = source.indexOf('\nfunction updateClientAccountBadge()', start);
if (start < 0 || end < 0) throw new Error('Cannot locate client initialization');
function setup(instances) {
  const state = {instances, clientSelectedInstance:'old', clientActiveChatId:9, clientMessages:[{id:1}]};
  const select = {innerHTML:'', appendChild(){}, value:''}, name = {};
  const cleared=[], resets=[];
  const context=vm.createContext({state, document:{getElementById:id=>id==='client-account-select'?select:name, createElement:()=>({})},
    window:{DialogFolders:{load(){}}, GlobalMessageSearch:{reset:()=>resets.push(1)}}, resetClientExpressions(){}, reloadClientExpressionsIfOpen(){},
    clearLoggedOutAccountState:id=>{cleared.push(id);state.clientActiveChatId=null;state.clientMessages=[];},
    startClientDialogSearch(){}, updateClientAccountBadge(){}, async loadClientDialogs(){}, loadClientStoriesFeed(){} });
  vm.runInContext(source.slice(start,end)+'\nthis.initClientView = initClientView;',context);
  return {context,state,cleared,resets};
}
test('removing the last account clears the selected account and old chat state',async()=>{
  const h=setup([]); await h.context.initClientView();
  assert.equal(h.state.clientSelectedInstance,null); assert.equal(h.state.clientActiveChatId,null);
  assert.deepEqual(h.cleared,['old']); assert.equal(h.resets.length,1);
});
test('automatically selecting another account first clears the previous chat',async()=>{
  const h=setup([{config:{id:'new',name:'new'},status:'ONLINE'}]); await h.context.initClientView();
  assert.equal(h.state.clientSelectedInstance,'new'); assert.equal(h.state.clientActiveChatId,null);
  assert.deepEqual(h.cleared,['old']); assert.equal(h.resets.length,1);
});

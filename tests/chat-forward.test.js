'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('let pendingForwardContext = null;');
const end = source.indexOf('// Voice Recorder Controller', start);
if (start < 0 || end < 0) throw new Error('Cannot locate forward controller');
function setup() {
  const state = {clientSelectedInstance:'a', clientActiveChatId:1, chatSelectionVersion:1, clientDialogs:[], pendingForwardMsgIds:[]};
  const nodes = {'modal-forward-message':{style:{}}, 'forward-dialogs-list':{innerHTML:''}, 'forward-dialogs-search':{value:'',focus(){}}};
  const calls = [], notices = [];
  let resolve, exits = 0;
  const context = vm.createContext({state, window:{}, document:{getElementById:id=>nodes[id]},
    setTimeout: () => 0, escapeHtml:String, showToast:msg=>notices.push(msg),
    api:(url,method,body)=>{calls.push({url,method,body}); return new Promise(r=>{resolve=r;});},
    exitSelectionMode:()=>{exits++;}});
  vm.runInContext(source.slice(start,end)+'\nthis.open = openForwardModal; this.forward = executeForwardTo;',context);
  return {state, context, calls, notices, resolve:()=>resolve({}), get exits(){return exits;}};
}
test('forward refuses to use a new chat after the selection changes', async()=>{
  const h=setup(); h.context.open([4]); h.state.clientActiveChatId=2; h.state.chatSelectionVersion++;
  await h.context.forward({id:3,title:'target'});
  assert.equal(h.calls.length,0); assert.match(h.notices[0],/会话已切换/);
});
test('forward captures the original account and never clears new selection', async()=>{
  const h=setup(); h.context.open([4]); const pending=h.context.forward({id:3,title:'target'});
  assert.equal(h.calls[0].body.fromChatId,1); assert.equal(h.calls[0].body.toChatId,3);
  h.state.clientSelectedInstance='b'; h.state.chatSelectionVersion++;
  h.resolve(); await pending; assert.equal(h.exits,0);
});

test('forwarding one loaded album item includes each loaded photo and video from that group once', async()=>{
  const h=setup();
  h.state.clientMessages=[
    {id:10, groupedId:'album-1', media:{type:'photo'}},
    {id:11, groupedId:'album-1', media:{type:'video'}},
    {id:12, media:{type:'photo'}},
    {id:13, groupedId:'album-1', media:{type:'photo'}},
  ];
  h.context.open([11,11]);
  assert.deepEqual(Array.from(h.state.pendingForwardMsgIds),[10,11,13]);
  h.state.clientActiveChatId=2;
  await h.context.forward({id:3,title:'target'});
  assert.equal(h.calls.length,0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/js/forum-topics.js', 'utf8');

class Node {
  constructor() { this.children=[]; this.style={}; this.hidden=false; this.disabled=false; this.dataset={}; this.textContent=''; this.value=''; }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children=[...nodes]; }
  addEventListener() {}
  focus() {}
  querySelector(selector) { return this.parts?.[selector] || null; }
}
function setup() {
  const requests=[], state={clientSelectedInstance:'a',clientActiveChatId:-100123,chatSelectionVersion:1,clientDialogs:[],clientMessages:[{id:999,text:'main'}]};
  const button = new Node();
  let overlay;
  const document={head:new Node(),body:new Node(),addEventListener(){},
    getElementById:id => id==='btn-chat-topics' ? button : null,
    createElement:tag => {
      const node=new Node();
      if (tag==='div' && !overlay) {
        overlay=node;
        node.parts=Object.fromEntries(['#forum-title','.forum-status','.forum-list','.forum-more','[data-back]','.forum-compose','textarea','[data-send]','.forum-reply','[data-close]'].map(key=>[key,new Node()]));
      }
      return node;
    }};
  const window={addEventListener(){}};
  const ctx=vm.createContext({state,document,window,MutationObserver:class{observe(){}},URLSearchParams,encodeURIComponent,queueMicrotask,
    api:(url,method,body)=>new Promise((resolve,reject)=>requests.push({url,method,body,resolve,reject}))});
  vm.runInContext(source,ctx);
  return {state,document,window,button,requests,get modal(){return overlay;}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('forum from remote search is reachable and never alters the main chat', async () => {
  const h=setup();
  h.window.ForumTopics.setDialog({id:-100123,isForum:true,title:'forum'});
  assert.equal(h.button.hidden,false);
  h.window.ForumTopics.open();
  assert.match(h.requests[0].url,/forum-topics/);
  h.requests[0].resolve({topics:[{id:10,title:'thread'}]}); await tick();
  const list=h.modal.parts['.forum-list'];
  list.children[0].children[0].onclick();
  assert.match(h.requests[1].url,/forum-messages/);
  h.requests[1].resolve([{id:3,text:'new'},{id:2,text:'old'}]); await tick();
  assert.deepEqual(list.children.map(row=>row.children[1].textContent),['old','new']);
  assert.deepEqual(h.state.clientMessages,[{id:999,text:'main'}]);
});
test('opening an unread topic acknowledges only its latest visible message',async()=>{
  const h=setup(); const topic={id:10,title:'thread',unreadCount:2};
  h.window.ForumTopics.setDialog({id:-100123,isForum:true}); h.window.ForumTopics.open();
  h.requests[0].resolve({topics:[topic]}); await tick();
  h.modal.parts['.forum-list'].children[0].children[0].onclick();
  h.requests[1].resolve([{id:30,text:'latest'},{id:29,text:'older'}]); await tick();
  assert.match(h.requests[2].url,/forum-topic-read/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[2].body)),{chatId:-100123,topicId:10,maxId:30});
  h.requests[2].resolve({success:true}); await tick();
  assert.equal(topic.unreadCount,0);
  assert.deepEqual(h.state.clientMessages,[{id:999,text:'main'}]);
});
test('switching accounts closes and discards in-flight forum results',async()=>{
  const h=setup(); h.window.ForumTopics.setDialog({id:-100123,isForum:true}); h.window.ForumTopics.open();
  h.state.clientSelectedInstance='b'; h.state.chatSelectionVersion++;
  h.window.ForumTopics.setDialog(null);
  h.requests[0].resolve({topics:[{id:10,title:'old'}]}); await tick();
  assert.equal(h.modal.hidden,true); assert.equal(h.button.hidden,true);
  assert.equal(h.modal.parts['.forum-list'].children.length,0);
});
test('initial topic and history failures can be retried',async()=>{
  const h=setup(); h.window.ForumTopics.setDialog({id:-100123,isForum:true}); h.window.ForumTopics.open();
  h.requests[0].reject(new Error('offline')); await tick();
  const more=h.modal.parts['.forum-more']; assert.equal(more.hidden,false);
  more.onclick(); assert.match(h.requests[1].url,/forum-topics/);
  h.requests[1].resolve({topics:[{id:10,title:'thread'}]}); await tick();
  h.modal.parts['.forum-list'].children[0].children[0].onclick();
  h.requests[2].reject(new Error('offline')); await tick();
  assert.equal(more.hidden,false); more.onclick(); assert.match(h.requests[3].url,/forum-messages/);
  h.requests[3].resolve([]); await tick();
});
test('a pending send from a previous topic cannot block or clear a new composer',async()=>{
  const h=setup(); h.window.ForumTopics.setDialog({id:-100123,isForum:true}); h.window.ForumTopics.open();
  h.requests[0].resolve({topics:[{id:10,title:'first'},{id:20,title:'second'}]}); await tick();
  let list=h.modal.parts['.forum-list']; list.children[0].children[0].onclick(); h.requests[1].resolve([]); await tick();
  const input=h.modal.parts['textarea'], send=h.modal.parts['[data-send]']; input.value='first text'; send.onclick();
  assert.equal(send.disabled,true);
  h.modal.parts['[data-back]'].onclick(); h.requests[3].resolve({topics:[{id:20,title:'second'}]}); await tick();
  list=h.modal.parts['.forum-list']; list.children[0].children[0].onclick(); h.requests[4].resolve([]); await tick();
  input.value='second text'; assert.equal(send.disabled,false);
  h.requests[2].resolve({messageId:1}); await tick();
  assert.equal(input.value,'second text'); assert.equal(send.disabled,false);
});
test('opening the combined forum history never clears all topic unread counts',async()=>{
  const app=fs.readFileSync('src/gui/web/app.js','utf8');
  const start=app.indexOf('async function markVisibleChatRead('), end=app.indexOf('\nfunction updateClientHistoryBanner(',start);
  if(start<0||end<0)throw new Error('Cannot locate chat read handler');
  const state={clientSelectedInstance:'a',clientActiveChatId:-100123,clientHistoryOffsetDate:null,chatSelectionVersion:1,
    clientDialogs:[{id:-100123,isForum:true,unreadCount:3}],clientMessages:[{id:10}]};
  let requests=0;
  const context=vm.createContext({state,window:{},document:{hidden:false,hasFocus:()=>true,getElementById:()=>({classList:{contains:()=>true}})},
    api:async()=>{requests++;},renderClientDialogs(){},encodeURIComponent});
  vm.runInContext(app.slice(start,end)+'\nthis.markRead=markVisibleChatRead;',context);
  await context.markRead('a',-100123);
  assert.equal(requests,0); assert.equal(state.clientDialogs[0].unreadCount,3);
});

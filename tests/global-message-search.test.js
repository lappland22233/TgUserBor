'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/global-message-search.js'), 'utf8');
class Element {
  constructor() { this.children=[]; this.listeners={}; this.hidden=false; this.value=''; this.dataset={}; this.textContent=''; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn(); if (this[`on${type}`]) return this[`on${type}`](); }
  setAttribute(name, value) { this[name] = value; }
  replaceChildren() { this.children=[]; }
  appendChild(child) { this.children.push(child); }
  append(...children) { this.children.push(...children); }
}
function harness() {
  const nodes = Object.fromEntries(['global-message-results','client-dialogs-list','btn-global-message-search','global-message-search-filter','client-dialogs-search','client-account-select'].map(id=>[id,new Element()]));
  const state={clientSelectedInstance:'a', clientDialogs:[], clientActiveChatId:null};
  const calls=[],selections=[],timers = new Map(); let next=0, load;
  const window={addEventListener:(event,fn)=>{ if(event==='load') load=fn; }};
  const document={getElementById:id=>nodes[id],createElement:()=>new Element()};
  const context=vm.createContext({window,document,state,URLSearchParams,encodeURIComponent,Date,Promise,
    api:url=>new Promise((resolve,reject)=>calls.push({url,resolve,reject})),
    setTimeout:fn=>{ timers.set(++next,fn); return next; },clearTimeout:id=>timers.delete(id),
    selectClientChat:async (...args)=>{selections.push(args);},
  });
  vm.runInContext(source,context);load();
  async function runTimer(){ const first=timers.entries().next().value; assert.ok(first); timers.delete(first[0]); first[1](); await Promise.resolve(); }
  return {nodes,state,calls,selections,runTimer,timers};
}
const msg=(id,chat=42)=>({id,chat:{id:chat,title:'Chat'},text:`message ${id}`,date:1700000000000});

test('global search paginates with the cursor and deduplicates results',async()=>{
  const h=harness(); h.nodes['client-dialogs-search'].value='hello'; h.nodes['global-message-search-filter'].value='photos'; h.nodes['btn-global-message-search'].fire('click');
  await h.runTimer(); assert.match(h.calls[0].url,/query=hello/);
  assert.match(h.calls[0].url,/filter=photos/);
  h.calls[0].resolve({messages:[msg(1)],nextCursor:{peer:'42',id:1,rate:9}}); await Promise.resolve(); await Promise.resolve();
  const panel=h.nodes['global-message-results']; assert.equal(panel.children.filter(x=>x.className==='global-message-result').length,1);
  const pending = panel.children.find(x=>x.className.includes('global-message-more')).onclick();
  assert.match(h.calls[1].url,/peer=42/); assert.match(h.calls[1].url,/rate=9/);
  assert.match(h.calls[1].url,/filter=photos/);
  h.calls[1].resolve({messages:[msg(1),msg(2)]}); await pending;
  assert.equal(panel.children.filter(x=>x.className==='global-message-result').length,2);
});

test('global search can search a media type without a text query', async()=>{
  const h=harness(); h.nodes['global-message-search-filter'].value='videos'; h.nodes['btn-global-message-search'].fire('click');
  await h.runTimer();
  assert.match(h.calls[0].url,/query=&filter=videos/);
  h.calls[0].resolve({messages:[msg(8)]}); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.nodes['global-message-results'].children.filter(x=>x.className==='global-message-result').length,1);
});

test('account change uses the new account and ignores late old results',async()=>{
  const h=harness(); h.nodes['client-dialogs-search'].value='search'; h.nodes['btn-global-message-search'].fire('click');
  await h.runTimer();
  h.nodes['client-account-select'].onchange=()=>{h.state.clientSelectedInstance='b';};
  h.nodes['client-account-select'].fire('change'); await Promise.resolve();
  await h.runTimer(); assert.match(h.calls[1].url,/instances\/b\//);
  h.calls[1].resolve({messages:[msg(2)]}); await Promise.resolve(); await Promise.resolve();
  h.calls[0].resolve({messages:[msg(1)]}); await Promise.resolve(); await Promise.resolve();
  const rows=h.nodes['global-message-results'].children.filter(x=>x.className==='global-message-result');
  assert.equal(rows.length,1); assert.equal(rows[0].children[1].textContent,'message 2');
});

test('search result opens an anchored historical view without selecting latest',async()=>{
  const h=harness(); h.nodes['client-dialogs-search'].value='search'; h.nodes['btn-global-message-search'].fire('click');
  await h.runTimer(); h.calls[0].resolve({messages:[msg(7)]}); await Promise.resolve(); await Promise.resolve();
  await h.nodes['global-message-results'].children.find(x=>x.className==='global-message-result').onclick();
  assert.equal(h.selections.length,1);
  assert.equal(h.selections[0][0].id,42);
  assert.equal(h.selections[0][1].historyAnchor.id,7);
  assert.equal(h.selections[0][1].historyAnchor.date,1700000001);
});

test('failed page can be retried with the same cursor',async()=>{
  const h=harness(); h.nodes['client-dialogs-search'].value='search'; h.nodes['btn-global-message-search'].fire('click');
  await h.runTimer(); h.calls[0].resolve({messages:[msg(1)],nextCursor:{peer:'42',id:1,rate:9}}); await Promise.resolve(); await Promise.resolve();
  const pending=h.nodes['global-message-results'].children.find(x=>x.className.includes('global-message-more')).onclick();
  h.calls[1].reject(new Error('offline')); await pending;
  const button=h.nodes['global-message-results'].children.find(x=>x.className.includes('global-message-more'));
  assert.equal(button.textContent,'重试'); button.onclick();
  assert.equal(h.calls[2].url,h.calls[1].url);
});

test('opening an anchor does not mark unread chat as read or load its latest messages', async () => {
  const app = fs.readFileSync(path.join(__dirname,'../src/gui/web/app.js'),'utf8');
  const start = app.indexOf('async function selectClientChat('), end = app.indexOf('let isLoadingEarlierMessages',start);
  assert.ok(start >= 0 && end > start);
  const state = {clientSelectedInstance:'a',clientDialogs:[],clientMessages:[{id:1}],clientActiveChatId:1,clientDrafts:{}};
  const chat = {id:42,title:'Unread',type:'private',unreadCount:9}; state.clientDialogs.push(chat);
  const elements = { 'client-chat-title':{}, 'client-chat-subtitle':{}, 'client-chat-actions':{style:{}}, 'client-messages-container':{} };
  let read=0, latest=0, anchor;
  const context=vm.createContext({state,window:{chatWs:{recordDialogRead(){read++;},isConnected(){return true;},sendRpc(){read++;return Promise.resolve();}}},
    document:{getElementById:id=>elements[id]||null,querySelector:()=>null},currentPreviewVideo:null,
    clientDraftKey:()=>'',toggleChatSearchBar(){},cancelReplyBanner(){},cancelEditBanner(){},clearStagedAttachment(){},renderClientDialogs(){},updateClientDialogSelection(){},updateClientHistoryBanner(){},updateChatMuteButtonState(){},
    loadClientMessages(){latest++;},loadClientMessagesAround:async (...args)=>{anchor=args;return true;},
  });
  vm.runInContext(app.slice(start,end)+'\nthis.select = selectClientChat;',context);
  await context.select(chat,{historyAnchor:{id:7,date:123}});
  assert.equal(chat.unreadCount,9); assert.equal(read,0); assert.equal(latest,0);
  assert.deepEqual(anchor,[42,7,123]); assert.equal(state.clientHistoryOffsetDate,123);
});

test('late context response cannot replace a newly selected chat',async()=>{
  const app=fs.readFileSync(path.join(__dirname,'../src/gui/web/app.js'),'utf8');
  const start=app.indexOf('async function loadClientMessagesAround('),end=app.indexOf('async function loadClientMessagesWithDate(',start);
  assert.ok(start>=0 && end>start);
  const state={clientSelectedInstance:'a',clientActiveChatId:1,clientMessages:[{id:99}]};
  let request=0,resolve,finished=0,rendered=0;
  const context=vm.createContext({state,window:{chatWs:{beginMessageSnapshot:()=>({}),finishMessageSnapshot:()=>{finished++;}}},URLSearchParams,encodeURIComponent,Date,
    api:()=>new Promise(r=>{resolve=r;}),isCurrentMessagesRequest:(n,inst,chat)=>n===request && state.clientSelectedInstance===inst && state.clientActiveChatId===chat,
    renderClientMessages:()=>rendered++,scrollToMessage(){},updateClientHistoryBanner(){},showToast(){},
  });
  Object.defineProperty(context,'clientMessagesRequest',{get:()=>request,set:n=>{request=n;},configurable:true});
  Object.defineProperty(context,'isLoadingEarlierMessages',{value:false,writable:true});
  Object.defineProperty(context,'hasReachedEarliestMessage',{value:false,writable:true});
  vm.runInContext(app.slice(start,end)+'\nthis.around=loadClientMessagesAround;',context);
  const pending=context.around(1,7,123);state.clientActiveChatId=2;
  resolve([{id:7}]);assert.equal(await pending,false);
  assert.equal(state.clientMessages[0].id,99);assert.equal(rendered,0);assert.equal(finished,1);
});

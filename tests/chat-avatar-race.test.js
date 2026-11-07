'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js','utf8');
const start = source.indexOf('class NetworkScheduler {');
const end = source.indexOf('\nconst scheduler = new NetworkScheduler', start);
const chatStart = source.indexOf('async function selectClientChat(');
const chatEnd = source.indexOf('\nlet isLoadingEarlierMessages', chatStart);
if ([start,end,chatStart,chatEnd].some(x=>x < 0)) throw new Error('Cannot locate avatar functions');

test('newer avatar requests and account changes cannot be overwritten by an older load', async () => {
  const images = [], requests = [], revoked = [];
  class FakeImage { constructor() { images.push(this); } }
  const fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
  const URL = { createObjectURL: blob => `blob:${blob.id}`, revokeObjectURL: url => revoked.push(url) };
  const context = vm.createContext({ Image: FakeImage, WeakMap, AbortController, URL, fetch });
  vm.runInContext(source.slice(start,end)+'\nthis.NetworkScheduler = NetworkScheduler;',context);
  const scheduler = new context.NetworkScheduler(3), target = {src:''};
  const old = scheduler.loadImage(target, '/old');
  const current = scheduler.loadImage(target, '/new');
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].resolve({ok:true, blob: async () => ({id:'new'})});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(images.length, 1); assert.equal(images[0].src, 'blob:new');
  images[0].onload(); assert.equal(await current, true); assert.equal(target.src, 'blob:new');
  requests[0].resolve({ok:true, blob: async () => ({id:'old'})});
  assert.equal(await old, false); assert.equal(target.src, 'blob:new');
  const abandoned = scheduler.loadImage(target, '/abandoned');
  scheduler.cancelImage(target);
  assert.equal(requests[2].options.signal.aborted, true);
  requests[2].resolve({ok:true, blob: async () => ({id:'abandoned'})});
  assert.equal(await abandoned, false); assert.equal(target.src, 'blob:new');
  assert.deepEqual(revoked, ['blob:new']);
});

test('image replacement and failures release object URLs and respect the fallback', async () => {
  const images = [], revoked = [], calls = [];
  class FakeImage { constructor() { images.push(this); } }
  const fetch = async url => { calls.push(url); return url === '/bad' ? { ok: false } : { ok: true, blob: async () => ({id:url}) }; };
  const URL = { createObjectURL: blob => `blob:${blob.id}`, revokeObjectURL: url => revoked.push(url) };
  const context = vm.createContext({Image:FakeImage,WeakMap,AbortController,URL,fetch});
  vm.runInContext(source.slice(start,end)+'\nthis.NetworkScheduler = NetworkScheduler;',context);
  const scheduler = new context.NetworkScheduler(3), target = {src:''};
  const first = scheduler.loadImage(target, '/first');
  await new Promise(resolve => setImmediate(resolve)); images[0].onload(); assert.equal(await first, true);
  const second = scheduler.loadImage(target, '/second');
  await new Promise(resolve => setImmediate(resolve)); images[1].onload(); assert.equal(await second, true);
  assert.deepEqual(revoked, ['blob:/first']);
  assert.equal(target.src, 'blob:/second');
  assert.equal(await scheduler.loadImage(target, '/bad', '/fallback'), false);
  assert.equal(target.src, '/fallback'); assert.deepEqual(revoked, ['blob:/first', 'blob:/second']);
  assert.deepEqual(calls, ['/first', '/second', '/bad']);
});

test('late previous-chat avatar failure cannot hide the current avatar', async () => {
  const state = {clientSelectedInstance:'a',clientActiveChatId:null,chatSelectionVersion:0,clientDrafts:{},clientMessages:[],clientDialogs:[]};
  const img={style:{},src:''}, text={style:{},innerText:''};
  const elements={ 'client-chat-avatar-img':img, 'client-chat-avatar':text,
    'client-message-textarea':{value:''}, 'client-chat-title':{}, 'client-chat-subtitle':{}, 'client-chat-actions':{style:{}},
    'client-drawer':{classList:{contains:()=>false}}, 'client-messages-container':{innerHTML:''} };
  const pending=[];
  const context=vm.createContext({state,window:{},document:{getElementById:id=>elements[id]||null,querySelector:()=>({classList:{add(){}}})},
    scheduler:{loadImage:()=>new Promise(resolve=>pending.push(resolve))},
    clientDraftKey:id=>String(id),toggleChatSearchBar(){},cancelReplyBanner(){},cancelEditBanner(){},clearStagedAttachment(){},
    currentPreviewVideo:null,autoResizeTextarea(){},renderClientDialogs(){},updateChatMuteButtonState(){},
    async loadClientMessages(){return true;}, async markVisibleChatRead(){}, updateClientHistoryBanner(){},
  });
  vm.runInContext(source.slice(chatStart,chatEnd)+'\nthis.selectClientChat = selectClientChat;',context);
  await context.selectClientChat({id:1,title:'Old',type:'private'});
  await context.selectClientChat({id:2,title:'New',type:'private'});
  pending[1](true); await Promise.resolve(); assert.equal(text.style.display,'none');
  pending[0](false); await Promise.resolve();
  assert.equal(text.style.display,'none'); assert.equal(text.innerText,'Ne'); assert.equal(img.style.opacity,'1');
});

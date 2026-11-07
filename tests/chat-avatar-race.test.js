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
  const images=[];
  class FakeImage { constructor(){ images.push(this); } }
  const context=vm.createContext({Image:FakeImage,WeakMap});
  vm.runInContext(source.slice(start,end)+'\nthis.NetworkScheduler = NetworkScheduler;',context);
  const scheduler = new context.NetworkScheduler(3), target = {src:''};
  const old = scheduler.loadImage(target, '/old');
  const current = scheduler.loadImage(target, '/new');
  images[1].onload(); assert.equal(await current, true); assert.equal(target.src,'/new');
  images[0].onload(); assert.equal(await old, false); assert.equal(target.src,'/new');
  const abandoned = scheduler.loadImage(target, '/abandoned');
  scheduler.cancelImage(target); images[2].onload();
  assert.equal(await abandoned,false); assert.equal(target.src,'/new');
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

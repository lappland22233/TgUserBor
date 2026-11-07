'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { mapCloudDraft } = require('../dist/bot/driver/cloud-draft');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');
const { ChatWSGateway } = require('../dist/gui/ws-chat');
const { EventBus } = require('../dist/bot/core/event-bus');

test('actual Telegram draft objects preserve reply and flag unsupported features', () => {
  assert.equal(mapCloudDraft(new Api.DraftMessageEmpty({})), null);
  const simple = mapCloudDraft(new Api.DraftMessage({message:' hello ',date:1700000000,replyTo:new Api.InputReplyToMessage({replyToMsgId:42})}));
  assert.equal(simple.text, ' hello ');
  assert.equal(simple.date, 1700000000000);
  assert.equal(simple.replyToMessageId, 42);
  assert.equal(simple.hasUnsupportedFeatures, false);
  const rich = mapCloudDraft(new Api.DraftMessage({message:'bold',date:3,entities:[new Api.MessageEntityBold({offset:0,length:4})]}));
  assert.equal(rich.hasUnsupportedFeatures, true);
  assert.equal(rich.entities[0].type, 'MessageEntityBold');
  const quote = mapCloudDraft(new Api.DraftMessage({message:'x',date:3,replyTo:new Api.InputReplyToMessage({replyToMsgId:2,quoteText:'part'})}));
  assert.equal(quote.hasUnsupportedFeatures, true);
});

test('driver loads only the requested peer draft and sends real SaveDraft requests', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  const peer = new Api.InputPeerUser({userId:bigInt(42),accessHash:bigInt(5)});
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.messages.GetPeerDialogs) return {dialogs:[new Api.Dialog({peer:new Api.PeerUser({userId:bigInt(42)}),topMessage:1,readInboxMaxId:0,readOutboxMaxId:0,unreadCount:0,unreadMentionsCount:0,unreadReactionsCount:0,notifySettings:new Api.PeerNotifySettings({}),draft:new Api.DraftMessage({message:'cloud',date:123})})]};
      if (request instanceof Api.messages.SaveDraft) return true;
      throw new Error('unexpected');
    },
  };
  const draft = await driver.getDraft(42);
  assert.equal(draft.text, 'cloud');
  await driver.saveDraft(42, '**literal**', {parseMode:'plain',replyToMessageId:6});
  const request = calls.at(-1);
  assert.ok(request instanceof Api.messages.SaveDraft);
  assert.equal(request.message, '**literal**');
  assert.deepEqual(request.entities, []);
  assert.equal(request.replyTo.replyToMsgId, 6);
  await driver.saveDraft(42, '', {parseMode:'plain'});
  assert.equal(calls.at(-1).message, '');
  await assert.rejects(driver.saveDraft(42, 'x', {replyToMessageId:-1}), /无效/);
});

test('raw Telegram draft updates carry the correct peer and exclude topic drafts', async () => {
  const callbacks = [], events = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { addEventHandler: (callback, builder) => callbacks.push({callback,builder}) };
  driver.bus = new EventBus();
  driver.bus.on('draft:updated', event => events.push(event));
  driver.registerEventHandlers();
  const raw = callbacks.find(item => !item.builder).callback;
  const peer = new Api.PeerChat({chatId:bigInt(42)});
  await raw(new Api.UpdateDraftMessage({peer,draft:new Api.DraftMessage({message:'draft',date:10})}));
  assert.equal(events.length,1); assert.equal(events[0].chatId,-42); assert.equal(events[0].draft.text,'draft');
  await raw(new Api.UpdateDraftMessage({peer,topMsgId:8,draft:new Api.DraftMessage({message:'topic',date:11})}));
  assert.equal(events.length,1);
  await raw(new Api.UpdateDraftMessage({peer,draft:new Api.DraftMessageEmpty({})}));
  assert.equal(events[1].draft,null);
});

test('draft API and websocket target only the selected managed account', async () => {
  const calls=[];
  const accounts={a:{accountAction:async(action, params)=>{calls.push({id:'a',action,params});return action==='get_draft'?{draft:null}:{success:true};}},b:{accountAction:async(action,params)=>{calls.push({id:'b',action,params});return {draft:{text:'b'}};}}};
  const manager=new EventEmitter(); manager.getInstance=id=>accounts[id];
  const request=async(method,url,body)=>{
    const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method=method; req.url=url; req.headers={host:'localhost'};
    const out={writeHead(status,headers){this.status=status;this.headers=headers;},end(data){this.data=data;}};
    await handleApiRoute(req,out,manager,'/unused'); return out;
  };
  let out=await request('GET','/api/instances/a/account/draft?chatId=-42');
  assert.equal(out.status,200); assert.deepEqual(JSON.parse(out.data),{draft:null});
  out=await request('POST','/api/instances/a/account/draft',{chatId:-42,text:'hello',options:{replyToMessageId:5}});
  assert.equal(out.status,200); assert.deepEqual(calls.at(-1),{id:'a',action:'save_draft',params:{chatId:-42,text:'hello',options:{replyToMessageId:5}}});
  out=await request('POST','/api/instances/a/account/draft',{chatId:0,text:'hello'}); assert.equal(out.status,400);
  const gateway=new ChatWSGateway(manager,{});
  assert.deepEqual(await gateway.handleRpcAction('get_draft',{instId:'b',chatId:2}),{draft:{text:'b'}});
  await assert.rejects(gateway.handleRpcAction('save_draft',{instId:'a',chatId:2,text:1}),/Invalid draft/);
});

test('draft update events retain the originating account and chat on the stream', () => {
  const manager=new EventEmitter(); manager.getInstance=()=>undefined;
  const gateway=new ChatWSGateway(manager,{}), output=[];
  gateway.streamWss.clients.add({readyState:1,send:data=>output.push(JSON.parse(data))});
  manager.emit('raw_event',{type:'draft_updated',instId:'a',chatId:-42,draft:{text:'private',date:1}});
  assert.equal(output.length,1);
  assert.equal(output[0].instId,'a'); assert.equal(output[0].chatId,-42);
});

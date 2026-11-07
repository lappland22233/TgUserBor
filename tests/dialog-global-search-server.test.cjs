'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Api } = require('telegram');
const bigInt = require('big-integer');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { ChatWSGateway } = require('../dist/gui/ws-chat');

test('Telegram global peers have correct signed IDs and are deduplicated', async () => {
  let request;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async req => {
    request=req;
    return {
      myResults: [new Api.PeerUser({userId: bigInt(42)}), new Api.PeerChannel({channelId: bigInt(123)})],
      results: [new Api.PeerUser({userId: bigInt(42)}), new Api.PeerChat({chatId: bigInt(7)}), new Api.PeerUser({userId: bigInt(44)})],
      users: [new Api.User({id:bigInt(42),firstName:'Alice',username:'alice'}), new Api.User({id:bigInt(44),firstName:'Helper',bot:true})],
      chats: [new Api.Channel({id:bigInt(123), title:'Channel'}), new Api.Chat({id:bigInt(7), title:'Group'})],
    };
  } };
  const result = await driver.searchDialogs(' Alice ',50);
  assert.equal(request.className,'contacts.Search');
  assert.equal(request.q,'Alice');
  assert.deepEqual(result.map(d=>d.id),[42,-100123,-7,44]);
  assert.deepEqual(result.map(d=>d.type),['private','channel','group','private']);
  assert.equal(result[0].title,'Alice');
  assert.equal(result[0].isBot,false);
  assert.equal(result[3].isBot,true);
});

test('WebSocket searches only the requested account and rejects oversized queries', async () => {
  const calls=[];
  const manager=new EventEmitter();
  manager.getInstance=id=>id==='a'? {accountAction:async (action,params)=>{calls.push({action,params});return [{id:1}];}} : undefined;
  const gateway=new ChatWSGateway(manager,{});
  assert.deepEqual(await gateway.handleRpcAction('search_dialogs',{instId:'a',query:' alice '}),[{id:1}]);
  assert.deepEqual(calls,[{action:'search_dialogs',params:{query:'alice'}}]);
  await assert.rejects(gateway.handleRpcAction('search_dialogs',{instId:'b',query:'x'}),/not found/);
  await assert.rejects(gateway.handleRpcAction('search_dialogs',{instId:'a',query:'x'.repeat(129)}),/too long/);
});

test('HTTP search passes only the requested account and trimmed query', async () => {
  const { handleApiRoute } = require('../dist/gui/api');
  let received, account, status, body;
  const manager = { getInstance: id => { account=id; return { accountAction: async (action,params) => { received={action,params}; return [{id:42}]; } }; } };
  const req = { url:'/api/instances/a/account/search-dialogs?query=%20alice%20', method:'GET', headers:{} };
  const res = { writeHead: code => {status=code;}, end: value => {body=value;} };
  assert.equal(await handleApiRoute(req,res,manager,''),true);
  assert.equal(status,200);
  assert.equal(account,'a');
  assert.deepEqual(received,{action:'search_dialogs',params:{query:'alice'}});
  assert.deepEqual(JSON.parse(body),[{id:42}]);
});

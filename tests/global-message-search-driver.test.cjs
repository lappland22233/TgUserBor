'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Api}=require('telegram');
const bigInt=require('big-integer');
const {EntityCache}=require('telegram/entityCache');
const {TelegramDriver}=require('../dist/bot/driver/telegram');
const {handleApiRoute}=require('../dist/gui/api');

test('global search maps real Telegram messages and forwards the pagination cursor',async()=>{
  const driver=Object.create(TelegramDriver.prototype);
  const user=new Api.User({id:bigInt(42),firstName:'Alice',accessHash:bigInt(33)});
  const message=new Api.Message({id:9,peerId:new Api.PeerUser({userId:bigInt(42)}),fromId:new Api.PeerUser({userId:bigInt(42)}),date:1700000000,message:'needle'});
  let request, resolvedPeer;
  driver.client={_entityCache:new EntityCache(),getInputEntity:async p=>{resolvedPeer=p;return new Api.InputPeerUser({userId:bigInt(42),accessHash:bigInt(33)});},
    invoke:async r=>{request=r;return {messages:[message],users:[user],chats:[],nextRate:5};}};
  driver.logger={debug(){}};driver.selfUser={id:100,firstName:'Self'};
  const response=await driver.searchGlobalMessages(' needle ',1,{peer:'42',id:8,rate:3});
  assert.equal(request.className,'messages.SearchGlobal');assert.equal(request.q,'needle');
  assert.equal(request.offsetId,8);assert.equal(request.offsetRate,3);assert.equal(String(resolvedPeer),'42');
  assert.equal(response.messages[0].text,'needle');assert.equal(response.messages[0].chat.id,42);
  assert.deepEqual(response.nextCursor,{peer:'42',id:9,rate:5});
  await driver.searchGlobalMessages('',30,undefined,'photos');
  assert.ok(request.filter instanceof Api.InputMessagesFilterPhotos);
});

test('global search HTTP endpoint forwards cursor and rejects invalid requests',async()=>{
  let calls=[],status,body;
  const manager={getInstance:id=>({accountAction:async(action,params)=>{calls.push({id,action,params});return {messages:[]};}})};
  const res={writeHead:code=>{status=code;},end:value=>{body=value;}};
  await handleApiRoute({url:'/api/instances/a/account/search-global-messages?query=hello&peer=-100123&id=9&rate=3',method:'GET',headers:{}},res,manager,'');
  assert.equal(status,200);assert.deepEqual(calls[0],{id:'a',action:'search_global_messages',params:{query:'hello',cursor:{peer:'-100123',id:9,rate:3}}});
  await handleApiRoute({url:'/api/instances/a/account/search-global-messages?query=hello&peer=no&id=9&rate=3',method:'GET',headers:{}},res,manager,'');
  assert.equal(status,400);assert.equal(calls.length,1);assert.match(JSON.parse(body).error,/Invalid/);
  await handleApiRoute({url:'/api/instances/a/account/search-global-messages?filter=videos',method:'GET',headers:{}},res,manager,'');
  assert.equal(status,200);
  assert.deepEqual(calls[1],{id:'a',action:'search_global_messages',params:{query:'',searchFilter:'videos'}});
  await handleApiRoute({url:'/api/instances/a/account/search-global-messages?filter=unknown',method:'GET',headers:{}},res,manager,'');
  assert.equal(status,400);assert.equal(calls.length,2);
});

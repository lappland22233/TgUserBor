'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {handleApiRoute}=require('../dist/gui/api');

test('Telegram URL authorization routes validate button coordinates and explicit write access',async()=>{
  const calls=[];
  const instance={accountAction:async(action,payload)=>{calls.push({action,payload});return {type:'request',domain:'login.example'};}};
  const manager={getInstance:id=>id==='a'?instance:undefined};
  async function request(route,body) {
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);
    req.url=`/api/instances/a/account/${route}`;req.method='POST';req.headers={host:'localhost'};
    let status,payload;const res={writeHead:value=>{status=value;},end:value=>{payload=JSON.parse(value);}};
    await handleApiRoute(req,res,manager,'/tmp');return {status,payload};
  }
  const valid={chatId:-1001,messageId:22,row:0,column:1};
  assert.equal((await request('bot-url-auth',{...valid,row:-1})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await request('bot-url-auth',valid)).status,200);
  assert.equal((await request('bot-url-auth/accept',{...valid,writeAllowed:'true'})).status,400);
  assert.equal((await request('bot-url-auth/accept',{...valid,writeAllowed:false})).status,200);
  assert.deepEqual(calls,[
    {action:'request_bot_url_auth',payload:valid},
    {action:'accept_bot_url_auth',payload:{...valid,writeAllowed:false}},
  ]);
});

test('bot requested peer route rejects malformed targets and forwards only bounded selected peers',async()=>{
  const calls=[];const instance={accountAction:async(action,payload)=>{calls.push({action,payload});return {};}};
  const manager={getInstance:id=>id==='a'?instance:undefined};
  async function request(body) {
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.url='/api/instances/a/account/bot-request-peer';req.method='POST';req.headers={host:'localhost'};
    let status,payload;const res={writeHead:value=>{status=value;},end:value=>{payload=JSON.parse(value);}};
    await handleApiRoute(req,res,manager,'/tmp');return {status,payload};
  }
  const base={chatId:-1001,messageId:22,row:0,column:1};
  assert.equal((await request({...base,peerIds:[]})).status,400);
  assert.equal((await request({...base,peerIds:[101,101]})).status,400);
  assert.equal((await request({...base,peerIds:[101,102]})).status,200);
  assert.deepEqual(calls,[{action:'send_bot_requested_peers',payload:{...base,peerIds:[101,102]}}]);
});

test('bot requested peer search validates the query and binds it to the original keyboard message',async()=>{
  const calls=[];const instance={accountAction:async(action,payload)=>{calls.push({action,payload});return [{id:101,type:'private',title:'New user',unreadCount:0}];}};
  const manager={getInstance:id=>id==='a'?instance:undefined};
  async function request(body) {
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.url='/api/instances/a/account/bot-request-peer-search';req.method='POST';req.headers={host:'localhost'};
    let status,payload;const res={writeHead:value=>{status=value;},end:value=>{payload=JSON.parse(value);}};
    await handleApiRoute(req,res,manager,'/tmp');return {status,payload};
  }
  const base={chatId:-1001,messageId:22,row:0,column:1};
  assert.equal((await request({...base,query:'x'})).status,400);
  assert.equal((await request({...base,query:'new'})).status,200);
  assert.deepEqual(calls,[{action:'search_bot_requested_peers',payload:{...base,query:'new'}}]);
});

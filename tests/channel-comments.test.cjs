'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { sendMessage } = require('telegram/client/messages');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function fixture() {
  const channel = new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(1) });
  const group = new Api.Channel({ id: bigInt(456), accessHash: bigInt(2), title:'discussion', date:0, photo:new Api.ChatPhotoEmpty(), megagroup:true });
  const root = new Api.Message({ id:42, peerId:new Api.PeerChannel({channelId:bigInt(456)}), date:1, message:'root' });
  const reply = new Api.Message({ id:45, peerId:new Api.PeerChannel({channelId:bigInt(456)}), date:2, message:'reply' });
  const requests=[];
  const client = {
    getInputEntity: async () => channel,
    invoke: async request => { requests.push(request); return request.className === 'messages.GetDiscussionMessage' ? {messages:[root], chats:[group]} : {}; },
    getMessages: async (peer, params) => { requests.push({peer, params}); return [reply]; },
    buildReplyMarkup: () => undefined,
    _getResponseMessage: () => ({id:77}),
  };
  client.sendMessage = (peer, params) => sendMessage(client, peer, params);
  const driver = Object.create(TelegramDriver.prototype); driver.client=client;
  driver.mapMessage = async m => ({id:m.id,text:m.message});
  return {driver,requests};
}

test('channel comments use the linked discussion peer and root message', async () => {
  const {driver,requests}=fixture();
  assert.deepEqual(await driver.getChannelComments(-100123, 9, 50, 43), [{id:45,text:'reply'}]);
  assert.equal(requests[0].className, 'messages.GetDiscussionMessage');
  assert.equal(requests[0].msgId, 9);
  assert.equal(requests[1].peer.channelId.toString(), '456');
  assert.equal(requests[1].params.replyTo, 42);
  assert.equal(requests[1].params.offsetId, 43);
});

test('sending a comment invokes actual GramJS routing to the linked discussion', async () => {
  const {driver,requests}=fixture();
  assert.equal(await driver.sendChannelComment(-100123,9,'你好'),77);
  assert.equal(requests[0].className, 'messages.GetDiscussionMessage');
  assert.equal(requests[1].className, 'messages.SendMessage');
  assert.equal(requests[1].peer.channelId.toString(), '456');
  assert.equal(requests[1].replyTo.replyToMsgId,42);
  assert.equal(requests[1].message,'你好');
});

test('media comments route through the linked discussion with the original post id', async () => {
  const {sendFile}=require('telegram/client/uploads');
  const {driver,requests}=fixture();
  driver.client.sendFile=(peer,params)=>sendFile(driver.client,peer,params);
  await driver.sendMedia(-100123,'https://example.com/image.jpg','photo',{
    commentTo:9,caption:'caption',parseMode:'plain',silent:true,
  });
  assert.equal(requests[0].className,'messages.GetDiscussionMessage');
  assert.equal(requests[0].msgId,9);
  assert.equal(requests[1].className,'messages.SendMedia');
  assert.equal(requests[1].peer.channelId.toString(),'456');
  assert.equal(requests[1].replyTo.replyToMsgId,42);
  assert.equal(requests[1].message,'caption');
  assert.equal(requests[1].silent,true);
});

test('unavailable discussion and write restrictions are reported', async () => {
  const {driver}=fixture();
  driver.client.invoke=async () => { throw new Error('CHANNEL_PRIVATE'); };
  await assert.rejects(driver.getChannelComments(-100123,9),/无法访问关联的讨论群/);
  driver.client.sendMessage=async () => { throw new Error('CHAT_WRITE_FORBIDDEN'); };
  await assert.rejects(driver.sendChannelComment(-100123,9,'test'),/没有在讨论群发送消息的权限/);
});

test('comment API dispatches only the requested account and validates input', async () => {
  const calls=[];
  const manager={getInstance: id => id==='a' ? {accountAction: async (action,params)=>{calls.push({id,action,params});return action==='get_channel_comments'?[]:{messageId:77};}} : undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(e=>{res.statusCode=500;res.end(e.message);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/channel-comments`;
    assert.equal((await fetch(url+'?chatId=-100123&messageId=9&offsetId=43')).status,200);
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,messageId:9,text:'hi'})})).status,200);
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,messageId:9,text:' '})})).status,400);
    assert.deepEqual(calls.map(c=>c.action),['get_channel_comments','send_channel_comment']);
    assert.equal(calls[0].params.offsetId,43);
    assert.equal(calls[1].params.text,'hi');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

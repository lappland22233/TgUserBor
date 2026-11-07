'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function driverFor(peer, invoke) {
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { getInputEntity: async () => peer, invoke };
  return driver;
}
const peerUser = () => new Api.InputPeerUser({ userId: bigInt(8), accessHash: bigInt(9) });
const peerChat = () => new Api.InputPeerChat({ chatId: bigInt(7) });
const peerChannel = () => new Api.InputPeerChannel({ channelId: bigInt(6), accessHash: bigInt(9) });

test('dialog pin and archive use Telegram dialog operations', async () => {
  const calls=[]; const driver=driverFor(peerUser(),async req=>{calls.push(req); return {};});
  await driver.setDialogPinned(8,true); await driver.setDialogPinned(8,false);
  await driver.setDialogArchived(8,true); await driver.setDialogArchived(8,false);
  assert.deepEqual(calls.map(x=>x.className),['messages.ToggleDialogPin','messages.ToggleDialogPin','folders.EditPeerFolders','folders.EditPeerFolders']);
  assert.equal(calls[0].pinned,true); assert.equal(calls[1].pinned,false);
  assert.equal(calls[2].folderPeers[0].folderId,1); assert.equal(calls[3].folderPeers[0].folderId,0);
  assert.equal(calls[0].peer.peer.userId.toString(),'8');
});
test('pin failure returned by Telegram is propagated', async () => {
  const driver=driverFor(peerUser(),async()=>false);
  await assert.rejects(driver.setDialogPinned(8,true),/Telegram 未能更新/);
});
test('private dialog deletion removes local history over every page without revoking peer history', async () => {
  const calls=[]; const driver=driverFor(peerUser(),async req=>{calls.push(req); return {offset:calls.length===1?1:0};});
  await driver.deleteDialog(8);
  assert.equal(calls.length,2);
  assert.ok(calls.every(x=>x.className==='messages.DeleteHistory' && x.revoke===false && x.justClear===false));
});
test('group and channel removal use their correct leave requests', async () => {
  let calls=[]; let driver=driverFor(peerChat(),async req=>{calls.push(req);return {offset:0};});
  await driver.deleteDialog(-7);
  assert.deepEqual(calls.map(x=>x.className),['messages.DeleteChatUser','messages.DeleteHistory']);
  assert.equal(calls[0].chatId.toString(),'7'); assert.equal(calls[0].userId.className,'InputUserSelf');
  calls=[]; driver=driverFor(peerChannel(),async req=>{calls.push(req);return {};});
  await driver.deleteDialog(-1006);
  assert.deepEqual(calls.map(x=>x.className),['channels.LeaveChannel']);
});
test('leaving a basic group and a channel uses their respective methods', async () => {
  const calls=[]; let driver=driverFor(peerChat(),async req=>{calls.push(req);return {};});
  await driver.leaveChat(-7);
  driver=driverFor(peerChannel(),async req=>{calls.push(req);return {};});
  await driver.leaveChat(-1006);
  assert.deepEqual(calls.map(x=>x.className),['messages.DeleteChatUser','channels.LeaveChannel']);
  await assert.rejects(driverFor(peerUser(),async()=>{}).leaveChat(8),/只能退出群组或频道/);
});
test('a group history cleanup failure reports the partial exit', async () => {
  const driver=driverFor(peerChat(),async req=>{if(req.className==='messages.DeleteHistory') throw new Error('offline'); return {};});
  await assert.rejects(driver.deleteDialog(-7),/已退出群组.*offline/);
});
test('dialog actions target the requested account and validate arguments', async () => {
  const calls=[]; const manager={getInstance:id=>id==='a'?{accountAction:async (action,params)=>{calls.push({id,action,params});}}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(e=>{res.statusCode=500;res.end(e.message);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}/api/instances/a/account/`;
    const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post('dialog-pin',{chatId:8,pinned:true})).status,200);
    assert.equal((await post('dialog-archive',{chatId:8,archived:false})).status,200);
    assert.equal((await post('dialog-delete',{chatId:8})).status,200);
    assert.equal((await post('dialog-pin',{chatId:8})).status,400);
    assert.equal((await post('dialog-archive',{chatId:8,archived:'false'})).status,400);
    assert.equal((await post('dialog-delete',{chatId:'not-an-id'})).status,400);
    assert.deepEqual(calls.map(x=>x.action),['set_dialog_pinned','set_dialog_archived','delete_dialog']);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('basic group title and details use messages APIs rather than channel APIs', async () => {
  const calls=[]; const driver=driverFor(peerChat(),async req=>{calls.push(req); return {fullChat:{about:'group bio',participants:{participants:[{},{}]},pinnedMsgId:7}};});
  driver.client.getEntity=async()=>({className:'Chat',id:bigInt(7),title:'Group'});
  driver.logger={debug(){}};
  const profile=await driver.getPeerProfile(-7);
  assert.equal(profile.type,'group'); assert.equal(profile.bio,'group bio'); assert.equal(profile.memberCount,2);
  await driver.setChatTitle(-7,'new');
  assert.deepEqual(calls.map(x=>x.className),['messages.GetFullChat','messages.EditChatTitle']);
  assert.equal(calls[1].chatId.toString(),'7');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { mapBotKeyboard, getBotCallbackData } = require('../dist/bot/driver/bot-keyboard');
const { handleApiRoute } = require('../dist/gui/api');
const { Readable } = require('node:stream');
function markup() {
  return new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [
    new Api.KeyboardButtonUrl({ text: '链接', url: 'https://example.org/a' }),
    new Api.KeyboardButtonCallback({ text: '确认', data: Buffer.from('secret') }),
    new Api.KeyboardButtonGame({ text: '游戏' }),
    new Api.KeyboardButtonCallback({ text: '验证', data: Buffer.from('x'), requiresPassword: true }),
    new Api.KeyboardButtonWebView({ text: 'Mini App', url: 'https://example.org/app' }),
    new Api.KeyboardButtonSimpleWebView({ text: 'Quick App', url: 'https://example.org/quick' }),
    new Api.KeyboardButtonCopy({ text: '复制', copyText: 'TG-1234' }),
    new Api.KeyboardButtonUserProfile({ text: '资料', userId: 54321 }),
    new Api.KeyboardButtonUrlAuth({ text: '登录', url: 'https://example.org/auth', buttonId: 7 }),
    new Api.KeyboardButtonRequestPeer({ text: '选用户', buttonId: 9, maxQuantity: 2, peerType: new Api.RequestPeerTypeUser({ bot: false }) }),
  ] })] });
}
test('inline keyboard maps buttons without exposing callback or Mini App URL data', () => {
  const rows = mapBotKeyboard(markup());
  assert.deepEqual(rows[0].map(x => x.type), ['url','callback','game','unsupported','web_app','simple_web_app','copy','user_profile','url_auth','request_peer']);
  assert.equal(rows[0][4].url, undefined);
  assert.equal(rows[0][5].url, undefined);
  assert.equal(rows[0][6].copyText, 'TG-1234');
  assert.equal(rows[0][7].userId, 54321);
  assert.equal(rows[0][8].url, undefined);
  assert.deepEqual(rows[0][9].peerRequest, {kind:'user',maxQuantity:2,bot:false});
  assert.equal(rows[0][0].url, 'https://example.org/a');
  assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.deepEqual(getBotCallbackData(markup(), 0, 1), Buffer.from('secret'));
  assert.throws(() => getBotCallbackData(markup(), 0, 3), /额外验证/);
  assert.equal(mapBotKeyboard(new Api.ReplyKeyboardHide({})), undefined);
});
test('callback re-fetches the message and passes only its original opaque bytes to Telegram', async () => {
  const driver = Object.create(TelegramDriver.prototype); const invoked = [];
  driver.client = { getMessages: async (peer, params) => [{ id: params.ids[0], replyMarkup: markup() }], invoke: async request => { invoked.push(request); return { message:'done', alert: true }; } };
  const answer = await driver.pressBotCallback(11, 22, 0, 1);
  assert.equal(invoked[0].msgId, 22); assert.deepEqual(invoked[0].data, Buffer.from('secret'));
  assert.equal(answer.message, 'done'); assert.equal(answer.alert, true);
  await assert.rejects(driver.pressBotCallback(11, 22, 0, 0), /不可用/);
  assert.equal(invoked.length, 1);
});
test('game launch re-fetches the original bot game button before requesting its URL', async () => {
  const bot = new Api.User({ id: 21n, bot: true, accessHash: 1n });
  const gameButton = new Api.KeyboardButtonGame({ text: 'Play' });
  const message = { id: 22, replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [gameButton] })] }), getSender: async () => bot };
  const calls = [], driver = Object.create(TelegramDriver.prototype);
  driver.client = { getMessages: async (peer, params) => params.ids[0] === 22 ? [message] : [], invoke: async request => { calls.push(request); return { url: 'https://games.example/play' }; } };
  assert.deepEqual(await driver.launchBotGame(-1001, 22, 0, 0), { message: undefined, alert: undefined, url: 'https://games.example/play' });
  assert.ok(calls[0] instanceof Api.messages.GetBotCallbackAnswer);
  assert.equal(calls[0].game, true); assert.equal(calls[0].data, undefined);
  message.replyMarkup.rows[0].buttons[0] = new Api.KeyboardButton({ text: 'Plain' });
  await assert.rejects(driver.launchBotGame(-1001, 22, 0, 0), /游戏按钮不可用/);
  assert.equal(calls.length, 1);
});
test('URL authorization re-reads the original bot button for both request and acceptance',async()=>{
  const bot=new Api.User({id:21n,bot:true,accessHash:1n});
  const button=new Api.KeyboardButtonUrlAuth({text:'Log in',url:'https://login.example/auth',buttonId:7});
  const markup=new Api.ReplyInlineMarkup({rows:[new Api.KeyboardButtonRow({buttons:[button]})]});
  const message={id:22,replyMarkup:markup,getSender:async()=>bot};
  const calls=[];const driver=Object.create(TelegramDriver.prototype);
  driver.client={getMessages:async(peer,params)=>params.ids[0]===22?[message]:[],invoke:async request=>{
    calls.push(request);
    return request instanceof Api.messages.RequestUrlAuth
      ? new Api.UrlAuthResultRequest({bot,domain:'login.example',requestWriteAccess:true})
      : new Api.UrlAuthResultAccepted({url:'https://login.example/complete'});
  }};
  const requested=await driver.requestBotUrlAuth(-1001,22,0,0);
  assert.deepEqual(requested,{type:'request',domain:'login.example',requestWriteAccess:true});
  assert.equal(calls[0].buttonId,7);
  const accepted=await driver.acceptBotUrlAuth(-1001,22,0,0,true);
  assert.deepEqual(accepted,{type:'accepted',url:'https://login.example/complete'});
  assert.equal(calls[1].buttonId,7);assert.equal(calls[1].writeAllowed,true);
  markup.rows[0].buttons[0]=new Api.KeyboardButton({text:'plain'});
  await assert.rejects(driver.requestBotUrlAuth(-1001,22,0,0),/登录授权按钮不可用/);
  assert.equal(calls.length,2);
});
test('requested peers are sent only through the verified request button and within its quantity limit',async()=>{
  const bot=new Api.User({id:21n,bot:true,accessHash:1n});
  const button=new Api.KeyboardButtonRequestPeer({text:'Share',buttonId:11,maxQuantity:2,peerType:new Api.RequestPeerTypeUser({bot:false})});
  const message={id:22,replyMarkup:new Api.ReplyInlineMarkup({rows:[new Api.KeyboardButtonRow({buttons:[button]})]}),getSender:async()=>bot};
  const calls=[],driver=Object.create(TelegramDriver.prototype),targets=[];
  driver.client={getMessages:async()=>[message],getInputEntity:async peer=>{
    if(peer===101n||peer===102n){targets.push(peer);return new Api.InputPeerUser({userId:peer,accessHash:1n});}
    return peer;
  },invoke:async request=>{calls.push(request);return {};}};
  await driver.sendBotRequestedPeers(-1001,22,0,0,[101,102]);
  assert.equal(calls[0].buttonId,11);assert.equal(calls[0].requestedPeers.length,2);assert.deepEqual(targets,[101n,102n]);
  await assert.rejects(driver.sendBotRequestedPeers(-1001,22,0,0,[101,102,103]),/数量无效/);
  assert.equal(calls.length,1);
});
test('request peer search is bound to a verified request button and returns only safe peer metadata',async()=>{
  const bot=new Api.User({id:21n,bot:true,accessHash:1n});
  const button=new Api.KeyboardButtonRequestPeer({text:'Share',buttonId:11,maxQuantity:2,peerType:new Api.RequestPeerTypeUser({bot:false})});
  const message={id:22,replyMarkup:new Api.ReplyInlineMarkup({rows:[new Api.KeyboardButtonRow({buttons:[button]})]}),getSender:async()=>bot};
  const user=new Api.User({id:101n,firstName:'New',username:'newperson',bot:false,premium:false,accessHash:2n});
  const calls=[],driver=Object.create(TelegramDriver.prototype);
  driver.client={getMessages:async()=>[message],invoke:async request=>{calls.push(request);return new Api.contacts.Found({myResults:[],results:[new Api.PeerUser({userId:101n})],users:[user],chats:[]});}};
  const results=await driver.searchBotRequestedPeers(-1001,22,0,0,'new person');
  assert.ok(calls[0] instanceof Api.contacts.Search);assert.equal(calls[0].q,'new person');
  assert.deepEqual(results,[{id:101,type:'private',title:'New',username:'newperson',unreadCount:0,isBot:false,isPremium:false}]);
  assert.deepEqual(await driver.searchBotRequestedPeers(-1001,22,0,0,'x'),[]);
  assert.equal(calls.length,1);
});
test('callback API dispatches only the requested account and validates indexes', async () => {
  const calls = [];
  const inst = { accountAction: async (action, params) => { calls.push({ action, params }); return {message:'ok'}; } };
  const manager = { getInstance: id => id === 'a' ? inst : undefined };
  async function request(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.url = '/api/instances/a/account/bot-callback'; req.method = 'POST'; req.headers = { host:'localhost' };
    let status; let payload;
    const res = { writeHead: s => { status = s; }, end: text => { payload = JSON.parse(text); } };
    await handleApiRoute(req, res, manager, '/tmp'); return {status,payload};
  }
  assert.equal((await request({chatId:1,messageId:2,row:0,column:1})).status,200);
  assert.equal(calls[0].action,'press_bot_callback');
  assert.equal((await request({chatId:1,messageId:2,row:-1,column:1})).status,400);
  assert.equal(calls.length,1);
});
test('game API dispatches only a validated original button position to the selected account', async () => {
  const calls = [];
  const inst = { accountAction: async (action, params) => { calls.push({ action, params }); return { url: 'https://games.example/play' }; } };
  const manager = { getInstance: id => id === 'a' ? inst : undefined };
  async function request(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.url = '/api/instances/a/account/bot-game'; req.method = 'POST'; req.headers = { host: 'localhost' };
    let status, payload;
    const res = { writeHead: code => { status = code; }, end: text => { payload = JSON.parse(text); } };
    await handleApiRoute(req, res, manager, '/tmp'); return { status, payload };
  }
  assert.equal((await request({ chatId: -1001, messageId: 22, row: 0, column: 1 })).status, 200);
  assert.deepEqual(calls[0], { action: 'launch_bot_game', params: { chatId: -1001, messageId: 22, row: 0, column: 1 } });
  assert.equal((await request({ chatId: -1001, messageId: 22, row: 0, column: 16 })).status, 400);
  assert.equal(calls.length, 1);
});

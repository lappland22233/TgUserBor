'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('telegram');
const { mapBotReplyKeyboard } = require('../dist/bot/driver/bot-keyboard');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

test('Telegram reply keyboard maps text, phone, location, poll and profile requests to safe action types', () => {
  const markup = new Api.ReplyKeyboardMarkup({singleUse:true,rows:[new Api.KeyboardButtonRow({buttons:[
    new Api.KeyboardButton({text:'Go'}),new Api.KeyboardButtonRequestPhone({text:'Phone'}),
    new Api.KeyboardButtonRequestGeoLocation({text:'Location'}),new Api.KeyboardButtonRequestPoll({text:'Poll',quiz:true}),
    new Api.KeyboardButtonUserProfile({text:'Profile',userId:12345}),new Api.KeyboardButtonSimpleWebView({text:'Mini App',url:'https://bot.example/quick'}),
    new Api.KeyboardButtonRequestPeer({text:'Group',buttonId:77,maxQuantity:3,peerType:new Api.RequestPeerTypeChat({forum:true,botParticipant:true})}),
  ]})]});
  const keyboard = mapBotReplyKeyboard(markup);
  assert.equal(keyboard.type,'keyboard'); assert.equal(keyboard.singleUse,true);
  assert.deepEqual(keyboard.rows[0].map(x=>x.type),['text','request_phone','request_location','request_poll','user_profile','simple_web_app','request_peer']);
  assert.deepEqual(keyboard.rows[0].map(x=>[x.row,x.column]),[[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6]]);
  assert.equal(keyboard.rows[0][3].quiz,true);
  assert.equal(keyboard.rows[0][4].userId,12345);
  assert.deepEqual(keyboard.rows[0][6].peerRequest,{kind:'group',maxQuantity:3,botParticipant:true,forum:true,botAdminRights:[]});
  assert.deepEqual(mapBotReplyKeyboard(new Api.ReplyKeyboardHide({selective:true})),{type:'hide',selective:true});
  assert.deepEqual(mapBotReplyKeyboard(new Api.ReplyKeyboardForceReply({singleUse:true,selective:true,placeholder:'Answer here'})),
    {type:'force',singleUse:true,selective:true,placeholder:'Answer here'});
  assert.equal(mapBotReplyKeyboard(new Api.ReplyInlineMarkup({rows:[]})),undefined);
});

test('selective reply keyboards are mapped only when Telegram marks the message as addressed to this account', async () => {
  const sender = new Api.User({ id: 42n, firstName: 'Bot', bot: true });
  const peer = new Api.PeerUser({ userId: 42n });
  const markup = new Api.ReplyKeyboardMarkup({ selective: true, rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: 'For you' })] })] });
  async function mapMentioned(mentioned) {
    const message = new Api.Message({ id: mentioned ? 6 : 5, peerId: peer, date: 1, message: '', mentioned, replyMarkup: markup });
    message.getChat = async () => sender;
    message.getSender = async () => sender;
    return Object.create(TelegramDriver.prototype).mapMessage(message);
  }
  assert.equal((await mapMentioned(false)).replyKeyboard, undefined);
  assert.deepEqual((await mapMentioned(true)).replyKeyboard, { type: 'keyboard', rows: [[{ text: 'For you', row: 0, column: 0, type: 'text' }]], singleUse: false, selective: true });
});

test('reply keyboard history restoration finds old markup and respects hide, selective and single-use state', async () => {
  const bot = new Api.User({ id: 42n, firstName: 'Bot', bot: true });
  const peer = new Api.PeerUser({ userId: 42n });
  const keyboard = new Api.ReplyKeyboardMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: 'Continue' })] })] });
  const makeMessage = (id, options = {}) => {
    const message = new Api.Message({ id, peerId: peer, date: id, message: options.text ?? '', out: options.out,
      mentioned: options.mentioned, replyMarkup: options.markup });
    message.replyTo = options.replyToId ? { replyToMsgId: options.replyToId } : undefined;
    message.getChat = async () => bot; message.getSender = async () => bot;
    return message;
  };
  async function restore(extra = []) {
    const byId = new Map(Array.from({ length: 120 }, (_, i) => makeMessage(120 - i)).map(message => [message.id, message]));
    for (const message of extra) byId.set(message.id, message);
    const history = [...byId.values()].sort((a, b) => b.id - a.id);
    const driver = Object.create(TelegramDriver.prototype); driver.resolvePeer = id => id;
    const offsets = [];
    driver.client = { getMessages: async (_peer, options) => {
      offsets.push(options.offsetId);
      return history.filter(message => options.offsetId == null || message.id < options.offsetId).slice(0, options.limit);
    } };
    return { snapshot: await driver.getReplyKeyboardState(-1001), offsets };
  }
  const active = await restore([makeMessage(20, { markup: keyboard })]);
  assert.equal(active.snapshot.message.id, 20); assert.equal(active.snapshot.latestMessageId, 120);
  assert.equal(active.snapshot.message.replyKeyboard.rows[0][0].text, 'Continue');
  assert.deepEqual(active.offsets, [undefined, 21]);
  const selective = await restore([makeMessage(80, { markup: new Api.ReplyKeyboardMarkup({ selective: true, rows: keyboard.rows }) }),
    makeMessage(20, { markup: keyboard })]);
  assert.equal(selective.snapshot.message.id, 20, 'a keyboard addressed to another participant does not replace this account keyboard');
  const spent = await restore([makeMessage(80, { out: true, text: 'Already answered' }), makeMessage(20, { markup: new Api.ReplyKeyboardMarkup({ singleUse: true, rows: keyboard.rows }) })]);
  assert.deepEqual(spent.snapshot.message.replyKeyboard, { type: 'hide' });
  const hidden = await restore([makeMessage(80, { markup: new Api.ReplyKeyboardHide({}) }), makeMessage(20, { markup: keyboard })]);
  assert.equal(hidden.snapshot.message.replyKeyboard.type, 'hide');
});

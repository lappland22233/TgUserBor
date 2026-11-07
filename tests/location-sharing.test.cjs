'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram live locations send into chats or forum topics and can update or stop only owned shares', async () => {
  const calls = [];
  const live = new Api.MessageMediaGeoLive({ geo: new Api.GeoPoint({ lat: 37.5, long: -122.2 }), period: 3600 });
  const message = new Api.Message({ id: 90, peerId: new Api.PeerUser({ userId: bigInt(7) }), date: 100,
    message: '', out: true, media: live });
  const client = {
    getMessages: async (_peer, options) => { calls.push({ kind: 'read', options }); return [message]; },
    invoke: async request => { calls.push({ kind: 'invoke', request }); return request.className === 'messages.SendMedia'
      ? { updates: [{ className: 'UpdateMessageID', id: 91 }] } : { updates: [] }; },
  };
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = client; driver.resolvePeer = chatId => String(chatId);
  const messageId = await driver.sendLiveLocation(7, 37.5, -122.2, 3600);
  assert.equal(messageId, 91);
  const send = calls.find(call => call.request?.className === 'messages.SendMedia').request;
  assert.ok(send.media instanceof Api.InputMediaGeoLive);
  assert.equal(send.media.period, 3600);
  assert.equal(send.media.geoPoint.lat, 37.5);
  assert.equal(send.replyTo, undefined);
  await driver.sendLiveLocation(-100123, 37.5, -122.2, 900, 55);
  const forumSend = calls.filter(call => call.request?.className === 'messages.SendMedia').at(-1).request;
  assert.equal(forumSend.replyTo.replyToMsgId, 55);
  assert.equal(forumSend.replyTo.topMsgId, 55);
  await driver.editLiveLocation(7, 90, { latitude: 37.6, longitude: -122.3, period: 1800 });
  const update = calls.filter(call => call.request?.className === 'messages.EditMessage').at(-1).request;
  assert.equal(update.media.geoPoint.lat, 37.6);
  assert.equal(update.media.period, 1800);
  await driver.editLiveLocation(7, 90, { stopped: true });
  const stop = calls.filter(call => call.request?.className === 'messages.EditMessage').at(-1).request;
  assert.equal(stop.media.stopped, true);
  assert.equal(stop.media.geoPoint.long, -122.2);
  assert.equal(calls.filter(call => call.kind === 'read').length, 2);
  message.out = false;
  await assert.rejects(driver.editLiveLocation(7, 90, { stopped: true }), /not an outgoing/);
  await assert.rejects(driver.sendLiveLocation(7, 91, 0, 1200), /Invalid live location/);
});

test('live location HTTP routes validate duration, coordinates and message ownership target shape', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'send_live_location' ? { messageId: 90 } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/location/live`;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(base, { chatId: 7, latitude: 91, longitude: 0, period: 3600 })).status, 400);
    assert.equal((await post(base, { chatId: 7, latitude: 37.5, longitude: -122.2, period: 1200 })).status, 400);
    assert.deepEqual(await (await post(base, { chatId: -100123, latitude: 37.5, longitude: -122.2, period: 900, topMsgId: 55 })).json(),
      { success: true, result: { messageId: 90 } });
    assert.equal((await post(`${base}/update`, { chatId: 7, messageId: 90, latitude: 0, longitude: 0, period: 0 })).status, 400);
    assert.equal((await post(`${base}/update`, { chatId: 7, messageId: 90, latitude: 37.6, longitude: -122.3, period: 1800 })).status, 200);
    assert.equal((await post(`${base}/stop`, { chatId: 7, messageId: 90 })).status, 200);
    assert.deepEqual(calls, [
      { action: 'send_live_location', payload: { chatId: -100123, latitude: 37.5, longitude: -122.2, period: 900, topMsgId: 55 } },
      { action: 'update_live_location', payload: { chatId: 7, messageId: 90, latitude: 37.6, longitude: -122.3, period: 1800 } },
      { action: 'stop_live_location', payload: { chatId: 7, messageId: 90 } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('browser live location watch throttles updates and clears local tracking when stopped', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('const liveLocationWatchers = new Map();');
  const end = source.indexOf('\n// Channel post comments', start);
  assert.ok(start >= 0 && end > start);
  const requests = [], toasts = [], watches = [], cleared = [], timers = [];
  let clock = 100000;
  const position = (latitude, longitude) => ({ coords: { latitude, longitude } });
  const navigator = { geolocation: {
    getCurrentPosition: success => success(position(37.5, -122.2)),
    watchPosition: (success, error, options) => { watches.push({ success, error, options }); return 8; },
    clearWatch: id => cleared.push(id),
  } };
  class FakeDate extends Date { static now() { return clock; } }
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 7, chatSelectionVersion: 3 };
  const context = vm.createContext({ state, navigator, Date: FakeDate, Map, Number, String, Math, encodeURIComponent,
    window: { prompt: () => '15', isSecureContext: true },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => cleared.push(`timer:${id}`),
    showToast: message => toasts.push(message), loadClientMessages: async () => {},
    api: async (url, method, body) => { requests.push({ url, method, body }); return url.endsWith('/live') ? { result: { messageId: 50 } } : { success: true }; },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.start = startClientLiveLocation; this.stop = stopClientLiveLocation; this.watchers = liveLocationWatchers;`, context);
  context.start({ instId: 'a', chatId: 7, selectionVersion: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.watchers.size, 1);
  assert.equal(watches[0].options.enableHighAccuracy, true);
  assert.equal(requests[0].body.period, 900);
  clock += 11000;
  watches[0].success(position(37.501, -122.2));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(requests[1].url, /live\/update$/);
  assert.equal(requests[1].body.messageId, 50);
  await context.stop('a', 7, 50);
  assert.equal(context.watchers.size, 0);
  assert.deepEqual(cleared, [8, 'timer:1']);
  assert.match(requests[2].url, /live\/stop$/);
});

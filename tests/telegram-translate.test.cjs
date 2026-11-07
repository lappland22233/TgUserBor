'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('message translations preserve safe Telegram formatting entities and use the selected peer and message ID', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    const { Api } = require('telegram');
    return { result: [new Api.TextWithEntities({ text: '你好', entities: [new Api.MessageEntityBold({ offset: 0, length: 2 })] })] };
  } };

  assert.deepEqual(await driver.translateMessage(-1001234567890, 55, 'ZH-Hans'), {
    translatedText: '你好', targetLang: 'zh-hans', entities: [{ type: 'MessageEntityBold', offset: 0, length: 2 }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].className, 'messages.TranslateText');
  assert.equal(String(calls[0].peer), '-1001234567890');
  assert.deepEqual(calls[0].id, [55]);
  assert.equal(calls[0].toLang, 'zh-hans');
  await assert.rejects(driver.translateMessage(0, 55), /Invalid message translation/);
  await assert.rejects(driver.translateMessage(12, 0), /Invalid message translation/);
  await assert.rejects(driver.translateMessage(12, 55, 'bad language!'), /Invalid message translation/);
});

test('translation HTTP route validates the message target and calls the account worker', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params });
    return { translatedText: 'translated', targetLang: params.targetLang };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/translate`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ text: 'do not accept arbitrary text' })).status, 400);
    const response = await post({ chatId: -1001234567890, messageId: 55 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { translatedText: 'translated', targetLang: 'zh-hans' });
    assert.deepEqual(calls, [{ action: 'translate_message', params: {
      chatId: -1001234567890, messageId: 55, targetLang: 'zh-hans',
    } }]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

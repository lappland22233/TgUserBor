'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');
const bigInt = require('big-integer');

test('stopping a poll edits the existing Telegram poll while preserving its options and quiz explanation', async () => {
  const calls = [];
  const originalPoll = new Api.Poll({
    id: BigInt(987), publicVoters: false, multipleChoice: true, quiz: true,
    question: new Api.TextWithEntities({ text: 'Which?', entities: [] }),
    answers: [new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'A', entities: [] }), option: Buffer.from([0, 1]) })],
  });
  const solution = 'Because';
  const solutionEntities = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = {
    getMessages: async () => [{ id: 55, media: { poll: originalPoll, solution, solutionEntities } }],
    invoke: async request => calls.push(request),
  };
  await driver.closePoll(-100123, 55);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].className, 'messages.EditMessage');
  assert.equal(calls[0].id, 55);
  assert.equal(calls[0].media.className, 'InputMediaPoll');
  assert.equal(calls[0].media.poll.closed, true);
  assert.equal(calls[0].media.poll.quiz, true);
  assert.deepEqual(calls[0].media.poll.answers[0].option, Buffer.from([0, 1]));
  assert.equal(calls[0].media.solution, solution);
  assert.deepEqual(calls[0].media.solutionEntities, solutionEntities);
  await assert.rejects(driver.closePoll(0, 55), /Invalid poll close request/);
  assert.equal(calls.length, 1);
});

test('editing an unanswered quiz preserves Telegram poll flags and stable option IDs', async () => {
  const calls = [];
  const originalAnswers = [
    new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'A', entities: [] }), option: Buffer.from([0, 1]) }),
    new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'B', entities: [] }), option: Buffer.from([0, 2]) }),
  ];
  const originalPoll = new Api.Poll({
    id: BigInt(987), publicVoters: false, multipleChoice: false, quiz: true,
    question: new Api.TextWithEntities({ text: 'Which?', entities: [] }),
    answers: originalAnswers, closePeriod: 3600,
  });
  const results = { totalVoters: 0, results: originalAnswers.map((answer, index) => ({
    option: answer.option, voters: 0, correct: index === 1,
  })), solution: 'Old explanation', solutionEntities: [] };
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = {
    getMessages: async () => [{ id: 55, out: true, media: { poll: originalPoll, results } }],
    invoke: async request => calls.push(request),
  };
  await driver.editPoll(-100123, 55, 'Which animal?', ['A', 'C'], { correctOptionIndex: 1, explanation: 'Old explanation' });
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.className, 'messages.EditMessage');
  assert.equal(request.id, 55);
  assert.equal(request.media.poll.id, BigInt(987));
  assert.equal(request.media.poll.question.text, 'Which animal?');
  assert.equal(request.media.poll.publicVoters, false);
  assert.equal(request.media.poll.multipleChoice, false);
  assert.equal(request.media.poll.quiz, true);
  assert.equal(request.media.poll.closePeriod, 3600);
  assert.deepEqual(request.media.poll.answers[0].option, originalAnswers[0].option);
  assert.notDeepEqual(request.media.poll.answers[1].option, originalAnswers[1].option);
  assert.deepEqual(request.media.correctAnswers, [request.media.poll.answers[1].option]);
  assert.equal(request.media.solution, 'Old explanation');
  assert.deepEqual(request.media.solutionEntities, []);
});

test('poll creation validates Telegram limits and uses the selected quiz answer ID', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = { invoke: async request => { calls.push(request); return {updates: [{id: 88}]}; } };
  await driver.sendPoll(-100123, 'Question?', ['A', 'B'], {
    isAnonymous: true, isMultipleChoice: false, isQuiz: true, correctOptionIndex: 1, explanation: 'Why',
  });
  const media = calls[0].media;
  assert.equal(media.poll.question.text, 'Question?');
  assert.deepEqual(media.correctAnswers, [media.poll.answers[1].option]);
  assert.equal(media.solution, 'Why');
  await assert.rejects(driver.sendPoll(-100123, 'Question?', ['A', 'A']), /Invalid Telegram poll/);
  await assert.rejects(driver.sendPoll(-100123, 'Question?', ['A', 'B'], {isQuiz:true}), /Invalid Telegram poll/);
  assert.equal(calls.length, 1);
});

test('scheduled polls carry the repeat period on Telegram SendMedia and reject invalid schedules', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = { invoke: async request => { calls.push(request); return { updates: [{ id: 89 }] }; } };
  assert.equal(await driver.sendPoll(-100123, 'Question?', ['A', 'B'], { isAnonymous: true }, {
    schedule: 1900000000, scheduleRepeatPeriod: 604800,
  }), 89);
  assert.equal(calls[0].className, 'messages.SendMedia');
  assert.equal(calls[0].scheduleDate, 1900000000);
  assert.equal(calls[0].scheduleRepeatPeriod, 604800);
  assert.equal(calls[0].media.className, 'InputMediaPoll');
  await assert.rejects(driver.sendPoll(-100123, 'Question?', ['A', 'B'], {}, { scheduleRepeatPeriod: 86400 }), /scheduled poll/);
  assert.equal(calls.length, 1);
});

test('editing a poll is rejected when it is closed, forwarded, authored by another user, or already has votes', async () => {
  const poll = new Api.Poll({ id: BigInt(1), quiz: false,
    question: new Api.TextWithEntities({ text: 'Q?', entities: [] }),
    answers: [new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'A', entities: [] }), option: Buffer.from([1]) })],
  });
  let message = { id: 5, out: true, media: { poll, results: { totalVoters: 0, results: [] } } };
  let invoked = 0;
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = { getMessages: async () => [message], invoke: async () => { invoked++; } };
  const edit = () => driver.editPoll(1, 5, 'Q?', ['A', 'B']);
  message = {...message, out: false};
  await assert.rejects(edit, /only be edited by its author/);
  message = {...message, out: true, fwdFrom: {fromName: 'other'}};
  await assert.rejects(edit, /only be edited by its author/);
  message = {...message, fwdFrom: undefined, media: {poll: new Api.Poll({...poll, closed: true}), results: {totalVoters: 0, results: []}}};
  await assert.rejects(edit, /only be edited by its author/);
  message = {...message, media: {poll, results: {totalVoters: 1, results: []}}};
  await assert.rejects(edit, /only be edited by its author/);
  assert.equal(invoked, 0);
});

test('poll-stop permission recognizes basic-group admins and channel admins with edit-message rights', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.resolvePeer = chatId => BigInt(chatId);
  let participant;
  driver.client = {
    getInputEntity: async peer => peer === -123n
      ? new Api.InputPeerChat({ chatId: bigInt(123) })
      : new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(1) }),
    invoke: async request => {
      if (request instanceof Api.messages.GetFullChat) {
        return { fullChat: { participants: new Api.ChatParticipants({ chatId: bigInt(123), version: 1, participants: [participant] }) } };
      }
      return { participant };
    },
  };

  participant = new Api.ChatParticipantAdmin({ userId: bigInt(77), inviterId: bigInt(1), date: 1 });
  assert.equal(await driver.canCloseOtherPolls(-123), true);
  participant = new Api.ChatParticipant({ userId: bigInt(77), inviterId: bigInt(1), date: 1 });
  assert.equal(await driver.canCloseOtherPolls(-123), false);

  participant = new Api.ChannelParticipantAdmin({
    userId: bigInt(77), inviterId: bigInt(1), promotedBy: bigInt(1), date: 1,
    adminRights: new Api.ChatAdminRights({ editMessages: true }),
  });
  assert.equal(await driver.canCloseOtherPolls(-100456), true);
  participant = new Api.ChannelParticipantAdmin({
    userId: bigInt(77), inviterId: bigInt(1), promotedBy: bigInt(1), date: 1,
    adminRights: new Api.ChatAdminRights({ editMessages: false }),
  });
  assert.equal(await driver.canCloseOtherPolls(-100456), false);
});

test('message pages attach poll-stop capability only when the current account has permission', async () => {
  const poll = new Api.Poll({
    id: bigInt(987), publicVoters: false, multipleChoice: false, quiz: false,
    question: new Api.TextWithEntities({ text: 'Question?', entities: [] }), answers: [],
  });
  const message = new Api.Message({
    id: 55, peerId: new Api.PeerChannel({ channelId: bigInt(456) }), date: 1, message: '',
    media: new Api.MessageMediaPoll({ poll, results: new Api.PollResults({ totalVoters: 0, results: [] }) }),
  });
  message.getChat = async () => undefined;
  message.getSender = async () => new Api.User({ id: bigInt(78), firstName: 'Member' });
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.selfId = 77;
  driver.client = {
    getMessages: async () => [message],
    getInputEntity: async () => new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(1) }),
    invoke: async () => ({ participant: new Api.ChannelParticipantAdmin({
      userId: bigInt(77), inviterId: bigInt(1), promotedBy: bigInt(1), date: 1,
      adminRights: new Api.ChatAdminRights({ editMessages: true }),
    }) }),
  };
  const messages = await driver.getMessages(-100456);
  assert.equal(messages[0].media.type, 'poll');
  assert.equal(messages[0].media.canClose, true);
});

test('poll edit capability is mapped only for own unanswered open polls', async () => {
  const poll = new Api.Poll({ id: BigInt(987), publicVoters: false, multipleChoice: false, quiz: false,
    question: new Api.TextWithEntities({ text: 'Question?', entities: [] }), answers: [],
  });
  const user = new Api.User({ id: BigInt(78), firstName: 'Member' });
  const makeMessage = ({out = true, closed = false, totalVoters = 0, forwarded = false} = {}) => ({
    id: 55, peerId: new Api.PeerUser({userId: BigInt(78)}), out, fwdFrom: forwarded ? {} : undefined,
    date: 1, message: '', media: new Api.MessageMediaPoll({
      poll: new Api.Poll({...poll, closed}), results: new Api.PollResults({totalVoters, results: []}),
    }),
    getChat: async () => user, getSender: async () => user,
  });
  const driver = Object.create(TelegramDriver.prototype);
  assert.equal((await driver.mapMessage(makeMessage())).media.canEdit, true);
  assert.equal((await driver.mapMessage(makeMessage({out:false}))).media.canEdit, false);
  assert.equal((await driver.mapMessage(makeMessage({closed:true}))).media.canEdit, false);
  assert.equal((await driver.mapMessage(makeMessage({totalVoters:1}))).media.canEdit, false);
  assert.equal((await driver.mapMessage(makeMessage({forwarded:true}))).media.canEdit, false);
});

test('poll close endpoint validates IDs before dispatching the Telegram action', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({ action, payload }) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/poll/close`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 1, messageId: 0 }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, messageId: 55 }) })).status, 200);
    assert.deepEqual(calls, [{ action: 'close_poll', payload: { chatId: -100123, messageId: 55 } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('poll edit endpoint validates fields before dispatching an account action', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({ action, payload }) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/poll/edit`;
    const invalid = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({chatId: 1, messageId: 5, question: 'Q?', options: ['A', '  ']}) });
    assert.equal(invalid.status, 400);
    const valid = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({chatId: -100123, messageId: 55, question: ' Q? ', options: [' A ', 'B'], pollOptions: {correctOptionIndex: 1, explanation: 'why'}}) });
    assert.equal(valid.status, 200);
    assert.deepEqual(calls, [{action: 'edit_poll', payload: {
      chatId: -100123, messageId: 55, question: ' Q? ', options: ['A', 'B'],
      pollOptions: {correctOptionIndex: 1, explanation: 'why'},
    }}]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('poll creation endpoint enforces Telegram question, option and quiz limits', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({action, payload}) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/poll`;
    const send = body => fetch(url, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
    assert.equal((await send({chatId:1, question:'Q?', options:['A','A']})).status, 400);
    assert.equal((await send({chatId:1, question:'Q?', options:['A','B'], pollOptions:{isQuiz:true}})).status, 400);
    assert.equal((await send({chatId:1, question:'Q?', options:['A','B'], pollOptions:{isQuiz:true, isMultipleChoice:true, correctOptionIndex:0}})).status, 400);
    assert.equal((await send({chatId:-100123, question:'Q?', options:['A','B'], scheduleRepeatPeriod:86400})).status, 400);
    assert.equal((await send({chatId:-100123, question:'Q?', options:['A','B'], schedule:1900000000, scheduleRepeatPeriod:17})).status, 400);
    const valid = await send({chatId:-100123, question:' Q? ', options:[' A ', 'B'], pollOptions:{isQuiz:true, correctOptionIndex:1, explanation:'Why'}});
    assert.equal(valid.status, 200);
    const scheduled = await send({chatId:-100123, question:' Q? ', options:[' A ', 'B'], schedule:1900000000, scheduleRepeatPeriod:604800});
    assert.equal(scheduled.status, 200);
    assert.deepEqual(calls, [{action:'send_poll', payload:{chatId:-100123, question:'Q?', options:['A','B'],
      pollOptions:{isQuiz:true, correctOptionIndex:1, explanation:'Why'}}}, {action:'send_poll', payload:{
      chatId:-100123, question:'Q?', options:['A','B'], pollOptions:{}, schedule:1900000000, scheduleRepeatPeriod:604800,
    }}]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('dice endpoint accepts only Telegram dice emoticons and dispatches to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({ action, payload }) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/dice`;
    const send = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ chatId: 0, emoticon: '🎲' })).status, 400);
    assert.equal((await send({ chatId: -100123, emoticon: '🧨' })).status, 400);
    assert.equal((await send({ chatId: -100123, emoticon: '🎯', topicId: 0 })).status, 400);
    assert.equal((await send({ chatId: -100123, emoticon: '🎯', topicId: 21 })).status, 200);
    assert.deepEqual(calls, [{ action: 'send_dice', payload: { chatId: -100123, emoticon: '🎯', topMsgId: 21 } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

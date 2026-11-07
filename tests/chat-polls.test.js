'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
function part(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error('Cannot locate poll handlers');
  return source.slice(start, end);
}
test('poll vote passes the API contract and does not refresh a different account', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1 };
  const calls = [], rendered = [];
  let resolve;
  const context = vm.createContext({ state, encodeURIComponent, showToast() {},
    api: (url, method, body) => { calls.push({url, method, body}); return new Promise(r => { resolve = r; }); },
    loadClientMessages: (...args) => rendered.push(args),
  });
  vm.runInContext(part('async function sendPollVote(', '\nfunction initPollModal') + '\nthis.vote = sendPollVote;', context);
  const pending = context.vote(1, 42, [2]);
  assert.equal(calls[0].body.messageId, 42);
  assert.deepEqual(calls[0].body.optionIndexes, [2]);
  state.clientSelectedInstance = 'b'; resolve({success:true}); await pending;
  assert.equal(rendered.length, 0);
});
test('quiz creation passes settings under pollOptions without discarding empty choices', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1 };
  const calls = [], toasts = [];
  let choices = ['one', 'two'];
  const nodes = {
    'poll-question-input': { value: 'question' }, 'poll-anonymous-input': { checked: false },
    'poll-multiple-input': { checked: false }, 'poll-quiz-input': { checked: true },
    'poll-solution-input': { value: 'answer' }, 'modal-create-poll': { style: {} },
  };
  const document = { getElementById: id => nodes[id],
    querySelectorAll: selector => selector === '.poll-option-input-row' ? choices.map(value => ({querySelector: () => ({value})})) : [],
    querySelector: () => ({dataset: {idx: '1'}}),
  };
  const context = vm.createContext({ state, document, pollEditSession: null, encodeURIComponent, showToast: x => toasts.push(x),
    api: async (url, method, body) => { calls.push({url, method, body}); return {messageId: 3}; }, loadClientMessages: async () => {} });
  vm.runInContext(part('async function submitCreatePoll()', '\n// ==========================================\n// Wallpaper Themes Controller') + '\nthis.create = submitCreatePoll;', context);
  await context.create();
  assert.equal(calls[0].body.pollOptions.isQuiz, true);
  assert.equal(calls[0].body.pollOptions.correctOptionIndex, 1);
  assert.equal(calls[0].body.pollOptions.explanation, 'answer');
  choices = ['one', '', 'two']; await context.create();
  assert.equal(calls.length, 1);
  assert.match(toasts.at(-1), /填写所有选项/);
  choices = ['one', 'one']; await context.create();
  assert.equal(calls.length, 1);
  assert.match(toasts.at(-1), /不能重复/);
});

test('poll creation carries a selected schedule date and Telegram repeat period', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1 };
  const calls = [];
  const future = new Date(Date.now() + 7200000);
  const pad = value => String(value).padStart(2, '0');
  const nodes = {
    'poll-question-input': { value: 'question' }, 'poll-anonymous-input': { checked: true },
    'poll-multiple-input': { checked: false }, 'poll-quiz-input': { checked: false },
    'poll-solution-input': { value: '' }, 'poll-schedule-toggle': { checked: true },
    'poll-schedule-input': { value: `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}` },
    'poll-repeat-period': { value: '604800' }, 'modal-create-poll': { style: {} },
  };
  const document = { getElementById: id => nodes[id],
    querySelectorAll: selector => selector === '.poll-option-input-row' ? ['A', 'B'].map(value => ({querySelector: () => ({value})})) : [],
    querySelector: () => null,
  };
  const context = vm.createContext({ state, document, pollEditSession: null, encodeURIComponent, showToast() {},
    api: async (url, method, body) => { calls.push({url, body}); return {messageId: 3}; }, loadClientMessages: async () => {} });
  vm.runInContext(part('async function submitCreatePoll()', '\n// ==========================================\n// Wallpaper Themes Controller') + '\nthis.create = submitCreatePoll;', context);
  await context.create();
  assert.equal(calls[0].url, '/api/instances/a/account/poll');
  assert.equal(calls[0].body.schedule, Math.floor(future.getTime() / 60000) * 60);
  assert.equal(calls[0].body.scheduleRepeatPeriod, 604800);
});

test('poll editing updates the existing message and sends edited quiz settings', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, chatSelectionVersion: 4 };
  const calls = [], toasts = [];
  const nodes = {
    'poll-question-input': { value: 'new question' }, 'poll-anonymous-input': { checked: true },
    'poll-multiple-input': { checked: false }, 'poll-quiz-input': { checked: true },
    'poll-solution-input': { value: 'new explanation' }, 'modal-create-poll': { style: {} },
  };
  const document = { getElementById: id => nodes[id],
    querySelectorAll: selector => selector === '.poll-option-input-row'
      ? ['one', 'two'].map(value => ({querySelector: () => ({value})})) : [],
    querySelector: () => ({dataset: {idx: '1'}}),
  };
  const pollEditSession = { instId: 'a', chatId: 1, messageId: 42, selectionVersion: 4 };
  const context = vm.createContext({ state, document, pollEditSession, encodeURIComponent, showToast: x => toasts.push(x),
    api: async (url, method, body) => { calls.push({url, method, body}); return {success:true}; },
    loadClientMessages: async () => {},
  });
  vm.runInContext(part('async function submitCreatePoll()', '\n// ==========================================\n// Wallpaper Themes Controller') + '\nthis.save = submitCreatePoll;', context);
  await context.save();
  assert.equal(calls[0].url, '/api/instances/a/account/poll/edit');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
    chatId: 1, messageId: 42, question: 'new question', options: ['one', 'two'],
    pollOptions: {correctOptionIndex: 1, explanation: 'new explanation'},
  });
  assert.ok(toasts.includes('投票已更新'));
});

test('outgoing unanswered poll cards expose the guarded edit action', () => {
  const context = vm.createContext({ window: {}, state: {clientMessages:[]}, document: {},
    showToast() {}, escapeHtml: value => String(value), inlineJsArg: value => JSON.stringify(value) });
  vm.runInContext(part('function renderPollCardHtml(', '\nfunction handlePollOptionClick') + '\nthis.render = renderPollCardHtml;', context);
  const media = {type:'poll', question:'Q?', options:[{text:'A', voters:0}], totalVoters:0, canEdit:true};
  const html = context.render(media, 7, 8, true);
  assert.match(html, /editTelegramPoll\(8, 7\)/);
  assert.doesNotMatch(context.render({...media, canEdit:false}, 7, 8, true), /editTelegramPoll/);
  assert.doesNotMatch(context.render(media, 7, 8, false), /editTelegramPoll/);
  const voted = context.render({...media, canEdit:false, options:[{text:'A', voters:1, chosen:true}]}, 7, 8, false);
  assert.match(voted, /handlePollOptionClick\(8, 7, 0, false\)/);
  assert.match(voted, /withdrawTelegramPollVote\(8, 7\)/);
});

test('voted multiple-choice polls can change selections or retract all selected options', () => {
  const calls = [];
  const message = {id:42, media:{options:[
    {optionIndex:0, chosen:true}, {optionIndex:1, chosen:false},
  ]}};
  const buttonLabel = {textContent:''};
  const button = {style:{}, querySelector:() => buttonLabel};
  const rows = [{dataset:{optIdx:'0'}, classList:{toggle(){}}}, {dataset:{optIdx:'1'}, classList:{toggle(){}}}];
  const card = {querySelectorAll:() => rows};
  const context = vm.createContext({
    state:{clientSelectedInstance:'a', clientMessages:[message]}, pendingPollVotes:{},
    document:{getElementById:id => id === 'poll-card-42' ? card : id === 'btn-poll-submit-42' ? button : null},
    sendPollVote:(...args) => calls.push(args), showToast(){},
  });
  vm.runInContext(part('function handlePollOptionClick(', '\nasync function sendPollVote') + '\nthis.choose = handlePollOptionClick; this.submit = submitMultiPollVote;', context);
  context.choose(1, 42, 0, true);
  assert.equal(button.style.display, 'inline-flex');
  assert.equal(buttonLabel.textContent, '撤回投票');
  context.submit(1, 42);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[1, 42, []]]);
});

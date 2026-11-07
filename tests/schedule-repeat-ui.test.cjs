'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('schedule dialog forwards repeat period and resets it for each new schedule', () => {
  class Element {
    constructor(value = '') { this.value = value; this.style = {}; this.dataset = {}; this.onclick = null; }
  }
  const modal = new Element(), toggle = new Element(), close = new Element(), cancel = new Element();
  const confirm = new Element(), date = new Element(), repeat = new Element('604800'), text = new Element('hello');
  const nodes = new Map([
    ['btn-chat-schedule', toggle], ['modal-schedule-message', modal], ['btn-schedule-close', close],
    ['btn-schedule-cancel', cancel], ['btn-schedule-confirm', confirm], ['schedule-datetime-input', date],
    ['schedule-repeat-period', repeat], ['client-message-textarea', text],
  ]);
  const state = { clientStagedFiles: [], clientPaidMediaStars: null };
  const sent = [], toasts = [];
  const document = { getElementById: id => nodes.get(id) || null, querySelectorAll: () => [] };
  const context = vm.createContext({ state, document, Date,
    sendClientMessage: (...args) => sent.push(args), showToast: (...args) => toasts.push(args),
  });
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('function initScheduleMessage()');
  const end = source.indexOf('\n// Cinema-Grade Video Lightbox Player Controller', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.initScheduleMessage = initScheduleMessage;`, context);
  context.initScheduleMessage();
  toggle.onclick();
  assert.equal(repeat.value, '0');
  const target = new Date(Date.now() + 7200000);
  const pad = value => String(value).padStart(2, '0');
  date.value = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
  repeat.value = '604800';
  confirm.onclick();
  assert.deepEqual(sent[0], [Math.floor(target.getTime() / 60000) * 60, 604800]);
  assert.equal(modal.style.display, 'none');
  assert.deepEqual(toasts, []);
});

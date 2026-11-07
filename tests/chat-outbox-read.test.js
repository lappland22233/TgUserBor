'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js','utf8');
const start = source.indexOf('function isOutgoingMessageRead(');
const end = source.indexOf('\nfunction renderClientMessages(',start);
if (start < 0 || end < 0) throw new Error('Cannot locate read-status helper');
test('reloaded outgoing messages use only their own dialog read boundary', () => {
  const state = {clientDialogs:[{id:-42,readOutboxMaxId:10},{id:7,readOutboxMaxId:99}]};
  const context = vm.createContext({state});
  vm.runInContext(source.slice(start,end)+'\nthis.read = isOutgoingMessageRead;',context);
  assert.equal(context.read({id:9,outgoing:true},-42),true);
  assert.equal(context.read({id:11,outgoing:true},-42),false);
  assert.equal(context.read({id:9,outgoing:false},-42),false);
  assert.equal(context.read({id:9,outgoing:true},8),false);
  assert.equal(context.read({id:'temp_1',outgoing:true},7),false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/plugin-config-form.js'), 'utf8');
function setup() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.PluginConfigForm;
}
test('schema-controlled keys and number constraints are escaped in attributes', () => {
  const form = setup();
  const key = 'x" autofocus onfocus="globalThis.injected=1';
  const root = { innerHTML: '', addEventListener() {} };
  form.render(root, [{key, type:'number', label:'Value', min:'0" onfocus="globalThis.injected=1', max:'1" onclick="globalThis.injected=1', group:'__proto__'}], {});
  assert.match(root.innerHTML, /id="pcf-x&quot; autofocus onfocus=&quot;globalThis\.injected=1"/);
  assert.doesNotMatch(root.innerHTML, /min="0" onfocus=/);
  assert.doesNotMatch(root.innerHTML, /max="1" onclick=/);
  assert.match(root.innerHTML, /__proto__/);
});
test('arbitrary field keys are looked up as data rather than interpolated into CSS selectors', () => {
  const form = setup();
  const key = 'x"] div, .other[title="';
  const field = { dataset: {key}, querySelector: () => ({value:'safe'}) };
  const root = {querySelectorAll: selector => {assert.equal(selector, '.plugin-config-field'); return [field];}};
  const result = form.toJSON(root, [{key, type:'string'}]);
  assert.equal(result[key], 'safe');
});
test('prototype-like keys are represented as ordinary data', () => {
  const form = setup();
  const defaults = form.buildDefaults([{key:'__proto__', default:'ok'}, {key:'constructor', default:3}]);
  assert.equal(defaults.__proto__, 'ok');
  assert.equal(defaults.constructor, 3);
  assert.equal(Object.getPrototypeOf(defaults), null);
});

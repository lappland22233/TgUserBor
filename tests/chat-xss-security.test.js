'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Cannot find security functions');
  return source.slice(a, b);
}
function setup() {
  const context = vm.createContext({});
  vm.runInContext(section('function escapeHtml(', '// Interactive Auth Modal') + '\nthis.formatMessageContent=formatMessageContent; this.inlineJsArg=inlineJsArg; this.escapeHtml=escapeHtml;', context);
  return context;
}
test('untrusted text and URLs cannot break HTML attribute or link context', () => {
  const c = setup();
  const payload = `" onmouseover="globalThis.pwned=1" x="`;
  const html = c.formatMessageContent(`https://example.test/${payload} <img src=x onerror=evil()>`, []);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('" onmouseover="'));
  const entity = c.formatMessageContent('go', [{ type:'text_url', offset:0, length:2, url:'javascript:evil()' }]);
  assert.match(entity, /href="#"/);
});
test('custom emoji entities load only a validated account-scoped document URL', () => {
  const c = setup();
  c.state = { clientSelectedInstance: 'account / 1' };
  const html = c.formatMessageContent('🙂', [{ type:'MessageEntityCustomEmoji', offset:0, length:2, documentId:'12345' }]);
  assert.match(html, /class="tg-custom-emoji"/);
  assert.match(html, /\/api\/instances\/account%20%2F%201\/account\/custom-emoji\?documentId=12345/);
  assert.match(html, /alt="🙂"/);
  assert.equal(c.formatMessageContent('🙂', [{ type:'MessageEntityCustomEmoji', offset:0, length:2, documentId:'bad' }]), '🙂');
});
test('Telegram blockquotes render with nested formatting entities', () => {
  const c = setup();
  const html = c.formatMessageContent('引用粗体', [
    { type:'MessageEntityBlockquote', offset:0, length:4 },
    { type:'MessageEntityBold', offset:2, length:2 },
  ]);
  assert.equal(html, '<blockquote class="tg-blockquote">引用<strong>粗体</strong></blockquote>');
  const collapsed = c.formatMessageContent('引用内容', [
    { type:'MessageEntityBlockquote', offset:0, length:4, collapsed:true },
  ]);
  assert.equal(collapsed, '<details class="tg-blockquote tg-blockquote-collapsed"><summary><span class="tg-quote-show">显示引用文本</span><span class="tg-quote-hide">收起引用文本</span></summary><div class="tg-blockquote-content">引用内容</div></details>');
});
test('untrusted strings remain a single literal in inline JavaScript', () => {
  const c = setup();
  const payload = `'); globalThis.pwned = 1; // \" &`;
  const encoded = c.inlineJsArg(payload);
  assert.ok(!encoded.includes('"'));
  const decoded = encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const sandbox = { received: null, pwned: false };
  vm.runInNewContext(`received = ${decoded}`, sandbox);
  assert.equal(sandbox.received, payload);
  assert.equal(sandbox.pwned, false);
});
test('instance card escapes account names and proxy fields in HTML', () => {
  const context = vm.createContext({ formatBytes: ()=>'0', formatUptime: ()=>'0' });
  vm.runInContext(section('function escapeHtml(', '// Interactive Auth Modal') + section('function createInstanceCardHtml(', 'function updateInstanceStatus(') + '\nthis.render=createInstanceCardHtml;', context);
  const payload = `"><img src=x onerror=evil()>`;
  const html = context.render({ config:{id:'a',name:payload,proxy:{type:'socks5',host:payload,port:1}},status:'STOPPED',metrics:{},self:{username:payload} });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

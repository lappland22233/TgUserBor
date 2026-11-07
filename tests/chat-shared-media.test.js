'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js','utf8');
const start = source.indexOf('function renderSharedMessageMedia(');
const end = source.indexOf('\nfunction renderClientMessages(',start);
if (start < 0 || end < 0) throw new Error('Shared media renderer missing');
const context=vm.createContext({encodeURIComponent, escapeHtml: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')});
vm.runInContext(source.slice(start,end)+'\nthis.render = renderSharedMessageMedia;',context);
test('contact and venue text are escaped and coordinates cannot inject markup',()=>{
  const contact=context.render({type:'contact',contactFirstName:'<img src=x onerror=alert(1)>',contactPhone:'" onclick="alert(1)'});
  assert.ok(!contact.includes('<img')); assert.match(contact,/&lt;img/);
  const invalid=context.render({type:'location',locationTitle:'<script>bad</script>',latitude:'0" onclick="alert(1)',longitude:0});
  assert.ok(!invalid.includes('<script>')); assert.ok(!invalid.includes('<a '));
  assert.match(invalid,/位置不可用/);
});
test('valid zero coordinates link only to an explicit HTTPS map and are not embedded',()=>{
  const html=context.render({type:'location',latitude:0,longitude:0,liveLocation:true});
  assert.match(html,/实时位置/); assert.match(html,/https:\/\/www\.openstreetmap\.org\//);
  assert.match(html,/noopener noreferrer/); assert.ok(!html.includes('<iframe')); assert.ok(!html.includes('<img'));
  assert.match(context.render({type:'unsupported'}),/暂不支持/);
});
test('GIF images and video animations use suitable safe playback elements', () => {
  const a=source.indexOf('function renderAnimationMedia('), b=source.indexOf('\nfunction renderSharedMessageMedia(',a);
  assert.ok(a>=0 && b>a);
  const c=vm.createContext({escapeHtml: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')});
  vm.runInContext(source.slice(a,b)+'\nthis.render = renderAnimationMedia;',c);
  const hostile='/media?x=" onerror="evil()';
  const gif=c.render({mimeType:'image/gif'},hostile);
  assert.match(gif,/<img /); assert.doesNotMatch(gif,/<video /); assert.doesNotMatch(gif,/" onerror="/);
  const mp4=c.render({mimeType:'video/mp4'},'/media');
  assert.match(mp4,/<video /); assert.match(mp4,/muted/); assert.match(mp4,/playsinline/);
});
test('Telegram video messages use a circular native player while regular videos keep the cinema card', () => {
  const a = source.indexOf('function renderTelegramVideoMedia('), b = source.indexOf('\nfunction renderSharedMessageMedia(', a);
  assert.ok(a >= 0 && b > a);
  const c = vm.createContext({ encodeURIComponent, formatDurationSec: seconds => `${seconds}s`, inlineJsArg: value => JSON.stringify(String(value)),
    escapeHtml: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') });
  vm.runInContext(source.slice(a,b) + '\nthis.render = renderTelegramVideoMedia;', c);
  const note = c.render({ roundVideo: true, duration: 4 }, 'a', -42, 8, 'Alice', '12:00');
  assert.match(note, /video-note-player/);
  assert.match(note, /controls playsinline/);
  assert.match(note, /video-note-duration/);
  assert.doesNotMatch(note, /openCinemaVideo/);
  const regular = c.render({ duration: 4 }, 'a', -42, 9, 'Alice', '12:00');
  assert.match(regular, /custom-video-card/);
  assert.match(regular, /openCinemaVideo/);
});
test('paid-media rendering binds each unlocked item to its own message media index', () => {
  const a = source.indexOf('function renderPaidMediaItems('), b = source.indexOf('\nasync function buyChatPaidMedia(', a);
  assert.ok(a >= 0 && b > a);
  const c = vm.createContext({ URLSearchParams, encodeURIComponent, inlineJsArg: value => JSON.stringify(String(value)),
    escapeHtml: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
    renderAnimationMedia: () => '<div>animation</div>' });
  vm.runInContext(source.slice(a,b) + '\nthis.render = renderPaidMediaItems;', c);
  const html = c.render({ paidMediaItems: [{ type:'photo' }, { type:'video' }] }, 'a', -10042, 9, 'Alice');
  assert.match(html, /mediaIndex=0/);
  assert.match(html, /mediaIndex=1/);
  assert.match(html, /paid-media-video/);
  assert.match(html, /openLightbox/);
  assert.doesNotMatch(html, /onerror=/);
});

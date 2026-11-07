'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram Business settings map only safe read-only account metadata', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.logger = {debug(){}};
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.users.GetFullUser) return {fullUser:{
      businessWorkHours:{className:'BusinessWorkHours', openNow:true, timezoneId:'Europe/Helsinki', weeklyOpen:[
        {startMinute:540, endMinute:1020}, {startMinute:-5, endMinute:40},
      ]},
      businessLocation:{address:'Office', geoPoint:{lat:60.17, long:24.94}},
      businessGreetingMessage:{shortcutId:7, noActivityDays:30, recipients:{newChats:true, contacts:true, users:[1,2]}},
      businessAwayMessage:{shortcutId:8, offlineOnly:true, schedule:{className:'BusinessAwayMessageScheduleCustom', startDate:10, endDate:20}, recipients:{nonContacts:true}},
      businessIntro:{title:'Hello', description:'Welcome', sticker:{id:9}},
    }};
    if (request instanceof Api.account.GetBusinessChatLinks) return {links:[
      {title:'Contact', link:'https://t.me/m/abc_123', message:'Message', views:12},
      {title:'Unsafe', link:'https://evil.example/m/no', message:'No', views:1},
    ]};
    throw new Error('Unexpected request');
  }};
  const result = await driver.getTelegramBusinessSettings();
  assert.deepEqual(result, {
    workHours:{openNow:true, timezoneId:'Europe/Helsinki', weeklyOpen:[{startMinute:540,endMinute:1020}]},
    location:{address:'Office', latitude:60.17, longitude:24.94},
    greeting:{shortcutId:7, noActivityDays:30, recipients:{existingChats:false,newChats:true,contacts:true,nonContacts:false,excludeSelected:false,selectedUsers:2}},
    away:{shortcutId:8, offlineOnly:true, schedule:'custom', startDate:10, endDate:20,
      recipients:{existingChats:false,newChats:false,contacts:false,nonContacts:true,excludeSelected:false,selectedUsers:0}},
    intro:{title:'Hello',description:'Welcome',hasSticker:true},
    chatLinks:[{title:'Contact',url:'https://t.me/m/abc_123',message:'Message',views:12}, {title:'Unsafe',message:'No',views:1}],
  });
  assert.equal(calls[0].className, 'users.GetFullUser');
  assert.equal(calls[1].className, 'account.GetBusinessChatLinks');
});

test('Telegram Business work hours update validates the schedule and sends the Telegram request', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => { calls.push(request); return true; } };
  await driver.updateTelegramBusinessWorkHours('Europe/Helsinki', [
    {startMinute: 1980, endMinute: 2460}, {startMinute: 540, endMinute: 1020},
  ]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Api.account.UpdateBusinessWorkHours);
  assert.equal(calls[0].businessWorkHours.timezoneId, 'Europe/Helsinki');
  assert.deepEqual(calls[0].businessWorkHours.weeklyOpen.map(item => [item.startMinute, item.endMinute]), [[540, 1020], [1980, 2460]]);
  await assert.rejects(() => driver.updateTelegramBusinessWorkHours('Bad/Zone', []), /timezone/i);
  await assert.rejects(() => driver.updateTelegramBusinessWorkHours('UTC', [
    {startMinute: 540, endMinute: 700}, {startMinute: 690, endMinute: 800},
  ]), /overlapping/i);
  assert.equal(calls.length, 1);
});

test('Telegram Business location update preserves address and coordinates and supports clearing', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => { calls.push(request); return true; } };
  await driver.updateTelegramBusinessLocation('Harbor 5', 60.17, 24.94);
  await driver.updateTelegramBusinessLocation('');
  assert.ok(calls[0] instanceof Api.account.UpdateBusinessLocation);
  assert.equal(calls[0].address, 'Harbor 5');
  assert.deepEqual([calls[0].geoPoint.lat, calls[0].geoPoint.long], [60.17, 24.94]);
  assert.ok(calls[1] instanceof Api.account.UpdateBusinessLocation);
  assert.equal(calls[1].address, undefined);
  assert.equal(calls[1].geoPoint, undefined);
  await assert.rejects(() => driver.updateTelegramBusinessLocation('X', 91, 10), /location/i);
  await assert.rejects(() => driver.updateTelegramBusinessLocation('X', 10), /location/i);
  assert.equal(calls.length, 2);
});

test('Telegram Business intro edits preserve its Telegram sticker and explicit clearing removes the intro', async () => {
  const calls = [];
  const sticker = new Api.Document({id:11n,accessHash:12n,fileReference:Buffer.from('ref'),date:1,mimeType:'image/webp',size:8,dcId:2,attributes:[]});
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.users.GetFullUser) return {fullUser:{businessIntro:{title:'Old',description:'Text',sticker}}};
    return true;
  }};
  await driver.updateTelegramBusinessIntro('Updated','New text');
  assert.ok(calls[0] instanceof Api.users.GetFullUser);
  assert.ok(calls[1] instanceof Api.account.UpdateBusinessIntro);
  assert.equal(calls[1].intro.title,'Updated');
  assert.equal(calls[1].intro.description,'New text');
  assert.ok(calls[1].intro.sticker instanceof Api.InputDocument);
  assert.equal(String(calls[1].intro.sticker.id),'11');
  assert.equal(String(calls[1].intro.sticker.accessHash),'12');
  await driver.updateTelegramBusinessIntro('','',true);
  assert.ok(calls[2] instanceof Api.account.UpdateBusinessIntro);
  assert.equal(calls[2].intro,undefined);
  await assert.rejects(() => driver.updateTelegramBusinessIntro('x'.repeat(257),''), /intro/i);
  assert.equal(calls.length,3);
});

test('Telegram Business chat links can be created and only Telegram-owned links can be deleted', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.CreateBusinessChatLink) {
      return new Api.BusinessChatLink({link:'https://t.me/m/new_link',message:'Hello',title:'Contact',views:0});
    }
    if (request instanceof Api.account.GetBusinessChatLinks) return {links:[{link:'https://t.me/m/owned_link'}]};
    return true;
  }};
  const created = await driver.createTelegramBusinessChatLink('Contact','Hello');
  assert.ok(calls[0] instanceof Api.account.CreateBusinessChatLink);
  assert.equal(calls[0].link.title,'Contact');
  assert.equal(calls[0].link.message,'Hello');
  assert.deepEqual(created,{title:'Contact',url:'https://t.me/m/new_link',message:'Hello',views:0});
  await driver.deleteTelegramBusinessChatLink('owned_link');
  assert.ok(calls[1] instanceof Api.account.GetBusinessChatLinks);
  assert.ok(calls[2] instanceof Api.account.DeleteBusinessChatLink);
  assert.equal(calls[2].slug,'owned_link');
  await assert.rejects(() => driver.deleteTelegramBusinessChatLink('foreign_link'), /not found/i);
  await assert.rejects(() => driver.createTelegramBusinessChatLink('','  '), /chat link/i);
  assert.equal(calls.length,4);
});

test('Telegram Business chat-link title edits preserve Telegram entities and message edits clear stale entities', async () => {
  const calls = [];
  const bold = new Api.MessageEntityBold({offset:0,length:5});
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.GetBusinessChatLinks) return {links:[{
      link:'https://t.me/m/owned_link',message:'Hello world',entities:[bold],title:'Old',views:1,
    }]};
    if (request instanceof Api.account.EditBusinessChatLink) {
      return new Api.BusinessChatLink({link:'https://t.me/m/owned_link',message:request.link.message,title:request.link.title || '',views:1});
    }
    throw new Error('Unexpected request');
  }};
  await driver.editTelegramBusinessChatLink('owned_link','Renamed','Hello world');
  assert.ok(calls[1] instanceof Api.account.EditBusinessChatLink);
  assert.deepEqual(calls[1].link.entities,[bold]);
  await driver.editTelegramBusinessChatLink('owned_link','Renamed','Plain replacement');
  assert.equal(calls[3].link.entities,undefined);
  await assert.rejects(() => driver.editTelegramBusinessChatLink('foreign','x','y'), /not found/i);
});

test('Telegram Business greeting and away messages use saved quick replies and preserve selected-user recipients', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolveAdminInputUser = async id => new Api.InputUser({userId:BigInt(id),accessHash:987n});
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.messages.GetQuickReplies) return {quickReplies:[{shortcutId:7,shortcut:'welcome'}]};
    if (request instanceof Api.users.GetFullUser) return {fullUser:{
      businessGreetingMessage:{recipients:{newChats:true,users:[222n],excludeSelected:true}},
      businessAwayMessage:{recipients:{contacts:true}},
    }};
    return true;
  }};
  await driver.updateTelegramBusinessGreetingMessage(7,14,{existingChats:true,newChats:false,contacts:true,nonContacts:false});
  const greeting = calls.find(request => request instanceof Api.account.UpdateBusinessGreetingMessage);
  assert.equal(greeting.message.shortcutId,7);
  assert.equal(greeting.message.noActivityDays,14);
  assert.equal(greeting.message.recipients.existingChats,true);
  assert.equal(greeting.message.recipients.newChats,false);
  assert.equal(greeting.message.recipients.excludeSelected,true);
  assert.deepEqual(greeting.message.recipients.users.map(user => [String(user.userId),String(user.accessHash)]),[['222','987']]);

  await driver.updateTelegramBusinessAwayMessage(7,true,'custom',1000,2000,
    {existingChats:false,newChats:true,contacts:false,nonContacts:true});
  const away = calls.find(request => request instanceof Api.account.UpdateBusinessAwayMessage);
  assert.equal(away.message.offlineOnly,true);
  assert.ok(away.message.schedule instanceof Api.BusinessAwayMessageScheduleCustom);
  assert.deepEqual([away.message.schedule.startDate,away.message.schedule.endDate],[1000,2000]);
  assert.ok(calls.every(request => !(request instanceof Api.account.UpdateBusinessGreetingMessage) || request.message.recipients.users.length === 1));
  await assert.rejects(() => driver.updateTelegramBusinessAwayMessage(7,false,'custom',2000,1000,
    {existingChats:false,newChats:false,contacts:false,nonContacts:false}), /schedule/i);
  await driver.updateTelegramBusinessGreetingMessage(0,0,{existingChats:false,newChats:false,contacts:false,nonContacts:false},true);
  assert.ok(calls.at(-1) instanceof Api.account.UpdateBusinessGreetingMessage);
  assert.equal(calls.at(-1).message,undefined);
});

test('Business settings GET stays private and the work-hours POST validates before dispatch', async () => {
  const calls = [];
  const manager = {getInstance:id => id === 'account-a' ? {accountAction:async (...args) => {
    calls.push(args); return args[0] === 'get_telegram_business_settings' ? {chatLinks:[]} : undefined;
  }} : undefined};
  const server = http.createServer((req,res) => handleApiRoute(req,res,manager,'').catch(error => {res.statusCode=500;res.end(error.message);}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/account-a/account/business-settings`;
    const response = await fetch(endpoint);
    assert.equal(response.status,200);
    assert.match(response.headers.get('cache-control'),/private, no-store/);
    assert.deepEqual(await response.json(),{chatLinks:[]});
    const update = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      timezoneId:'Europe/Helsinki', weeklyOpen:[{startMinute:540,endMinute:1020},{startMinute:1980,endMinute:2460}],
    })});
    assert.equal(update.status,200);
    assert.match(update.headers.get('cache-control'),/private, no-store/);
    assert.deepEqual(await update.json(),{success:true});
    const invalid = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      timezoneId:'UTC', weeklyOpen:[{startMinute:600,endMinute:900},{startMinute:800,endMinute:1000}],
    })});
    assert.equal(invalid.status,400);
    assert.deepEqual(calls,[['get_telegram_business_settings'],['update_telegram_business_work_hours',{
      timezoneId:'Europe/Helsinki',weeklyOpen:[{startMinute:540,endMinute:1020},{startMinute:1980,endMinute:2460}],
    }]]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Business location route rejects invalid coordinates and dispatches only complete values', async () => {
  const calls = [];
  const manager = {getInstance:id => id === 'account-a' ? {accountAction:async (...args) => { calls.push(args); }} : undefined};
  const server = http.createServer((req,res) => handleApiRoute(req,res,manager,'').catch(error => {res.statusCode=500;res.end(error.message);}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/account-a/account/business-location`;
    const invalid = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:'A',latitude:60})});
    assert.equal(invalid.status,400);
    const valid = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:'Harbor 5',latitude:60.17,longitude:24.94})});
    assert.equal(valid.status,200);
    assert.deepEqual(calls,[['update_telegram_business_location',{address:'Harbor 5',latitude:60.17,longitude:24.94}]]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Business intro route bounds text and targets only the selected account', async () => {
  const calls = [];
  const manager = {getInstance:id => id === 'account-a' ? {accountAction:async (...args) => { calls.push(args); }} : undefined};
  const server = http.createServer((req,res) => handleApiRoute(req,res,manager,'').catch(error => {res.statusCode=500;res.end(error.message);}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/account-a/account/business-intro`;
    const invalid = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'x'.repeat(257),description:'',clear:false})});
    assert.equal(invalid.status,400);
    const valid = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'About me',description:'Welcome',clear:false})});
    assert.equal(valid.status,200);
    assert.deepEqual(calls,[['update_telegram_business_intro',{title:'About me',description:'Welcome',clear:false}]]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Business chat-link route validates create, edit, and delete actions before dispatch', async () => {
  const calls = [];
  const manager = {getInstance:id => id === 'account-a' ? {accountAction:async (...args) => { calls.push(args); return {url:'https://t.me/m/test'}; }} : undefined};
  const server = http.createServer((req,res) => handleApiRoute(req,res,manager,'').catch(error => {res.statusCode=500;res.end(error.message);}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/account-a/account/business-chat-links`;
    const invalid = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',title:'',message:' '})});
    assert.equal(invalid.status,400);
    const created = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',title:'Contact',message:'Hello'})});
    assert.equal(created.status,200);
    assert.deepEqual(await created.json(),{url:'https://t.me/m/test'});
    const deleted = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'delete',slug:'link_1'})});
    assert.equal(deleted.status,200);
    const edited = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'edit',slug:'link_1',title:'Renamed',message:'Updated'})});
    assert.equal(edited.status,200);
    const badDelete = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'delete',slug:'../other'})});
    assert.equal(badDelete.status,400);
    assert.deepEqual(calls,[['create_telegram_business_chat_link',{title:'Contact',message:'Hello'}],['delete_telegram_business_chat_link',{slug:'link_1'}],
      ['edit_telegram_business_chat_link',{slug:'link_1',title:'Renamed',message:'Updated'}]]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Business greeting and away routes validate quick replies, recipients, and schedule bounds', async () => {
  const calls = [];
  const manager = {getInstance:id => id === 'account-a' ? {accountAction:async (...args) => { calls.push(args); }} : undefined};
  const server = http.createServer((req,res) => handleApiRoute(req,res,manager,'').catch(error => {res.statusCode=500;res.end(error.message);}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/account-a/account`;
    const recipients={existingChats:false,newChats:true,contacts:true,nonContacts:false};
    const greeting=await fetch(`${base}/business-greeting-message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      shortcutId:7,noActivityDays:14,recipients,clear:false,
    })});
    assert.equal(greeting.status,200);
    const badGreeting=await fetch(`${base}/business-greeting-message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      shortcutId:7,noActivityDays:400,recipients,clear:false,
    })});
    assert.equal(badGreeting.status,400);
    const away=await fetch(`${base}/business-away-message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      shortcutId:7,offlineOnly:true,schedule:'custom',startDate:1000,endDate:2000,recipients,clear:false,
    })});
    assert.equal(away.status,200);
    const badAway=await fetch(`${base}/business-away-message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      shortcutId:7,offlineOnly:true,schedule:'custom',startDate:2000,endDate:1000,recipients,clear:false,
    })});
    assert.equal(badAway.status,400);
    assert.deepEqual(calls,[
      ['update_telegram_business_greeting_message',{shortcutId:7,noActivityDays:14,recipients,clear:false}],
      ['update_telegram_business_away_message',{shortcutId:7,offlineOnly:true,schedule:'custom',startDate:1000,endDate:2000,recipients,clear:false}],
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Business settings UI uses safe text nodes and rejects stale account responses', async () => {
  const source = fs.readFileSync('src/gui/web/js/settings.js','utf8');
  const start = source.indexOf('async function loadBusinessSettings(');
  const end = source.indexOf('\n  async function loadDefaultHistoryTtl(',start);
  assert.ok(start >= 0 && end > start);
  class Element {
    constructor(tag='div') { this.tagName=tag; this.children=[]; this.attrs={}; this.textContent=''; this.className=''; this.hidden=false; }
    replaceChildren(...children) { this.children=children; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute(name,value) { this.attrs[name]=value; }
  }
  const status=new Element(), list=new Element();
  const container={querySelector:selector => selector==='#setting-business-status'?status:selector==='#setting-business-list'?list:null};
  const state={clientSelectedInstance:'a'};
  let resolve;
  const context=vm.createContext({state,encodeURIComponent,Number,String,Boolean,Array,Date,Promise,
    businessSettingsRequest:0,loadedBusinessSettingsInstance:null,
    document:{createElement:tag=>new Element(tag)},
    api:async (...args)=>{assert.equal(args[0],'/api/instances/a/account/business-settings'); return new Promise(done=>{resolve=done;});},
  });
  vm.runInContext(`${source.slice(start,end)}\nthis.load=loadBusinessSettings;`,context);
  const pending=context.load(container);
  state.clientSelectedInstance='b';
  resolve({intro:{title:'<script>alert(1)</script>'},chatLinks:[{title:'Call',message:'Hi',url:'https://evil.example'}]});
  await pending;
  assert.equal(list.children.length,0);
  assert.match(status.textContent,/正在读取/);

  state.clientSelectedInstance='a';
  context.api=async()=>({
    workHours:{openNow:true,timezoneId:'UTC',weeklyOpen:[{startMinute:540,endMinute:1020}]},
    intro:{title:'<b>Business</b>',description:'About'},
    chatLinks:[{title:'Contact',message:'Hello',url:'https://t.me/m/abc',views:3}],
  });
  await context.load(container,true);
  assert.equal(list.children.length,3,status.textContent);
  assert.match(list.children[0].children[1].textContent,/周一 09:00–周一 17:00/);
  assert.equal(list.children[1].children[1].textContent,'<b>Business</b> · About');
  assert.equal(list.children[2].children[2].href,'https://t.me/m/abc');
  assert.match(status.textContent,/可编辑/);
});

test('Business work-hours editor retains the timezone and every weekly interval on save', async () => {
  const source = fs.readFileSync('src/gui/web/js/settings.js','utf8');
  const start = source.indexOf('async function loadBusinessSettings(');
  const end = source.indexOf('\n  async function loadDefaultHistoryTtl(',start);
  class Element {
    constructor(tag='div') { this.tagName=tag; this.children=[]; this.attrs={}; this.dataset={}; this.textContent=''; this.className=''; this.hidden=false; this.value=''; this.checked=false; this.disabled=false; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children=children; children.forEach(child => { child.parentNode=this; }); }
    appendChild(child) { child.parentNode=this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    setAttribute(name,value) { this.attrs[name]=value; }
    remove() { if (this.parentNode) this.parentNode.children=this.parentNode.children.filter(item => item!==this); }
  }
  const ids = [
    'setting-business-status','setting-business-list','setting-business-work-hours-editor','btn-edit-business-work-hours',
    'setting-business-intervals','setting-business-timezone','setting-business-work-hours-status','btn-add-business-interval',
    'btn-save-business-work-hours','btn-cancel-business-work-hours','setting-business-location-editor','btn-edit-business-location',
    'setting-business-location-address','setting-business-location-latitude','setting-business-location-longitude',
    'setting-business-location-status','btn-save-business-location','btn-cancel-business-location','setting-business-intro-editor',
    'btn-edit-business-intro','setting-business-intro-title','setting-business-intro-description','setting-business-intro-status',
    'btn-save-business-intro','btn-clear-business-intro','btn-cancel-business-intro','setting-business-chat-link-editor',
    'btn-add-business-chat-link','setting-business-chat-link-title','setting-business-chat-link-message','setting-business-chat-link-status',
    'btn-save-business-chat-link','btn-cancel-business-chat-link','setting-business-greeting-editor','btn-edit-business-greeting',
    'setting-business-chat-link-formatting',
    'setting-business-greeting-shortcut','setting-business-greeting-days','setting-business-greeting-preserved-users','setting-business-greeting-recipients',
    'setting-business-greeting-status','btn-save-business-greeting','btn-clear-business-greeting','btn-cancel-business-greeting',
    'setting-business-away-editor','btn-edit-business-away','setting-business-away-shortcut','setting-business-away-schedule',
    'setting-business-away-start','setting-business-away-end','setting-business-away-custom-dates','setting-business-away-offline-only',
    'setting-business-away-preserved-users','setting-business-away-recipients','setting-business-away-status',
    'btn-save-business-away','btn-clear-business-away','btn-cancel-business-away',
  ];
  const elements = Object.fromEntries(ids.map(id => [id,new Element()]));
  const container={querySelector:selector => elements[selector.slice(1)] || null};
  const state={clientSelectedInstance:'acct'};
  const payload={workHours:{timezoneId:'Europe/Helsinki',weeklyOpen:[{startMinute:540,endMinute:720},{startMinute:1980,endMinute:2460}]},
    location:{address:'Harbor 5',latitude:60.17,longitude:24.94}, intro:{title:'About me',description:'Welcome',hasSticker:true},
    greeting:{shortcutId:7,noActivityDays:30,recipients:{newChats:true,contacts:true,selectedUsers:1,excludeSelected:true}},
    away:{shortcutId:7,offlineOnly:true,schedule:'outside_work_hours',recipients:{existingChats:true,nonContacts:true}},
    chatLinks:[{title:'Contact',url:'https://t.me/m/owned_link',message:'Hello',hasFormatting:true,views:2}]};
  const requests=[];
  const context=vm.createContext({state,encodeURIComponent,Number,String,Boolean,Array,Date,Promise,Intl,
    businessSettingsRequest:0,loadedBusinessSettingsInstance:null,
    window:{confirm:()=>true},
    document:{createElement:tag=>new Element(tag)},
    api:async (url,method='GET',body=null)=>{requests.push({url,method,body}); return method==='POST'?{success:true}:url.endsWith('/account/quick-replies')?
      [{shortcutId:7,shortcut:'welcome',count:1}]:payload;},
  });
  vm.runInContext(`${source.slice(start,end)}\nthis.load=loadBusinessSettings;`,context);
  await context.load(container);
  assert.equal(elements['btn-edit-business-work-hours'].hidden,false);
  elements['btn-edit-business-work-hours'].onclick();
  assert.equal(elements['setting-business-timezone'].value,'Europe/Helsinki');
  assert.equal(elements['setting-business-intervals'].children.length,2);
  await elements['btn-save-business-work-hours'].onclick();
  const post=requests.find(request=>request.method==='POST');
  assert.equal(JSON.stringify(post.body),JSON.stringify({timezoneId:'Europe/Helsinki',weeklyOpen:[{startMinute:540,endMinute:720},{startMinute:1980,endMinute:2460}]}));
  assert.equal(elements['setting-business-work-hours-editor'].hidden,true);
  elements['btn-edit-business-location'].onclick();
  assert.equal(elements['setting-business-location-address'].value,'Harbor 5');
  assert.equal(elements['setting-business-location-latitude'].value,'60.17');
  elements['setting-business-location-address'].value='Market Square';
  await elements['btn-save-business-location'].onclick();
  const locationPost=requests.find(request=>request.method==='POST' && request.url.endsWith('/account/business-location'));
  assert.equal(JSON.stringify(locationPost.body),JSON.stringify({address:'Market Square',latitude:60.17,longitude:24.94}));
  assert.equal(elements['setting-business-location-editor'].hidden,true);
  elements['btn-edit-business-intro'].onclick();
  assert.equal(elements['setting-business-intro-title'].value,'About me');
  assert.equal(elements['setting-business-intro-description'].value,'Welcome');
  elements['setting-business-intro-description'].value='Updated welcome';
  await elements['btn-save-business-intro'].onclick();
  const introPost=requests.find(request=>request.method==='POST' && request.url.endsWith('/account/business-intro'));
  assert.equal(JSON.stringify(introPost.body),JSON.stringify({title:'About me',description:'Updated welcome',clear:false}));
  assert.equal(elements['setting-business-intro-editor'].hidden,true);
  elements['btn-add-business-chat-link'].onclick();
  elements['setting-business-chat-link-title'].value='New Link';
  elements['setting-business-chat-link-message'].value='Start a conversation';
  await elements['btn-save-business-chat-link'].onclick();
  const createPost=requests.find(request=>request.method==='POST' && request.body?.action==='create');
  assert.equal(JSON.stringify(createPost.body),JSON.stringify({action:'create',title:'New Link',message:'Start a conversation'}));
  let linkRow=elements['setting-business-list'].children.find(row=>row.className==='settings-business-link');
  linkRow.children[4].children[0].onclick();
  assert.equal(elements['setting-business-chat-link-title'].value,'Contact');
  assert.match(elements['setting-business-chat-link-formatting'].textContent,/只改名称会保留格式/);
  elements['setting-business-chat-link-title'].value='Renamed';
  elements['setting-business-chat-link-message'].value='Updated message';
  await elements['btn-save-business-chat-link'].onclick();
  const editPost=requests.find(request=>request.method==='POST' && request.body?.action==='edit');
  assert.equal(JSON.stringify(editPost.body),JSON.stringify({action:'edit',slug:'owned_link',title:'Renamed',message:'Updated message'}));
  linkRow=elements['setting-business-list'].children.find(row=>row.className==='settings-business-link');
  await linkRow.children[4].children[1].onclick();
  const deletePost=requests.find(request=>request.method==='POST' && request.body?.action==='delete');
  assert.equal(JSON.stringify(deletePost.body),JSON.stringify({action:'delete',slug:'owned_link'}));
  await elements['btn-edit-business-greeting'].onclick();
  assert.equal(elements['setting-business-greeting-shortcut'].value,'7');
  assert.equal(elements['setting-business-greeting-days'].value,'30');
  const greetingBoxes=elements['setting-business-greeting-recipients'].children.map(label=>label.children[0]);
  assert.equal(greetingBoxes.find(box=>box.dataset.recipient==='newChats').checked,true);
  greetingBoxes.find(box=>box.dataset.recipient==='newChats').checked=false;
  greetingBoxes.find(box=>box.dataset.recipient==='existingChats').checked=true;
  await elements['btn-save-business-greeting'].onclick();
  const greetingPost=requests.find(request=>request.method==='POST' && request.url.endsWith('/account/business-greeting-message'));
  assert.equal(JSON.stringify(greetingPost.body),JSON.stringify({shortcutId:7,noActivityDays:30,recipients:{
    newChats:false,existingChats:true,contacts:true,nonContacts:false,
  },clear:false}));
  await elements['btn-edit-business-away'].onclick();
  assert.equal(elements['setting-business-away-schedule'].value,'outside_work_hours');
  await elements['btn-save-business-away'].onclick();
  const awayPost=requests.find(request=>request.method==='POST' && request.url.endsWith('/account/business-away-message'));
  assert.equal(JSON.stringify(awayPost.body),JSON.stringify({shortcutId:7,offlineOnly:true,schedule:'outside_work_hours',
    recipients:{newChats:false,existingChats:true,contacts:false,nonContacts:true},clear:false}));
});

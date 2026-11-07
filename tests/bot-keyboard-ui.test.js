'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/js/bot-keyboard.js','utf8');
function fixture() {
function node(tag) { return {tag, children:[], appendChild(x){x.parentNode=this;this.children.push(x);}, replaceChildren(...items){this.children.forEach(x=>x.parentNode=null);this.children=items;items.forEach(x=>x.parentNode=this);}, remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;}, setAttribute(k,v){this[k]=v;} }; }
  const state = {clientSelectedInstance:'a',clientActiveChatId:1,chatSelectionVersion:1,clientDialogs:[
    {id:101,type:'private',title:'Alice',isBot:false,isPremium:false},
    {id:102,type:'private',title:'Helper Bot',isBot:true,isPremium:false},
  ]};
  const calls=[], toasts=[], copied=[], profiles=[], confirmations=[]; let resolve;
  const context = {window:{alert:x=>toasts.push(x),confirm:x=>{confirmations.push(x);return true;},loadPeerProfile:id=>profiles.push(id)}, document:{createElement:node}, navigator:{clipboard:{writeText:async text=>copied.push(text)}}, URL, state, encodeURIComponent,
    api:(url,method,body)=>{ calls.push({url,method,body}); return new Promise(r=>{resolve=r;}); }, showToast:x=>toasts.push(x),loadClientMessages:async()=>{},
    setTimeout:callback=>{callback();return 1;},clearTimeout:()=>{}};
  vm.runInNewContext(source,context);
  const parent=node('parent');
  return {...context,parent,calls,toasts,copied,profiles,confirmations,resolve:x=>resolve(x)};
}
test('unsafe URLs and unsupported buttons are disabled; captions are text only', () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[
    {type:'url',url:'javascript:alert(1)',text:'<img onerror=alert(1)>'},
    {type:'url',url:'https://example.org/path',text:'Open'},
    {type:'unsupported',text:'Mini App'},
  ]]},'a',1);
  const buttons=f.parent.children[0].children[0].children;
  assert.equal(buttons[0].disabled,true); assert.equal(buttons[0].textContent,'<img onerror=alert(1)>');
  assert.equal(buttons[1].tag,'a'); assert.equal(buttons[1].rel,'noopener noreferrer');
  assert.equal(buttons[2].disabled,true);
});
test('copy button writes its Telegram-provided text only after a direct click', async () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'copy',text:'Copy code',copyText:'TG-1234',row:0,column:0}]]},'a',1);
  const button=f.parent.children[0].children[0].children[0];
  assert.equal(button.disabled,undefined);
  await button.onclick();
  assert.deepEqual(f.copied,['TG-1234']);
  assert.equal(f.toasts.at(-1),'已复制到剪贴板');
});
test('game button asks Telegram to launch the original button and exposes only a safe click-through URL', async () => {
  const f = fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'game',text:'Play',row:0,column:0}]]},'a',1);
  const root=f.parent.children[0],button=root.children[0].children[0],status=root.children[1];
  const pending=button.onclick();
  assert.equal(f.calls[0].url,'/api/instances/a/account/bot-game');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{chatId:1,messageId:2,row:0,column:0});
  f.resolve({url:'https://games.example/play'}); await pending;
  assert.equal(status.children[0].href,'https://games.example/play');
  assert.equal(status.children[0].rel,'noopener noreferrer');
});
test('inline user profile button opens only the user requested by its Telegram markup', () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'user_profile',text:'View user',userId:123456}]]},'a',1);
  f.parent.children[0].children[0].children[0].onclick();
  assert.deepEqual(f.profiles,[123456]);
});
test('URL authorization asks before login, asks separately before write access, and exposes only the returned link', async () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'url_auth',text:'Log in',row:0,column:0}]]},'a',1);
  const root=f.parent.children[0],button=root.children[0].children[0],status=root.children[1];
  const pending=button.onclick();
  assert.equal(f.calls[0].url,'/api/instances/a/account/bot-url-auth');
  f.resolve({type:'request',domain:'login.example',requestWriteAccess:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.confirmations.length,2);
  assert.match(f.confirmations[0],/login\.example/);
  assert.equal(f.calls[1].url,'/api/instances/a/account/bot-url-auth/accept');
  assert.equal(f.calls[1].body.writeAllowed,true);
  f.resolve({type:'accepted',url:'https://login.example/complete'});
  await pending;
  assert.equal(status.children[0].href,'https://login.example/complete');
  assert.equal(status.children[0].rel,'noopener noreferrer');
});
test('peer request picker applies Telegram user constraints and sends only the selected peer', async () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'request_peer',text:'Choose user',row:0,column:0,peerRequest:{kind:'user',maxQuantity:1,bot:false}}]]},'a',1);
  const root=f.parent.children[0],button=root.children[0].children[0],status=root.children[1];
  button.onclick();
  const panel=status.children[0],list=panel.children[3];
  assert.equal(list.children.length,1,'bots are excluded by Telegram request constraints');
  const checkbox=list.children[0].children[0];checkbox.checked=true;checkbox.onchange();
  const send=panel.children[4].children[1];
  const pending=send.onclick();
  assert.equal(f.calls[0].url,'/api/instances/a/account/bot-request-peer');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{chatId:1,messageId:2,row:0,column:0,peerIds:[101]});
  f.resolve({success:true});await pending;
  assert.equal(f.toasts.at(-1),'已向机器人分享所选会话');
});
test('peer picker searches Telegram with the original request button and filters the returned peers', async () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'request_peer',text:'Choose user',row:0,column:0,peerRequest:{kind:'user',maxQuantity:1,bot:false}}]]},'a',1);
  const root=f.parent.children[0];root.children[0].children[0].onclick();
  const panel=root.children[1].children[0],search=panel.children[2];
  search.value='New person';search.oninput();
  assert.equal(f.calls[0].url,'/api/instances/a/account/bot-request-peer-search');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{chatId:1,messageId:2,row:0,column:0,query:'New person'});
  f.resolve([{id:103,type:'private',title:'New person',username:'newperson',isBot:false,isPremium:false}]);
  await new Promise(resolve=>setImmediate(resolve));
  const list=panel.children[3];assert.equal(list.children.length,1);
  const checkbox=list.children[0].children[0];checkbox.checked=true;checkbox.onchange();
  const send=panel.children[4].children[1],pending=send.onclick();
  assert.equal(f.calls[1].url,'/api/instances/a/account/bot-request-peer');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].body)),{chatId:1,messageId:2,row:0,column:0,peerIds:[103]});
  f.resolve({success:true});await pending;
});
test('callback captures account and only displays safe returned link after user action', async () => {
  const f=fixture();
  f.window.BotKeyboard.mount(f.parent,{id:2,botKeyboard:[[{type:'callback',text:'Go',row:0,column:0}]]},'a',1);
  const root=f.parent.children[0], button=root.children[0].children[0], status=root.children[1];
  button.onclick(); button.onclick(); assert.equal(f.calls.length,1);
  f.state.clientSelectedInstance='b'; f.resolve({message:'old',url:'https://example.org'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(status.children.length,0); assert.equal(f.toasts.length,0);
});

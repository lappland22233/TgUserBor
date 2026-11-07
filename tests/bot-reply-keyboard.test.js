'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/js/bot-keyboard.js', 'utf8');
function fixture() {
  function node(tag) { return { tag, children: [], hidden: false, appendChild(x) { this.children.push(x); }, replaceChildren() { this.children = []; }, setAttribute() {} }; }
  const container = node('container');
  const state = {clientSelectedInstance:'a',clientActiveChatId:1,chatSelectionVersion:1,clientSilent:false};
  const calls = [], notices = [], refreshes = [], consents = [], locations = [], pollRequests = [], profiles = [];
  let resolve, reject;
  const forceReplies = [];
  const context = {window:{confirm:message=>{consents.push(message);return true;},openPollCreationForRequest:quiz=>pollRequests.push(quiz),loadPeerProfile:userId=>profiles.push(userId),setReplyingMessage:id=>forceReplies.push(id)},navigator:{geolocation:{getCurrentPosition:(success,error,options)=>{locations.push(options);success({coords:{latitude:51.5,longitude:-0.12}});}}},document:{createElement:node,getElementById:id=>id==='bot-reply-keyboard'?container:null},URL,state,encodeURIComponent,
    api:(url,method,body)=>{calls.push({url,method,body});return new Promise((res,rej)=>{resolve=res;reject=rej;});},
    showToast:message=>notices.push(message),loadClientMessages:async chatId=>{refreshes.push(chatId);}};
  vm.runInNewContext(source,context);
  const keyboard = (id, opts={}) => ({id,chatId:1,replyKeyboard:{type:'keyboard',rows:[[{type:'text',text:'Go'},{type:'unsupported',text:'Phone',reason:'暂不支持分享手机号'}]],...opts}});
  return {...context,container,calls,notices,refreshes,consents,locations,pollRequests,profiles,forceReplies,keyboard,resolve:value=>resolve(value),reject:error=>reject(error)};
}
test('reply keyboards retain the newest active markup across bounded snapshot refreshes',()=>{
  const f=fixture(), bot=f.window.BotKeyboard;
  bot.replaceReplySnapshot([f.keyboard(3),{id:4}], 'a', 1); bot.renderReply();
  assert.equal(f.container.hidden,false);
  assert.equal(f.container.children[1].children[0].textContent,'Go');
  assert.equal(f.container.children[1].children[1].disabled,true);
  bot.replaceReplySnapshot([{id:100}], 'a', 1); bot.renderReply();
  assert.equal(f.container.hidden,false);
  bot.applyReplyEvent({type:'new_message',instId:'a',message:{id:101,chatId:1,replyKeyboard:{type:'hide'}}});
  bot.replaceReplySnapshot([f.keyboard(3),{id:100}], 'a', 1); bot.renderReply();
  assert.equal(f.container.hidden,true);
});
test('a selective keyboard supplied for the current user is rendered and its targeted hide event clears it',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  bot.replaceReplySnapshot([f.keyboard(8,{selective:true})],'a',1);bot.renderReply();
  assert.equal(f.container.hidden,false);
  bot.applyReplyEvent({type:'new_message',instId:'a',message:{id:9,chatId:1,replyKeyboard:{type:'hide',selective:true}}});
  bot.renderReply();
  assert.equal(f.container.hidden,true);
});
test('ForceReply automatically targets the requesting bot message once and single-use is cleared by the reply',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  const force={id:77,chatId:1,replyKeyboard:{type:'force',singleUse:true,placeholder:'Answer'}};
  bot.replaceReplySnapshot([force],'a',1);bot.renderReply();bot.renderReply();
  assert.deepEqual(f.forceReplies.map(message=>message.id),[77]);
  assert.equal(f.container.hidden,true);
  bot.applyReplyEvent({type:'new_message',instId:'a',message:{id:78,chatId:1,replyToMessageId:77,outgoing:true,text:'Answer'}});
  assert.equal(f.container.hidden,true);
  bot.renderReply();
  assert.deepEqual(f.forceReplies.map(message=>message.id),[77]);
});
test('a single-use reply keyboard closes after any later outgoing text',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  bot.replaceReplySnapshot([f.keyboard(70,{singleUse:true})],'a',1);bot.renderReply();
  assert.equal(f.container.hidden,false);
  bot.applyReplyEvent({type:'new_message',instId:'a',message:{id:71,chatId:1,outgoing:true,text:'Done'}});
  assert.equal(f.container.hidden,true);
});
test('ForceReply does not replace a reply target the user already selected',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  f.state.clientReplyingTo={id:66};
  bot.replaceReplySnapshot([{id:77,chatId:1,replyKeyboard:{type:'force',singleUse:false}}],'a',1);bot.renderReply();
  assert.deepEqual(f.forceReplies,[]);
  assert.equal(f.state.clientReplyingTo.id,66);
});
test('restored reply keyboard replaces only older state and clears on a newer server snapshot',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  const old={id:10,chatId:1,replyKeyboard:{type:'keyboard',rows:[[{type:'text',text:'Old'}]]}};
  const newer={id:12,chatId:1,replyKeyboard:{type:'keyboard',rows:[[{type:'text',text:'New'}]]}};
  bot.replaceReplyState({message:old,latestMessageId:10,complete:true},'a',1);
  assert.equal(f.container.children[1].children[0].textContent,'Old');
  bot.applyReplyEvent({type:'new_message',instId:'a',message:newer});
  bot.replaceReplyState({message:old,latestMessageId:11,complete:true},'a',1);
  assert.equal(f.container.children[1].children[0].textContent,'New');
  bot.replaceReplyState({latestMessageId:13,complete:true},'a',1);
  assert.equal(f.container.hidden,true);
});
test('late reply keyboard history does not overwrite a newer keyboard event',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  const epoch=bot.getReplyStateEpoch();
  bot.applyReplyEvent({type:'new_message',instId:'a',message:{id:15,chatId:1,replyKeyboard:{type:'hide'}}});
  bot.replaceReplyState({message:{id:10,chatId:1,replyKeyboard:{type:'keyboard',rows:[[{type:'text',text:'Old'}]]}},latestMessageId:14},'a',1,epoch);
  assert.equal(f.container.hidden,true);
});
test('reply sends literal text to the originating account once and respects single use',async()=>{
  const f=fixture(), bot=f.window.BotKeyboard;
  bot.replaceReplySnapshot([f.keyboard(3,{singleUse:true})], 'a', 1); bot.renderReply();
  const button=f.container.children[1].children[0];
  const pending=button.onclick(); button.onclick();
  assert.equal(f.calls.length,1); assert.match(f.calls[0].url,/instances\/a\/account\/send$/);
  assert.equal(f.calls[0].body.chatId,1); assert.equal(f.calls[0].body.text,'Go'); assert.equal(f.calls[0].body.options.parseMode,'plain');
  f.resolve({success:true}); await pending;
  assert.equal(f.container.children.length,1); assert.equal(f.container.children[0].children[0].textContent,'显示机器人键盘');
});
test('group reply keyboard text replies to the message that supplied the keyboard',async()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  f.state.clientActiveChatId=-100123;
  const message={...f.keyboard(44),chatId:-100123};
  bot.replaceReplySnapshot([message],'a',-100123);bot.renderReply();
  const pending=f.container.children[1].children[0].onclick();
  assert.equal(f.calls[0].body.options.replyTo,44);
  f.resolve({success:true});await pending;
});
test('history, account switch and late sends cannot display or update the wrong conversation',async()=>{
  const f=fixture(), bot=f.window.BotKeyboard;
  bot.replaceReplySnapshot([f.keyboard(3)], 'a', 1); bot.renderReply();
  f.state.clientHistoryOffsetDate=100; bot.renderReply(); assert.equal(f.container.hidden,true);
  f.state.clientHistoryOffsetDate=null; bot.renderReply();
  const pending=f.container.children[1].children[0].onclick();
  f.state.clientSelectedInstance='b'; f.state.clientActiveChatId=2; f.state.chatSelectionVersion++; bot.resetReply();
  f.resolve({success:true}); await pending;
  assert.equal(f.refreshes.length,0); assert.equal(f.notices.length,0);
  bot.applyReplyEvent({type:'new_message',instId:'a',message:f.keyboard(4)});
  bot.renderReply(); assert.equal(f.container.hidden,true);
});
test('a failed reply send keeps the keyboard usable and reports failure',async()=>{
  const f=fixture(), bot=f.window.BotKeyboard;
  bot.replaceReplySnapshot([f.keyboard(3)], 'a', 1); bot.renderReply();
  const button=f.container.children[1].children[0]; const pending=button.onclick();
  f.reject(new Error('offline')); await pending;
  assert.equal(button.disabled,false); assert.match(f.notices[0],/发送未确认/);
});

test('phone reply request requires consent and shares only via the verified bot keyboard',async()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  const phone=f.keyboard(30,{singleUse:true,rows:[[{text:'Share phone',type:'request_phone',row:0,column:2}]]});
  bot.replaceReplySnapshot([phone],'a',1);bot.renderReply();
  const button=f.container.children[1].children[0];
  const pending=button.onclick();
  assert.match(f.consents[0],/电话号码/);
  assert.equal(f.calls[0].url,'/api/instances/a/account/bot-keyboard/phone');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{chatId:1,messageId:30,row:0,column:2});
  f.resolve({success:true});await pending;
  assert.equal(f.container.children.length,1,'single-use sensitive keyboard hides after Telegram accepts the request');
  assert.equal(f.notices[0],'已向机器人分享电话号码');
});

test('location reply sends coordinates only after consent and browser geolocation',async()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  const location=f.keyboard(31,{rows:[[{text:'Share location',type:'request_location',row:1,column:0}]]});
  bot.replaceReplySnapshot([location],'a',1);bot.renderReply();
  const button=f.container.children[1].children[0];
  const pending=button.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.consents[0],/当前位置/);
  assert.equal(f.locations[0].timeout,15000);
  assert.equal(f.calls[0].url,'/api/instances/a/account/bot-keyboard/location');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{chatId:1,messageId:31,row:1,column:0,latitude:51.5,longitude:-0.12});
  f.resolve({success:true});await pending;
  assert.equal(f.notices[0],'已向会话发送当前位置');
});

test('poll request opens the matching poll creator and profile button opens its Telegram user',()=>{
  const f=fixture(),bot=f.window.BotKeyboard;
  const message=f.keyboard(32,{rows:[[
    {text:'Create quiz',type:'request_poll',quiz:true},
    {text:'View profile',type:'user_profile',userId:7654321},
  ]]});
  bot.replaceReplySnapshot([message],'a',1);bot.renderReply();
  const [poll,profile]=f.container.children[1].children;
  poll.onclick(); profile.onclick();
  assert.deepEqual(f.pollRequests,[true]);
  assert.deepEqual(f.profiles,[7654321]);
});

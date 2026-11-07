'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/gui/web/js/forum-topics.js','utf8');
function fixture(){
 const requests=[], albums=[]; const state={clientSelectedInstance:'a',clientActiveChatId:-1001,chatSelectionVersion:1,clientDialogs:[{id:-1001,isForum:true}]};
 class Node{constructor(){this.children=[];this.hidden=false;this.disabled=false;this.value='';this.style={};this._text='';this._dataset={};this.listeners={};}get dataset(){return this._dataset;}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text;}replaceChildren(...v){this.children=v;}appendChild(v){this.children.push(v);return v;}append(...v){this.children.push(...v);}prepend(...v){this.children.unshift(...v);}addEventListener(name,fn){this.listeners[name]=fn;}querySelector(q){return this.parts?.[q];}focus(){}}
 const list=new Node(),title=new Node(),status=new Node(),more=new Node(),back=new Node(),composer=new Node(),input=new Node(),send=new Node(),replyLabel=new Node(),close=new Node();
 const attachButton=new Node(),locationButton=new Node(),fileInput=new Node(),diceChoice=new Node(),diceSend=new Node();diceChoice.value='🎯';
 const document={head:new Node(),body:new Node(),addEventListener(){},getElementById(){return null;},createElement(tag){const n=new Node();if(tag==='div'&&!document.modal){document.modal=n;n.parts={'.forum-list':list,'#forum-title':title,'.forum-status':status,'.forum-more':more,'[data-back]':back,'.forum-compose':composer,'textarea':input,'[data-send]':send,'.forum-reply':replyLabel,'[data-close]':close,'[data-attach]':attachButton,'[data-location]':locationButton,'[data-file]':fileInput,'[data-dice-choice]':diceChoice,'[data-send-dice]':diceSend};}return n;}};
 const diceCalls=[];
 const liveLocationCalls=[];
 const window={addEventListener(){},startClientLiveLocation:(target,topicId)=>liveLocationCalls.push({target,topicId}),stopClientLiveLocation:(...args)=>liveLocationCalls.push(args),sendTelegramDice:(...args)=>new Promise(resolve=>diceCalls.push({args,resolve}))}; const api=(url,method,body)=>new Promise((resolve,reject)=>requests.push({url,method,body,resolve,reject}));
 const sendMediaAlbumStream=(url,files,metadata)=>{albums.push({url,files,metadata});return Promise.resolve({success:true});};
 vm.runInNewContext(source,{window,document,state,api,sendMediaAlbumStream,URLSearchParams,encodeURIComponent,queueMicrotask,MutationObserver:class{observe(){}}});
 return {window,document,state,requests,albums,list,title,status,more,back,input,send,replyLabel,fileInput,attachButton,locationButton,liveLocationCalls,diceCalls,diceChoice,diceSend};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('topic reply uses the original account and rejects stale responses',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'<topic>',iconColor:0x123456}]});await tick();
 const topicButton=f.list.children[0].children[0];assert.equal(topicButton.textContent,'<topic>');assert.equal(topicButton.style.borderLeft,'4px solid #123456');topicButton.onclick();f.requests[1].resolve([{id:90,text:'<img onerror=alert(1)>',from:{firstName:'alice'}}]);await tick();
 assert.equal(f.list.children[0].children[1].textContent,'<img onerror=alert(1)>');
 f.list.children[0].children[2].onclick();f.input.value='reply';const pending=f.send.onclick();
 assert.equal(f.requests[2].body.chatId,-1001);assert.equal(f.requests[2].body.topicId,55);assert.equal(f.requests[2].body.replyTo,90);
 f.state.clientSelectedInstance='b';f.state.chatSelectionVersion++;f.input.value='new account text';f.requests[2].resolve({});await pending;
 assert.equal(f.input.value,'new account text');assert.equal(f.requests.length,3);
});
test('topic history keeps input on failed send',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.list.children[0].children[0].onclick();f.requests[1].resolve([]);await tick();f.input.value='hello';const p=f.send.onclick();f.requests[2].reject(new Error('denied'));await p;
 assert.equal(f.input.value,'hello');assert.match(f.status.textContent,/denied/);assert.equal(f.send.disabled,false);
});
test('forum topic media picker sends selected photos and videos as one topic-scoped album',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.list.children[0].children[0].onclick();f.requests[1].resolve([]);await tick();f.input.value='cover';
 f.fileInput.files=[{name:'one.jpg',type:'image/jpeg',size:10},{name:'two.mp4',type:'video/mp4',size:20}];f.fileInput.onchange();await tick();
 assert.equal(f.albums.length,1);assert.match(f.albums[0].url,/send-media-album$/);assert.equal(f.albums[0].metadata.chatId,-1001);
 assert.equal(f.albums[0].metadata.topicId,55);assert.equal(f.albums[0].metadata.replyTo,55);assert.equal(f.albums[0].metadata.caption,'cover');assert.equal(f.input.value,'');
});
test('forum topic shares live location in the selected thread and can stop its outgoing share',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.list.children[0].children[0].onclick();f.requests[1].resolve([]);await tick();
 f.locationButton.onclick();assert.equal(f.liveLocationCalls[0].topicId,55);
 assert.equal(f.liveLocationCalls[0].target.chatId,-1001);assert.equal(f.liveLocationCalls[0].target.isCurrent(),true);
 f.window.ForumTopics.handleMessage({id:92,chatId:-1001,topicId:55,text:'',outgoing:true,media:{type:'location',liveLocation:true,latitude:37.5,longitude:-122.2}});
 const row=f.list.children.at(-1);const stop=row.children.find(child=>child.textContent==='停止共享实时位置');assert.ok(stop);
 stop.onclick({stopPropagation(){}});assert.equal(f.liveLocationCalls.at(-1)[0], 'a');assert.equal(f.liveLocationCalls.at(-1)[2],92);
});
test('forum topic sends a native dice to its own topic and refreshes that history',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.list.children[0].children[0].onclick();f.requests[1].resolve([]);await tick();
 const pending=f.diceSend.onclick();assert.deepEqual(f.diceCalls[0].args,[-1001,'🎯',55]);
 f.diceCalls[0].resolve(true);await tick();assert.match(f.requests[2].url,/forum-messages/);assert.match(f.requests[2].url,/topicId=55/);
 f.requests[2].resolve([]);await pending;assert.equal(f.diceSend.disabled,false);
});
test('pinned topic updates reload the visible topic list and keep open topic history intact',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.window.ForumTopics.refreshTopics();assert.equal(f.requests.length,2);f.requests[1].resolve({topics:[{id:55,title:'topic'},{id:56,title:'new topic',pinned:true}]});await tick();
 assert.equal(f.list.children.length,2);
 f.list.children[0].children[0].onclick();f.requests[2].resolve([{id:90,text:'message'}]);await tick();
 f.window.ForumTopics.refreshTopics();assert.equal(f.requests.length,3);
});
test('live topic messages append once and advance the topic read boundary',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic',unreadCount:1}]});await tick();
 f.list.children[0].children[0].onclick();f.requests[1].resolve([{id:90,text:'history'}]);await tick();
 f.window.ForumTopics.handleMessage({id:91,chatId:-1001,topicId:55,text:'live',from:{firstName:'alice'},outgoing:false});
 assert.equal(f.list.children.length,2);assert.equal(f.list.children[1].children[1].textContent,'live');
 assert.match(f.requests[2].url,/forum-topic-read/);assert.equal(f.requests[2].body.maxId,90);
 assert.equal(f.requests.length,3);
 f.requests[2].resolve({});await tick();
 assert.equal(f.requests[3].body.maxId,91);
 f.window.ForumTopics.handleMessage({id:91,chatId:-1001,topicId:55,text:'live again',outgoing:false});
 assert.equal(f.list.children.length,2);assert.equal(f.requests.length,4);
 f.requests[3].resolve({});await tick();
});
test('remote topic title and closed state update the open topic view',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.list.children[0].children[0].onclick();f.requests[1].resolve([]);await tick();
 f.window.ForumTopics.handleMessage({id:91,chatId:-1001,topicId:55,text:'topic edit',topicUpdate:{title:'Renamed',iconEmojiId:'9876',closed:true},outgoing:true});
 assert.equal(f.title.textContent,'Renamed');assert.equal(f.title.dataset.topicIconEmojiId,'9876');assert.equal(f.document.modal.parts['.forum-compose'].hidden,true);
});
test('topic history opens at the latest page and scrolls upward through older Telegram pages',async()=>{
 const f=fixture();f.window.ForumTopics.open();f.requests[0].resolve({topics:[{id:55,title:'topic'}]});await tick();
 f.list.children[0].children[0].onclick();
 f.requests[1].resolve(Array.from({length:50},(_,i)=>({id:100-i,text:String(100-i)})));await tick();
 assert.equal(f.list.children.length,50);assert.equal(f.list.children[49].children[1].textContent,'100');
 f.list.scrollTop=0;f.list.listeners.scroll();assert.match(f.requests[2].url,/offsetId=51/);
 f.requests[2].resolve(Array.from({length:50},(_,i)=>({id:50-i,text:String(50-i)})));await tick();
 assert.equal(f.list.children.length,100);assert.equal(f.list.children[0].children[1].textContent,'1');
});

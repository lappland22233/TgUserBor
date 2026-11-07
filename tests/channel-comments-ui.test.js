'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/comments.js'), 'utf8');

function fixture() {
  const requests = [];
  const state = {clientSelectedInstance:'a',clientActiveChatId:1,chatSelectionVersion:1};
  class Node {
    constructor() {this.children=[];this.hidden=false;this.disabled=false;this.value='';this.style={};this._text='';}
    set textContent(text) {this._text=String(text);this.children=[];}
    get textContent() {return this._text;}
    appendChild(child) {this.children.push(child);return child;}
    append(...children) {this.children.push(...children);}
    addEventListener() {}
    querySelector(selector) {return this.parts?.[selector];}
  }
  const list=new Node(),status=new Node(),textarea=new Node(),send=new Node(),more=new Node(),title=new Node(),close=new Node(),fileInput=new Node(),fileName=new Node(),clearFile=new Node(),refresh=new Node();
  const document = {
    head:new Node(),body:new Node(),
    createDocumentFragment:()=>new Node(),
    createElement:tag=>{const node=new Node();if(tag==='div' && !document.modal){document.modal=node;node.parts={'.channel-comments-list':list,'.channel-comments-status':status,'textarea':textarea,'[data-send]':send,'.channel-comments-more':more,'#channel-comments-title':title,'[data-close]':close,'[data-file]':fileInput,'[data-file-name]':fileName,'[data-clear-file]':clearFile,'[data-refresh]':refresh};}return node;},
  };
  const api=(url,method,body)=>new Promise((resolve,reject)=>requests.push({url,method,body,resolve,reject}));
  const uploads=[];
  const sendMediaStream=(url,file,metadata,onProgress)=>new Promise((resolve,reject)=>uploads.push({url,file,metadata,onProgress,resolve,reject}));
  const timers=new Map();let nextTimer=0;
  const setTimeout=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;};
  const clearTimeout=id=>timers.delete(id);
  const runRefresh=()=>{for(const [id,timer] of [...timers]) if(timer.delay===15000){timers.delete(id);timer.fn();}};
  const window={};vm.runInNewContext(source,{window,document,state,api,sendMediaStream,URLSearchParams,encodeURIComponent,Date,setTimeout,clearTimeout});
  return {window,document,state,requests,uploads,list,status,textarea,send,more,close,fileInput,fileName,clearFile,refresh,timers,runRefresh};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('closing or switching threads prevents a late response from showing old comments', async () => {
  const f=fixture();f.window.ChatComments.open(10,1);
  assert.equal(f.requests.length,1);
  f.window.ChatComments.close();
  assert.equal(f.document.modal.hidden,true);
  f.state.clientSelectedInstance='b';f.state.clientActiveChatId=2;f.state.chatSelectionVersion++;
  f.window.ChatComments.open(20,2);
  f.requests[1].resolve([{id:4,text:'new'}]);await tick();
  const before=f.list.children;
  f.requests[0].resolve([{id:3,text:'old'}]);await tick();
  assert.equal(f.list.children,before);
  assert.equal(f.document.modal.hidden,false);
});

test('send preserves newer input and targets the original account and post', async () => {
  const f=fixture();f.window.ChatComments.open(10,1);
  f.requests[0].resolve([]);await tick();
  f.textarea.value='first';const pending=f.send.onclick();
  assert.equal(f.requests[1].method,'POST');
  assert.equal(f.requests[1].body.chatId,1);
  assert.equal(f.requests[1].body.messageId,10);
  f.textarea.value='new draft';
  f.requests[1].resolve({messageId:99});await tick();
  assert.equal(f.textarea.value,'new draft');
  f.requests[2].resolve([]);await pending;
  assert.equal(f.send.disabled,false);
});

test('permission errors remain visible and preserve the comment for retry', async () => {
  const f=fixture();f.window.ChatComments.open(10,1);
  f.requests[0].resolve([]);await tick();
  f.textarea.value='my comment';const pending=f.send.onclick();
  f.requests[1].reject(new Error('当前账号没有在讨论群发送消息的权限'));await pending;
  assert.match(f.status.textContent,/没有在讨论群发送消息的权限/);
  assert.equal(f.textarea.value,'my comment');
  assert.equal(f.send.disabled,false);
});

test('pagination removes overlap and stops if the server repeats a cursor', async () => {
  const f=fixture();f.window.ChatComments.open(10,1);
  const page = (first) => Array.from({length:50},(_,index)=>({id:first-index,text:'message'}));
  f.requests[0].resolve(page(200));await tick();
  assert.equal(f.more.hidden,false);
  f.more.onclick();
  assert.match(f.requests[1].url,/offsetId=151/);
  f.requests[1].resolve(page(151));await tick();
  assert.equal(f.list.children[1].children.length,49);
  f.more.onclick();
  f.requests[2].resolve(Array.from({length:50},()=>({id:102,text:'repeat'})));await tick();
  assert.equal(f.more.hidden,true);
});

test('media comment uses the original channel post and streams the selected file', async () => {
  const f=fixture(); f.window.ChatComments.open(10,1); f.requests[0].resolve([]); await tick();
  const file={name:'photo.png',type:'image/png',size:100};
  f.fileInput.files=[file]; f.fileInput.onchange(); f.textarea.value='caption';
  const pending=f.send.onclick();
  assert.equal(f.uploads.length,1);
  assert.equal(f.uploads[0].file,file);
  assert.equal(f.uploads[0].metadata.chatId,1);
  assert.equal(f.uploads[0].metadata.commentTo,10);
  assert.equal(f.uploads[0].metadata.mediaType,'photo');
  assert.equal(f.uploads[0].metadata.caption,'caption');
  f.uploads[0].onProgress('upload',40);
  assert.match(f.status.textContent,/40%/);
  f.uploads[0].resolve({messageId:99}); await tick();
  assert.equal(f.fileName.textContent,'');
  f.requests[1].resolve([]); await pending;
});

test('a media comment finishing after a chat switch cannot alter the new thread', async () => {
  const f=fixture(); f.window.ChatComments.open(10,1); f.requests[0].resolve([]); await tick();
  f.fileInput.files=[{name:'a.txt',type:'text/plain',size:12}]; f.fileInput.onchange();
  const pending=f.send.onclick();
  f.window.ChatComments.close(); f.state.clientSelectedInstance='b'; f.state.clientActiveChatId=2; f.state.chatSelectionVersion++;
  f.window.ChatComments.open(20,2); f.requests[1].resolve([]); await tick();
  f.textarea.value='new draft'; f.uploads[0].resolve({messageId:99}); await pending;
  assert.equal(f.textarea.value,'new draft');
  assert.equal(f.requests.length,2);
});

test('media failure and size limits preserve the attachment for retry', async () => {
  const f=fixture(); f.window.ChatComments.open(10,1); f.requests[0].resolve([]); await tick();
  const file={name:'file.bin',type:'',size:12}; f.fileInput.files=[file]; f.fileInput.onchange();
  const pending=f.send.onclick(); f.uploads[0].reject(new Error('网络中断')); await pending;
  assert.match(f.status.textContent,/发送未确认/); assert.equal(f.fileName.textContent,'file.bin');
  assert.equal(f.fileInput.disabled,false);
  f.fileInput.files=[{name:'huge.bin',type:'',size:2*1024*1024*1024+1}]; f.fileInput.onchange();
  await f.send.onclick(); assert.match(f.status.textContent,/超过 2 GiB/); assert.equal(f.uploads.length,1);
});

test('selected media can be removed without clearing comment text', async () => {
  const f=fixture(); f.window.ChatComments.open(10,1); f.requests[0].resolve([]); await tick();
  f.textarea.value='draft'; f.fileInput.files=[{name:'a.png',size:3,type:'image/png'}]; f.fileInput.onchange();
  assert.equal(f.clearFile.hidden,false); f.clearFile.onclick();
  assert.equal(f.clearFile.hidden,true); assert.equal(f.fileName.textContent,''); assert.equal(f.textarea.value,'draft');
});

test('open comments refresh periodically and stop after closing', async () => {
  const f=fixture(); f.window.ChatComments.open(10,1); f.requests[0].resolve([]); await tick();
  f.runRefresh(); assert.equal(f.requests.length,2); f.requests[1].resolve([{id:5,text:'new'}]); await tick();
  assert.equal(f.list.children[0].children[0].children[1].textContent,'new');
  f.window.ChatComments.close(); assert.equal(f.timers.size,0);
  f.runRefresh(); assert.equal(f.requests.length,2);
});

test('background comments and older pages are not replaced by polling', async () => {
  const f=fixture(); f.window.ChatComments.open(10,1);
  f.requests[0].resolve(Array.from({length:50},(_,i)=>({id:100-i,text:'message'}))); await tick();
  f.document.hidden=true; f.runRefresh(); assert.equal(f.requests.length,1);
  f.document.hidden=false; f.more.onclick(); f.requests[1].resolve([{id:50,text:'older'}]); await tick();
  f.runRefresh(); assert.equal(f.requests.length,2);
  f.refresh.onclick(); assert.equal(f.requests.length,3); f.requests[2].resolve([]); await tick();
  f.runRefresh(); assert.equal(f.requests.length,4);
  f.window.ChatComments.close(); f.requests[3].resolve([]); await tick();
});

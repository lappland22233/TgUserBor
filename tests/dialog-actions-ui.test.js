'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('src/gui/web/app.js','utf8');
const start=source.indexOf('window.toggleDialogPin =');
const end=source.indexOf('\nasync function selectClientChat(',start);
if(start<0||end<0) throw new Error('Cannot locate dialog actions');
function fixture(){
  const state={clientSelectedInstance:'a',clientActiveChatId:8,chatSelectionVersion:1,clientDialogs:[{id:8,type:'group',archived:true,pinned:false}],clientMessages:[{id:10}]};
  const buttons=Object.fromEntries(['pin','mute','read','archive','delete'].map(action=>[action,{dataset:{action}}]));
  const menu={style:{},querySelectorAll:()=>Object.values(buttons),remove(){},contains(){return false;}};
  const document={getElementById:()=>null,createElement:()=>menu,body:{appendChild(){}},addEventListener(){},removeEventListener(){},querySelector:()=>null};
  const calls=[], notices=[]; let resolve, confirmed=true, reloads=0;
  const context=vm.createContext({state,document,window:{innerWidth:800,innerHeight:600},encodeURIComponent,setTimeout(){},
    confirm:()=>confirmed,showToast:text=>notices.push(text),api:(url,method,body)=>{calls.push({url,method,body});return new Promise(r=>{resolve=r;});},
    loadClientDialogs(){reloads++;},renderClientDialogs(){},updateChatMuteButtonState(){},cancelReplyBanner(){},cancelEditBanner(){},clearStagedAttachment(){},updateClientHistoryBanner(){} });
  vm.runInContext(source.slice(start,end),context);
  function open(){context.window.showDialogContextMenu({clientX:1,clientY:1},8);}
  return {state,context,buttons,calls,notices,open,resolve:()=>resolve({}),setConfirm:v=>confirmed=v,get reloads(){return reloads;}};
}
test('pin and unarchive send the correct dialog routes and explicit state',async()=>{
  const h=fixture();let p=h.context.window.toggleDialogPin(8,true);
  assert.match(h.calls[0].url,/dialog-pin$/);assert.equal(h.calls[0].body.pinned,true);h.resolve();await p;
  h.open();p=h.buttons.archive.onclick({stopPropagation(){}});
  assert.match(h.calls[1].url,/dialog-archive$/);assert.equal(h.calls[1].body.archived,false);h.resolve();await p;
});
test('cancelled or stale dialog menu does not send a destructive action',async()=>{
  const h=fixture();h.open();h.setConfirm(false);await h.buttons.delete.onclick({stopPropagation(){}});assert.equal(h.calls.length,0);
  h.open();h.state.clientSelectedInstance='b';h.state.chatSelectionVersion++;await h.buttons.delete.onclick({stopPropagation(){}});
  assert.equal(h.calls.length,0);assert.match(h.notices.at(-1),/切换/);
});
test('late successful deletion does not clear a new active chat',async()=>{
  const h=fixture();h.open();const p=h.buttons.delete.onclick({stopPropagation(){}});
  assert.match(h.calls[0].url,/dialog-delete$/);assert.equal(h.calls[0].body.chatId,8);
  h.state.clientActiveChatId=9;h.state.chatSelectionVersion++;h.resolve();await p;
  assert.equal(h.state.clientActiveChatId,9);assert.equal(h.state.clientMessages.length,1);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/dialog-folders.js'), 'utf8');
const folder = (overrides = {}) => ({ id: 1, title: '工作', pinnedPeers: [], includePeers: [], excludePeers: [], contacts: false, nonContacts: false, groups: false, broadcasts: false, bots: false, excludeMuted: false, excludeRead: false, excludeArchived: false, ...overrides });
function harness() {
  const state = { clientSelectedInstance:'a', clientDialogFilter:'all', instances:[{config:{id:'a'},status:'ONLINE'},{config:{id:'b'},status:'ONLINE'}] };
  const requests = [];
  const tabs = { querySelectorAll:()=>[], appendChild:()=>{} };
  const document = { querySelector: (q) => q === '.dialogs-tabs' ? tabs : null, createElement: () => ({dataset:{},classList:{toggle(){}},addEventListener(){}}) };
  const context = vm.createContext({ window:{}, document, state, encodeURIComponent, api: () => new Promise((resolve,reject) => requests.push({resolve,reject})), renderClientDialogs(){} });
  vm.runInContext(source, context);
  return {folders:context.window.DialogFolders,state,requests,document};
}
test('folder rules honour explicit peers, categories, excludes, and contacts', () => {
  const h = harness(), f = folder({ contacts:true, groups:true, bots:true, excludeMuted:true, excludeRead:true, excludeArchived:true, includePeers:['5'], excludePeers:['6'] });
  assert.equal(h.folders.matches(f,{id:1,type:'private',isContact:true,unreadCount:1}),true);
  assert.equal(h.folders.matches(f,{id:2,type:'private',isContact:false,unreadCount:1}),false);
  assert.equal(h.folders.matches(f,{id:3,type:'group',muted:true,unreadCount:1}),false);
  assert.equal(h.folders.matches(f,{id:4,type:'group',archived:true,unreadCount:1}),false);
  assert.equal(h.folders.matches(f,{id:5,type:'private',muted:true,unreadCount:0}),true);
  assert.equal(h.folders.matches(f,{id:6,type:'group',unreadCount:1}),false);
  assert.equal(h.folders.matches(f,{id:7,type:'private',isBot:true,unreadCount:1}),true);
});
test('folder explicit peer fetch includes manually included and pinned peers but skips exclusions', async () => {
  const h = harness(), loading = h.folders.load();
  h.requests[0].resolve([folder({ id: 4, includePeers: ['12', '-10056', '34'], pinnedPeers: ['34', '99'], excludePeers: ['34'] })]);
  await loading;
  h.state.clientDialogFilter = 'folder:4';
  assert.deepEqual(Array.from(h.folders.getExplicitPeerIds('folder:4')), [99, 12, -10056]);
  h.state.clientSelectedInstance = 'b';
  assert.deepEqual(Array.from(h.folders.getExplicitPeerIds('folder:4')), []);
});
test('late responses cannot contaminate another account and pinned order is per-folder', async () => {
  const h = harness();
  const a = h.folders.load();
  h.state.clientSelectedInstance = 'b';
  const b = h.folders.load();
  h.requests[1].resolve([folder({id:2,includePeers:['1','2'],pinnedPeers:['2']})]);
  await b;
  h.requests[0].resolve([folder({id:1,includePeers:['3']})]);
  await a;
  assert.deepEqual(Array.from(h.folders.apply('folder:2',[{id:1},{id:2}]),d=>d.id),[2,1]);
  assert.equal(h.folders.apply('folder:1',[{id:3}]).length,0);
});

test('folder order merges archived and main dialogs by date after folder-pinned items', async () => {
  const h = harness();
  const loading = h.folders.load();
  h.requests[0].resolve([folder({id:1, groups:true, pinnedPeers:['2']})]);
  await loading;
  const items = [
    {id:1,type:'group',lastMessageDate:300},
    {id:2,type:'group',lastMessageDate:100},
    {id:3,type:'group',lastMessageDate:400,archived:true},
  ];
  assert.deepEqual(Array.from(h.folders.apply('folder:1', items), d => d.id), [2,3,1]);
});

test('colored folder tags follow Telegram visibility and omit the folder already selected', async () => {
  const h = harness(), toggle = {checked:false,disabled:false};
  h.document.getElementById = id => id === 'dialog-folder-tags-enabled' ? toggle : null;
  const loading = h.folders.load();
  assert.equal(h.requests.length,2);
  h.requests[0].resolve({enabled:true,premium:true});
  h.requests[1].resolve([folder({id:2,color:5,groups:true}),folder({id:3,color:1,includePeers:['7']})]);
  await loading;
  await Promise.resolve();
  assert.deepEqual(Array.from(h.folders.getTags({id:1,type:'group'}),tag=>[tag.id,tag.color]),[[2,5]]);
  h.state.clientDialogFilter='folder:2';
  assert.deepEqual(Array.from(h.folders.getTags({id:1,type:'group'})),[]);
  h.state.clientDialogFilter='all';
  assert.deepEqual(Array.from(h.folders.getTags({id:7,type:'private'}),tag=>tag.id),[3]);
});

test('temporary failure preserves the last successful folder rules', async () => {
  const h = harness();
  const first = h.folders.load();
  h.requests[0].resolve([folder({id:1, groups:true})]);
  await first;
  h.state.clientDialogFilter = 'folder:1';
  const retry = h.folders.load();
  h.requests[1].reject(new Error('offline'));
  await retry;
  assert.equal(h.folders.apply('folder:1', [{id:3,type:'group'}]).length, 1);
  assert.equal(h.state.clientDialogFilter, 'folder:1');
});

test('a folder removed on Telegram resets selection to all chats', async () => {
  const h = harness();
  const first = h.folders.load();
  h.requests[0].resolve([folder({id:1, groups:true})]);
  await first;
  h.state.clientDialogFilter = 'folder:1';
  const refresh = h.folders.load();
  h.requests[1].resolve([]);
  await refresh;
  assert.equal(h.state.clientDialogFilter, 'all');
});

test('folder manager creates a Telegram filter and closes on account switch', async () => {
  class Element {
    constructor(id = '') {
      this.id=id; this.children=[]; this.dataset={}; this.value=''; this.checked=false; this.disabled=false;
      this.textContent=''; this.className=''; this.events={}; this.attributes={}; this.style={}; this.hidden=false;
      const classes=new Set(); this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value),toggle:(value,force)=>force===undefined?(classes.has(value)?classes.delete(value):classes.add(value)):force?classes.add(value):classes.delete(value)};
    }
    addEventListener(name,fn){this.events[name]=fn;}
    remove(){const siblings=this.parentElement?.children;if(siblings){const index=siblings.indexOf(this);if(index>=0)siblings.splice(index,1);}}
    append(...items){this.children.push(...items);}
    appendChild(item){item.parentElement=this;this.children.push(item);}
    prepend(item){this.children.unshift(item);}
    replaceChildren(...items){this.children=[...items];}
    setAttribute(key,value){this.attributes[key]=value;}
    querySelector(selector){
      const match=node=>selector[0]==='.' ? node.className===selector.slice(1) : selector[0]==='#' ? node.id===selector.slice(1) : false;
      const walk=node=>{for(const child of node.children||[]){if(match(child))return child;const found=walk(child);if(found)return found;}return null;};
      return walk(this);
    }
    querySelectorAll(selector){
      if(selector==='[data-folder-flag]') return this.children.flatMap(child=>child.dataset?.folderFlag?[child]:child.querySelectorAll?.(selector)||[]);
      if(selector==='[data-folder-id]') return this.children.filter(child=>child.dataset?.folderId);
      if(selector.startsWith('input[type="checkbox"][data-peer-id]')) {
        const found=[];
        const walk=node=>{for(const child of node.children||[]){if(child.type==='checkbox'&&child.dataset?.peerId)found.push(child);walk(child);}};
        walk(this);
        return found.filter(input=>!selector.endsWith(':checked')||input.checked).filter(input=>!selector.endsWith(':not(:disabled)')||!input.disabled);
      }
      return [];
    }
  }
  const ids=['modal-dialog-folder-manager','dialog-folder-manager-items','dialog-folder-title','dialog-folder-emoticon','dialog-folder-color','dialog-folder-tags-enabled','dialog-folder-invites-list','dialog-folder-share-status','dialog-folder-share-peers','btn-select-dialog-folder-share-peers','btn-create-dialog-folder-invite',
    'btn-delete-dialog-folder','btn-save-dialog-folder','dialog-folder-peer-search','dialog-folder-peer-results','dialog-folder-peer-summary',
    'dialog-folder-invite-url','btn-preview-dialog-folder-invite','dialog-folder-invite-preview','dialog-folder-invite-peers','btn-select-dialog-folder-invite-peers','btn-join-dialog-folder-invite',
    'dialog-folder-manager-status','btn-manage-dialog-folders','btn-close-dialog-folder-manager','btn-cancel-dialog-folder-manager',
    'btn-new-dialog-folder','btn-save-dialog-folder','btn-delete-dialog-folder'];
  const nodes=new Map(ids.map(id=>[id,new Element(id)]));
  const flags=['contacts','nonContacts','groups','broadcasts','bots','excludeMuted','excludeRead','excludeArchived'].map(flag=>{const node=new Element();node.dataset.folderFlag=flag;return node;});
  const modal=nodes.get('modal-dialog-folder-manager'); modal.querySelectorAll=selector=>selector==='[data-folder-flag]'?flags:[];
  modal.append(nodes.get('dialog-folder-title'),nodes.get('dialog-folder-emoticon'));
  const tabs=new Element('tabs');
  const state={clientSelectedInstance:'a',clientDialogFilter:'all',clientDialogs:[],instances:[{config:{id:'a'},status:'ONLINE'}]};
  const requests=[]; let saved,wasShared=false;
  const context=vm.createContext({window:{},state,document:{
    getElementById:id=>nodes.get(id)||null,
    querySelector:selector=>selector==='.dialogs-tabs'?tabs:selector.startsWith('[data-folder-flag="')?flags.find(flag=>selector.includes(flag.dataset.folderFlag)):null,
    createElement:()=>new Element(),
    createTextNode:text=>{const node=new Element();node.textContent=text;return node;},
  },
  api:async(url,method,body)=>{requests.push({url,method,body});if(url.includes('dialog-folder-tags'))return {enabled:false,premium:true};if(url.includes('search-dialogs'))return[{id:-10056,title:'测试群'},{id:-10057,title:'另一个群'}];if(url.includes('dialog-folder-share-peers'))return[{id:'-10056',title:'测试群',type:'group'},{id:'-10057',title:'另一个群',type:'group'}];if(url.endsWith('/dialog-folder-invites/check'))return{title:'团队',alreadyImported:false,peers:[{id:'-10056',title:'测试群',type:'group',alreadyJoined:false}]};if(url.endsWith('/dialog-folder-invites/join'))return{success:true};if(url.includes('dialog-folder-invites')){if(method==='POST'){wasShared=true;saved={...saved,isShared:true,isOwner:true};return{title:'工作',url:'https://t.me/addlist/abcdefgh',peerIds:body.peerIds};}return wasShared?[{title:'工作',url:'https://t.me/addlist/abcdefgh',peerIds:['-10056']}]:[];}if(method==='POST'){saved={...body,id:2};return saved;}if(url.includes('dialog-folders'))return saved?[saved]:[];return[];},
  renderClientDialogs(){},loadClientDialogs(){},showToast(){},confirm:()=>true,encodeURIComponent,
  setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}},prompt:()=>null,
  });
  vm.runInContext(source,context);
  context.window.DialogFolders.openManager();
  assert.equal(modal.classList.contains('active'),true);
  await new Promise(resolve=>setTimeout(resolve,0));
  nodes.get('dialog-folder-title').value='工作';
  nodes.get('dialog-folder-color').value='5';
  nodes.get('btn-save-dialog-folder').events.click();
  assert.equal(requests.some(request=>request.url.endsWith('/dialog-folders')&&request.method==='POST'),false);
  nodes.get('dialog-folder-peer-search').value='群';
  nodes.get('dialog-folder-peer-search').events.input();
  await new Promise(resolve=>setTimeout(resolve,300));
  const findInputs=(node,out=[])=>{if(node.type==='checkbox')out.push(node);for(const child of node.children||[])findInputs(child,out);return out;};
  const includeCheckboxes=findInputs(nodes.get('dialog-folder-peer-results')).filter(input=>input.attributes['aria-label']?.startsWith('包含 '));
  assert.equal(includeCheckboxes.length,2);
  for(const checkbox of includeCheckboxes){checkbox.checked=true;checkbox.onchange();}
  nodes.get('btn-save-dialog-folder').events.click();
  await new Promise(resolve=>setTimeout(resolve,0));
  const save=requests.find(request=>request.method==='POST');
  assert.equal(save.url,'/api/instances/a/account/dialog-folders');
  assert.equal(save.body.title,'工作'); assert.equal(save.body.groups,false); assert.deepEqual(Array.from(save.body.includePeers),['-10056','-10057']); assert.equal(save.body.color,5);
  const tagsToggle=nodes.get('dialog-folder-tags-enabled'); tagsToggle.checked=true;
  tagsToggle.events.change({currentTarget:tagsToggle});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(requests.some(request=>request.url.endsWith('/dialog-folder-tags')&&request.method==='POST'&&request.body.enabled===true));
  assert.deepEqual(Array.from(context.window.DialogFolders.getTags({id:-10056,type:'group'}),tag=>tag.color),[5]);
  const sharePeers=nodes.get('dialog-folder-share-peers').querySelectorAll('input[type="checkbox"][data-peer-id]');
  assert.equal(sharePeers.length,2);
  sharePeers[0].checked=false; sharePeers[0].onchange();
  nodes.get('btn-create-dialog-folder-invite').events.click();
  await new Promise(resolve=>setTimeout(resolve,0));
  const createInvite=requests.find(request=>request.url.endsWith('/dialog-folder-invites')&&request.method==='POST');
  assert.ok(createInvite);
  assert.deepEqual(Array.from(createInvite.body.peerIds),['-10057']);
  assert.equal(nodes.get('dialog-folder-invites-list').children.length,1);
  nodes.get('dialog-folder-invite-url').value='https://t.me/addlist/abcdefgh';
  nodes.get('btn-preview-dialog-folder-invite').events.click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(nodes.get('dialog-folder-invite-peers').children.length,1);
  assert.equal(nodes.get('btn-join-dialog-folder-invite').disabled,false);
  nodes.get('btn-join-dialog-folder-invite').events.click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(requests.some(request=>request.url.endsWith('/dialog-folder-invites/join')&&request.body.peerIds[0]==='-10056'));
  assert.match(nodes.get('dialog-folder-manager-status').textContent,/已加入/);
  state.clientSelectedInstance='b';
  await context.window.DialogFolders.load();
  assert.equal(modal.classList.contains('active'),false);
});

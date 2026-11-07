'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
function part(start, end) { const a=src.indexOf(start), b=src.indexOf(end,a); if(a<0||b<0) throw Error('Missing '+start); return src.slice(a,b); }
function fixture() {
  const state = {clientSelectedInstance:'a',clientStickerPacks:null,clientGifs:null};
  const ids=['stickers-stream-container','stickers-bottom-switcher','gifs-stream-container','modal-sticker-pack','client-expression-drawer'];
  const nodes = Object.fromEntries(ids.map(id=>[id,{innerHTML:'',style:{}}]));
  nodes['client-expression-drawer'].classList = { contains: () => true };
  const requests=[], renders=[];
  const context=vm.createContext({state,document:{getElementById:id=>nodes[id]||null},
    api:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),
    renderStickerStream:()=>renders.push('stickers'),renderGifStream:()=>renders.push('gifs'),
    console:{warn(){}}, encodeURIComponent});
  vm.runInContext('let emojiKeywordSearchRequest = 0; let emojiKeywordSearchTimer; let emojiCatalogRequest = 0; let emojiCatalogInstance = ""; let emojiCatalogGroups = [];\n'+part('let expressionAccountEpoch = 0;', '\nfunction renderStickerStream()')+'\n'+
    part('async function loadClientGifs()', '\nfunction renderGifStream()')+
    '\nthis.stickers=loadClientStickers;this.gifs=loadClientGifs;this.reset=resetClientExpressions;this.reload=reloadClientExpressionsIfOpen;',context);
  return {context,state,nodes,requests,renders};
}
test('late sticker details cannot replace the newly selected account', async () => {
  const h=fixture(); const old=h.context.stickers();
  h.requests[0].resolve([{id:1,accessHash:'a'}]); h.requests[1].resolve({favorites:[],recent:[]}); await new Promise(resolve => setImmediate(resolve));
  h.context.reset(); h.state.clientSelectedInstance='b'; const current=h.context.stickers();
  h.requests[3].resolve([{id:2,accessHash:'b'}]); h.requests[4].resolve({favorites:[],recent:[]}); await new Promise(resolve => setImmediate(resolve));
  h.requests[5].resolve({set:{id:2},stickers:[{}]}); await current;
  h.requests[2].resolve({set:{id:1},stickers:[{}]}); await old;
  assert.equal(h.state.clientStickerPacks[0].set.id,2);
  assert.deepEqual(h.renders,['stickers']);
});
test('late GIFs cannot return after switching away and back to the same account', async () => {
  const h=fixture(); const old=h.context.gifs();
  h.context.reset(); h.state.clientSelectedInstance='b';
  h.context.reset(); h.state.clientSelectedInstance='a'; const current=h.context.gifs();
  h.requests[1].resolve([{id:'new'}]); await current;
  h.requests[0].resolve([{id:'old'}]); await old;
  assert.equal(h.state.clientGifs[0].id,'new');
  assert.deepEqual(h.renders,['gifs']);
});
test('account reset clears old visible expressions and closes pack details', () => {
  const h=fixture(); h.state.clientStickerPacks=[1]; h.state.clientStickerCollections={favorites:[1]}; h.state.clientGifs=[1];
  h.nodes['stickers-stream-container'].innerHTML='old'; h.nodes['gifs-stream-container'].innerHTML='old';
  h.nodes['modal-sticker-pack'].style.display='flex'; h.context.reset();
  assert.equal(h.state.clientStickerPacks,null); assert.equal(h.state.clientGifs,null);
  assert.equal(h.state.clientStickerCollections,null);
  assert.equal(h.nodes['stickers-stream-container'].innerHTML,'');
  assert.equal(h.nodes['gifs-stream-container'].innerHTML,'');
  assert.equal(h.nodes['modal-sticker-pack'].style.display,'none');
});
test('an open expression drawer reloads the selected account after switching', async () => {
  const h=fixture();
  h.state.clientStickerPacks=[{set:{id:1}}];
  h.state.clientActiveExprTab='gifs';
  h.context.reset();
  h.state.clientSelectedInstance='b';
  h.context.reload();
  assert.match(h.requests[0].url, /instances\/b\/account\/gifs/);
  h.requests[0].resolve([{id:'new'}]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.clientGifs[0].id,'new');
});

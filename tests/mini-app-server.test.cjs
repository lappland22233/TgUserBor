'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { MiniAppSessions, isSafeMiniAppUrl } = require('../dist/bot/driver/mini-app-session');
const { handleApiRoute } = require('../dist/gui/api');

function fixture() {
  const bot = new Api.User({id:bigInt(21), bot:true, accessHash:bigInt(1)});
  const button = new Api.KeyboardButtonWebView({text:'open',url:'https://bot.example/app'});
  const markup = new Api.ReplyInlineMarkup({rows:[new Api.KeyboardButtonRow({buttons:[button]})]});
  const messages = [{id:5, replyMarkup:markup, getSender:async()=>bot}];
  const calls = [];
  let renew = true;
  let canSend = false;
  let paymentStatus = 'paid';
  const invoice = new Api.InputInvoiceSlug({ slug: 'abc-123' });
  const starsInvoice = new Api.Invoice({ currency: 'XTR', prices: [new Api.LabeledPrice({ label: 'Order', amount: bigInt(25) })] });
  const paymentForm = new Api.payments.PaymentFormStars({ formId: bigInt(77), botId: bigInt(21), title: 'Example order',
    description: 'Test description', invoice: starsInvoice, users: [bot] });
  const client = {
    getInputEntity:async value => value instanceof Api.User
      ? new Api.InputPeerUser({ userId: value.id, accessHash: value.accessHash })
      : Number.isSafeInteger(value) ? new Api.InputPeerUser({ userId: bigInt(value), accessHash: bigInt(1) })
      : value,
    getEntity:async()=>bot,
    getMessages:async()=>messages,
    getMe:async()=>new Api.User({id:bigInt(99),firstName:'Alice',lastName:'Owner',phone:'+15551234567',accessHash:bigInt(2)}),
    invoke:async req => {
      calls.push(req);
      if (req instanceof Api.messages.RequestWebView) return new Api.WebViewResultUrl({url:'https://bot.example/app?tgWebAppData=secret',queryId:bigInt(42)});
      if (req instanceof Api.bots.GetBotMenuButton) return new Api.BotMenuButton({text:'Open shop',url:'https://bot.example/shop'});
      if (req instanceof Api.payments.GetPaymentForm) return paymentForm;
      if (req instanceof Api.payments.SendStarsForm) return paymentStatus === 'paid'
        ? Object.create(Api.payments.PaymentResult.prototype)
        : Object.create(Api.payments.PaymentVerificationNeeded.prototype);
      if (req instanceof Api.messages.ProlongWebView) return renew;
      if (req instanceof Api.bots.InvokeWebViewCustomMethod) return new Api.DataJSON({data:'{"keys":["theme"]}'});
      if (req instanceof Api.bots.CanSendMessage) return canSend;
      if (req instanceof Api.bots.CheckDownloadFileParams) return true;
      if (req instanceof Api.bots.AllowSendMessage) { canSend = true; return true; }
      if (req instanceof Api.contacts.Unblock) return true;
      if (req instanceof Api.messages.SendMedia && req.media instanceof Api.InputMediaContact) return true;
      throw new Error('unexpected');
    },
  };
  return {sessions:new MiniAppSessions(client, 99), client, calls, messages, invoice, paymentForm,
    setRenew:v=>renew=v, canSend:()=>canSend, setPaymentStatus:v=>paymentStatus=v};
}
test('bot menu Mini Apps are queried from Telegram and opened with the fromBotMenu flag', async()=>{
  const f=fixture();
  assert.deepEqual(await f.sessions.getBotMenuButton(21), {available:true,text:'Open shop'});
  const menuRequest=f.calls.find(call=>call instanceof Api.bots.GetBotMenuButton);
  assert.equal(menuRequest.userId.userId.toString(),'21');
  const opened=await f.sessions.openBotMenu(21);
  const request=f.calls.find(call=>call instanceof Api.messages.RequestWebView);
  assert.equal(request.fromBotMenu,true);
  assert.equal(request.url,'https://bot.example/shop');
  assert.equal(request.peer.className,'InputPeerUser');
  assert.equal(opened.buttonText,'Open shop');
  assert.equal(opened.botId,'21');
  f.sessions.close(opened.capability);
});

test('only a real bot button creates a worker-local bounded capability', async()=>{
  const f=fixture();
  const result=await f.sessions.open(10,5,0,0);
  assert.match(result.capability,/^[\w-]{43}$/);
  assert.equal(result.botId, '21');
  assert.equal(result.accountId, '99');
  assert.ok(f.calls[0] instanceof Api.messages.RequestWebView);
  assert.equal(f.calls[0].url,'https://bot.example/app');
  await f.sessions.prolong(result.capability);
  assert.ok(f.calls[1] instanceof Api.messages.ProlongWebView);
  f.sessions.close(result.capability);
  await assert.rejects(f.sessions.prolong(result.capability),/过期/);
});
test('simple Web Apps use Telegram simple webview and send data only to their verified bot',async()=>{
  const f=fixture();
  f.messages[0].replyMarkup.rows[0].buttons[0]=new Api.KeyboardButtonSimpleWebView({text:'快速购买',url:'https://bot.example/quick'});
  f.client.invoke=async request=>{
    f.calls.push(request);
    if(request instanceof Api.messages.RequestSimpleWebView) return new Api.WebViewResultUrl({url:'https://bot.example/quick'});
    if(request instanceof Api.messages.SendWebViewData) return {};
    throw new Error('unexpected');
  };
  const opened=await f.sessions.open(10,5,0,0);
  assert.equal(opened.simpleWebView,true);assert.equal(opened.buttonText,'快速购买');
  assert.ok(f.calls[0] instanceof Api.messages.RequestSimpleWebView);
  await f.sessions.sendWebViewData(opened.capability,'order:42');
  const sent=f.calls[1];
  assert.ok(sent instanceof Api.messages.SendWebViewData);
  assert.equal(sent.bot.userId.toString(),'21');assert.equal(sent.buttonText,'快速购买');assert.equal(sent.data,'order:42');
  await assert.rejects(f.sessions.prolong(opened.capability),/不支持续期/);
  f.sessions.close(opened.capability);
  await assert.rejects(f.sessions.sendWebViewData(opened.capability,'late'),/invalid/);
});
test('rejects untrusted message types, local URLs and false renewals', async()=>{
  const f=fixture();
  f.messages[0].replyMarkup.rows[0].buttons[0] = new Api.KeyboardButtonUrl({text:'x',url:'https://evil.test'});
  await assert.rejects(f.sessions.open(10,5,0,0),/按钮不可用/);
  assert.equal(f.calls.length,0);
  for (const value of ['javascript:alert(1)','http://example.com','https://127.0.0.1','https://localhost','https://[::1]','https://u:p@example.com']) assert.equal(isSafeMiniAppUrl(value),false);
  const g=fixture(); const opened=await g.sessions.open(10,5,0,0); g.setRenew(false);
  await assert.rejects(g.sessions.prolong(opened.capability),/已结束/);
  await assert.rejects(g.sessions.prolong(opened.capability),/过期/);
});
test('result sent and driver stop invalidate capabilities', async()=>{
  const f=fixture(); const one=await f.sessions.open(10,5,0,0);
  f.sessions.closeQuery(bigInt(42));
  await assert.rejects(f.sessions.prolong(one.capability),/过期/);
  const two=await f.sessions.open(10,5,0,0); f.sessions.closeAll();
  await assert.rejects(f.sessions.prolong(two.capability),/过期/);
});

test('Mini App openInvoice shows only a bot-bound Stars form and consumes its confirmation once', async()=>{
  const f=fixture(); const opened=await f.sessions.open(10,5,0,0);
  const prepared=await f.sessions.prepareInvoice(opened.capability,'abc-123');
  assert.equal(prepared.stars,'25');
  assert.equal(prepared.title,'Example order');
  assert.equal(prepared.description,'Test description');
  assert.match(prepared.token,/^[A-Za-z0-9_-]{32}$/);
  const get=f.calls.find(call=>call instanceof Api.payments.GetPaymentForm);
  assert.ok(get.invoice instanceof Api.InputInvoiceSlug);
  assert.equal(get.invoice.slug,'abc-123');
  assert.equal(f.calls.some(call=>call instanceof Api.payments.SendStarsForm),false);
  assert.deepEqual(await f.sessions.confirmInvoice(opened.capability,prepared.token),{status:'paid'});
  const send=f.calls.find(call=>call instanceof Api.payments.SendStarsForm);
  assert.equal(send.formId.toString(),'77');
  assert.ok(send.invoice instanceof Api.InputInvoiceSlug);
  await assert.rejects(f.sessions.confirmInvoice(opened.capability,prepared.token),/expired/);
  f.sessions.close(opened.capability);
});

test('Mini App invoice confirmation is canceled, one-use, and bound to the verified bot and XTR', async()=>{
  const f=fixture(); const opened=await f.sessions.open(10,5,0,0);
  f.setPaymentStatus('verification');
  const prepared=await f.sessions.prepareInvoice(opened.capability,'abc-123');
  assert.deepEqual(await f.sessions.confirmInvoice(opened.capability,prepared.token),{status:'failed'});
  const callsAfterConfirm=f.calls.length;
  await assert.rejects(f.sessions.confirmInvoice(opened.capability,prepared.token),/expired/);
  assert.equal(f.calls.length,callsAfterConfirm);
  const canceled=await f.sessions.prepareInvoice(opened.capability,'abc-123');
  f.sessions.cancelInvoice(opened.capability,canceled.token);
  await assert.rejects(f.sessions.confirmInvoice(opened.capability,canceled.token),/expired/);
  await assert.rejects(f.sessions.prepareInvoice(opened.capability,'https://evil.example'),/invalid/);
  f.paymentForm.botId=bigInt(22);
  await assert.rejects(f.sessions.prepareInvoice(opened.capability,'abc-123'),/cannot be paid/);
  f.paymentForm.botId=bigInt(21); f.paymentForm.invoice.currency='USD';
  await assert.rejects(f.sessions.prepareInvoice(opened.capability,'abc-123'),/cannot be paid/);
  f.sessions.close(opened.capability);
});

test('bot menu API exposes only menu state and opens from the Telegram checked peer', async t => {
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{
    calls.push({action,payload});
    return action==='get_mini_app_menu_button' ? {available:true,text:'Shop'} : {capability:'A'.repeat(43),url:'https://bot.example/app',botId:'21',accountId:'99',simpleWebView:false,buttonText:'Shop'};
  }}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/menu`;
  assert.equal((await fetch(`${url}?chatId=0`)).status,400);
  const metadata=await fetch(`${url}?chatId=21`);
  assert.equal(metadata.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await metadata.json(),{available:true,text:'Shop'});
  const opened=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:21})});
  assert.equal(opened.status,200);
  assert.equal((await opened.json()).buttonText,'Shop');
  assert.deepEqual(calls,[
    {action:'get_mini_app_menu_button',payload:{chatId:21}},
    {action:'open_mini_app_menu',payload:{chatId:21}},
  ]);
});

test('custom methods are bounded, sent to the session bot, and discarded after close', async()=>{
  const f=fixture(); const opened=await f.sessions.open(10,5,0,0);
  assert.equal(await f.sessions.invokeCustomMethod(opened.capability,'getStorage','{"keys":["theme"]}'),'{"keys":["theme"]}');
  const custom=f.calls.at(-1);
  assert.ok(custom instanceof Api.bots.InvokeWebViewCustomMethod);
  assert.equal(custom.customMethod,'getStorage');
  assert.equal(custom.params.data,'{"keys":["theme"]}');
  await assert.rejects(f.sessions.invokeCustomMethod(opened.capability,'bad method','{}'),/invalid/);
  await assert.rejects(f.sessions.invokeCustomMethod(opened.capability,'getStorage','not-json'),/parameters/);
  await assert.rejects(f.sessions.invokeCustomMethod(opened.capability,'getStorage',JSON.stringify('x'.repeat(4097))),/invalid/);

  let finish;
  f.client.invoke=async req=>req instanceof Api.bots.InvokeWebViewCustomMethod
    ? new Promise(resolve=>{finish=resolve;})
    : req instanceof Api.messages.ProlongWebView ? true
    : new Api.WebViewResultUrl({url:'https://bot.example/app',queryId:bigInt(99)});
  const second=await f.sessions.open(10,5,0,0);
  const pending=f.sessions.invokeCustomMethod(second.capability,'slow','{}');
  f.sessions.close(second.capability);
  finish(new Api.DataJSON({data:'{}'}));
  await assert.rejects(pending,/ended/);
});

test('bot message access is checked and granted only through the active Mini App capability', async()=>{
  const f=fixture(), opened=await f.sessions.open(10,5,0,0);
  assert.equal(await f.sessions.canBotSendMessages(opened.capability),false);
  await f.sessions.allowBotSendMessages(opened.capability);
  assert.equal(f.canSend(),true);
  assert.equal(await f.sessions.canBotSendMessages(opened.capability),true);
  assert.ok(f.calls.some(call=>call instanceof Api.bots.CanSendMessage));
  assert.ok(f.calls.some(call=>call instanceof Api.bots.AllowSendMessage));
  f.sessions.close(opened.capability);
  await assert.rejects(f.sessions.allowBotSendMessages(opened.capability),/过期/);
});

test('Mini App file downloads are checked by Telegram for the verified bot', async()=>{
  const f=fixture(), opened=await f.sessions.open(10,5,0,0);
  assert.equal(await f.sessions.checkDownloadFile(opened.capability,'guide.pdf','https://bot.example/guide.pdf'),true);
  const check=f.calls.find(call=>call instanceof Api.bots.CheckDownloadFileParams);
  assert.ok(check);
  assert.equal(check.bot.userId.toString(),'21');
  assert.equal(check.fileName,'guide.pdf');
  assert.equal(check.url,'https://bot.example/guide.pdf');
  await assert.rejects(f.sessions.checkDownloadFile(opened.capability,'../secret.pdf','https://bot.example/a'),/invalid/);
  await assert.rejects(f.sessions.checkDownloadFile(opened.capability,'file.pdf','http://bot.example/a'),/invalid/);
  f.sessions.close(opened.capability);
  await assert.rejects(f.sessions.checkDownloadFile(opened.capability,'guide.pdf','https://bot.example/a'),/ended/);
});

test('sharing a phone sends the current account contact only to the verified bot',async()=>{
  const f=fixture(), opened=await f.sessions.open(10,5,0,0);
  await f.sessions.requestPhone(opened.capability);
  const unblock=f.calls.find(call=>call instanceof Api.contacts.Unblock);
  const send=f.calls.find(call=>call instanceof Api.messages.SendMedia && call.media instanceof Api.InputMediaContact);
  assert.ok(unblock);
  assert.equal(unblock.id.userId.toString(),'21');
  assert.ok(send);
  assert.equal(send.peer.userId.toString(),'21');
  assert.deepEqual({phone:send.media.phoneNumber,first:send.media.firstName,last:send.media.lastName},
    {phone:'+15551234567',first:'Alice',last:'Owner'});
  f.sessions.close(opened.capability);
  await assert.rejects(f.sessions.requestPhone(opened.capability),/过期/);
});

test('Mini App custom-method HTTP route validates capability and payload before forwarding',async t=>{
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{calls.push({action,payload});return {result:'{"ok":true}'};}}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/method`;
  const key='A'.repeat(43);
  const send=(capability,body)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-mini-app-key':capability},body:JSON.stringify(body)});
  let response=await send('short',{method:'getStorage',paramsJson:'{}'});
  assert.equal(response.status,403);
  response=await send(key,{method:'bad method',paramsJson:'{}'});
  assert.equal(response.status,400);
  response=await send(key,{method:'getStorage',paramsJson:'not json'});
  assert.equal(response.status,400);
  response=await send(key,{method:'getStorage',paramsJson:JSON.stringify('x'.repeat(5000))});
  assert.equal(response.status,400);
  response=await send(key,{method:'getStorage',paramsJson:JSON.stringify('x'.repeat(9000))});
  assert.equal(response.status,413);
  assert.equal(calls.length,0);
  response=await send(key,{method:'getStorage',paramsJson:'{"keys":["theme"]}'});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await response.json(),{result:'{"ok":true}'});
  assert.deepEqual(calls,[{action:'invoke_mini_app_custom_method',payload:{capability:key,method:'getStorage',paramsJson:'{"keys":["theme"]}'}}]);
});

test('Mini App data send route validates the capability and the 4096-byte Telegram limit',async t=>{
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{calls.push({action,payload});return {};}}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/send-data`;
  const key='E'.repeat(43);
  const send=(capability,data)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-mini-app-key':capability},body:JSON.stringify({data})});
  let response=await send('short','order:42');
  assert.equal(response.status,403);
  response=await send(key,'x'.repeat(4097));
  assert.equal(response.status,400);
  response=await send(key,'order:42');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(calls,[{action:'send_mini_app_data',payload:{capability:key,data:'order:42'}}]);
});

test('Mini App write-access routes require a capability and expose only permission status',async t=>{
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{calls.push({action,payload});return action==='mini_app_can_send_messages'?{allowed:false}:{};}}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/write-access`;
  const key='B'.repeat(43);
  let response=await fetch(url,{headers:{'x-mini-app-key':'short'}});
  assert.equal(response.status,403);
  response=await fetch(url,{headers:{'x-mini-app-key':key}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await response.json(),{allowed:false});
  response=await fetch(url,{method:'POST',headers:{'x-mini-app-key':key}});
  assert.equal(response.status,200);
  assert.deepEqual(calls,[
    {action:'mini_app_can_send_messages',payload:{capability:key}},
    {action:'mini_app_allow_send_messages',payload:{capability:key}},
  ]);
});

test('Mini App phone route accepts only a live session capability',async t=>{
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{calls.push({action,payload});return {};}}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/phone`;
  const key='C'.repeat(43);
  let response=await fetch(url,{method:'POST',headers:{'x-mini-app-key':'short'}});
  assert.equal(response.status,403);
  response=await fetch(url,{method:'POST',headers:{'x-mini-app-key':key}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(calls,[{action:'mini_app_request_phone',payload:{capability:key}}]);
});

test('Mini App invoice routes validate capability and slug, return a safe Stars summary, and whitelist payment status',async t=>{
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{
    calls.push({action,payload});
    if(action==='mini_app_prepare_invoice') return {token:'T'.repeat(32),stars:'25',title:'Order',description:'One item'};
    if(action==='mini_app_confirm_invoice') return {status:'paid',url:'https://secret.example/private'};
    return {};
  }}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/invoice`;
  const key='F'.repeat(43), token='G'.repeat(32);
  const send=(route,capability,body)=>fetch(`${base}/${route}`,{method:'POST',headers:{'content-type':'application/json','x-mini-app-key':capability},body:JSON.stringify(body)});
  let response=await send('prepare','short',{slug:'abc'});
  assert.equal(response.status,403);
  response=await send('prepare',key,{slug:'https://evil.example'});
  assert.equal(response.status,400);
  response=await send('prepare',key,{slug:'abc-123'});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await response.json(),{token:'T'.repeat(32),stars:'25',title:'Order',description:'One item'});
  response=await send('confirm',key,{token});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'paid'});
  response=await send('cancel',key,{token});
  assert.equal(response.status,200);
  assert.deepEqual(calls,[
    {action:'mini_app_prepare_invoice',payload:{capability:key,slug:'abc-123'}},
    {action:'mini_app_confirm_invoice',payload:{capability:key,token}},
    {action:'mini_app_cancel_invoice',payload:{capability:key,token}},
  ]);
});

test('Mini App download check route validates filename and returns only Telegram permission status',async t=>{
  const calls=[];
  const manager={getInstance:id=>id==='a'?{accountAction:async(action,payload)=>{calls.push({action,payload});return {allowed:true};}}:undefined};
  const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(()=>{if(!res.headersSent){res.statusCode=500;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/instances/a/account/mini-app/download-check`;
  const key='D'.repeat(43);
  const send=(capability,body)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-mini-app-key':capability},body:JSON.stringify(body)});
  let response=await send('short',{fileName:'manual.pdf',url:'https://bot.example/manual.pdf'});
  assert.equal(response.status,403);
  response=await send(key,{fileName:'../private.pdf',url:'https://bot.example/manual.pdf'});
  assert.equal(response.status,400);
  response=await send(key,{fileName:'manual.pdf',url:'https://bot.example/manual.pdf'});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await response.json(),{allowed:true});
  assert.deepEqual(calls,[{action:'mini_app_check_download',payload:{capability:key,fileName:'manual.pdf',url:'https://bot.example/manual.pdf'}}]);
});

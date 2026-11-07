'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const bigInt=require('big-integer');
const {Api}=require('telegram');
const {sendMessage}=require('telegram/client/messages');
const {TelegramDriver}=require('../dist/bot/driver/telegram');
const {handleApiRoute}=require('../dist/gui/api');
const http=require('node:http');

function fixture(){
 const peer=new Api.InputPeerChannel({channelId:bigInt(1234567890),accessHash:bigInt(1)}), calls=[];
 const topic=new Api.ForumTopic({id:55,date:10,title:'Topic',iconColor:0x123456,iconEmojiId:bigInt(9876),topMessage:90,readInboxMaxId:0,readOutboxMaxId:0,unreadCount:2,unreadMentionsCount:0,unreadReactionsCount:0,fromId:new Api.PeerUser({userId:bigInt(1)}),notifySettings:new Api.PeerNotifySettings({})});
 const msg=new Api.Message({id:90,peerId:new Api.PeerChannel({channelId:bigInt(1234567890)}),date:20,message:'hello',replyTo:new Api.MessageReplyHeader({forumTopic:true,replyToTopId:55,replyToMsgId:55})});
 const client={getInputEntity:async()=>peer,invoke:async request=>{calls.push(request);return request.className==='channels.GetForumTopics'?{topics:[topic],messages:[msg]}:{};},getMessages:async(p,options)=>{calls.push({peer:p,options});return [msg];},buildReplyMarkup:()=>undefined,_getResponseMessage:()=>({id:99})};
 client.sendMessage=(p,opts)=>sendMessage(client,p,opts);
 client.sendFile=async(p,opts)=>{calls.push({kind:'sendFile',peer:p,options:opts});return {id:101};};
 const driver=Object.create(TelegramDriver.prototype);driver.client=client;driver.mapMessage=async m=>({id:m.id,text:m.message});
 return {driver,calls};
}
test('topic list and history request the intended channel and topic',async()=>{
 const {driver,calls}=fixture(); const list=await driver.getForumTopics(-1001234567890);
 assert.equal(calls[0].className,'channels.GetForumTopics'); assert.equal(list.topics[0].id,55); assert.equal(list.topics[0].unreadCount,2);
 assert.equal(list.topics[0].iconColor,0x123456); assert.equal(list.topics[0].iconEmojiId,'9876');
 assert.deepEqual(await driver.getForumMessages(-1001234567890,55,77),[{id:90,text:'hello'}]);
 assert.equal(calls[1].options.replyTo,55); assert.equal(calls[1].options.offsetId,77);
});
test('topic read acknowledgement is scoped to the topic root and latest visible message',async()=>{
 const {driver,calls}=fixture();
 await driver.markForumTopicAsRead(-1001234567890,55,90);
 assert.equal(calls[0].className,'messages.ReadDiscussion');
 assert.equal(String(calls[0].peer),'-1001234567890');
 assert.equal(calls[0].msgId,55); assert.equal(calls[0].readMaxId,90);
 await assert.rejects(driver.markForumTopicAsRead(-1001234567890,0,90),/Invalid forum topic read boundary/);
});
test('topic send targets the correct root and validates a reply is in that topic',async()=>{
 const {driver,calls}=fixture(); await driver.sendForumMessage(-1001234567890,55,'reply',90);
 const request=calls.find(x=>x.className==='messages.SendMessage');
 assert.equal(request.replyTo.replyToMsgId,90); assert.equal(request.replyTo.topMsgId,55); assert.equal(request.message,'reply');
 await assert.rejects(driver.sendForumMessage(-1001234567890,56,'bad',90),/不属于当前话题/);
});
test('saved GIFs sent in a topic retain the root and reject replies from another topic',async()=>{
 const {driver,calls}=fixture();
 await driver.sendGifDocument(-1001234567890,'77','88','AQ==',90,55);
 const sent=calls.find(call=>call.kind==='sendFile');
 assert.equal(sent.options.replyTo,90);assert.equal(sent.options.topMsgId,55);
 await assert.rejects(driver.sendGifDocument(-1001234567890,'77','88','AQ==',90,56),/不属于当前话题/);
 assert.equal(calls.filter(call=>call.kind==='sendFile').length,1);
});
test('topic pagination uses the last raw topic and its top-message date',async()=>{
 const {driver,calls}=fixture();
 driver.client.invoke=async request=>{
   calls.push(request);
   const topics=Array.from({length:50},(_,i)=>new Api.ForumTopic({id:i+2,date:i+10,title:`Topic ${i}`,iconColor:0,topMessage:i+100,readInboxMaxId:0,readOutboxMaxId:0,unreadCount:0,unreadMentionsCount:0,unreadReactionsCount:0,fromId:new Api.PeerUser({userId:bigInt(1)}),notifySettings:new Api.PeerNotifySettings({})}));
   return {topics,messages:[new Api.Message({id:149,peerId:new Api.PeerChannel({channelId:bigInt(1234567890)}),date:500,message:'last'})]};
 };
 const first=await driver.getForumTopics(-1001234567890);
 assert.deepEqual(first.nextCursor,{date:500,messageId:149,topicId:51});
 await driver.getForumTopics(-1001234567890,first.nextCursor);
 assert.equal(calls[1].offsetDate,500);assert.equal(calls[1].offsetId,149);assert.equal(calls[1].offsetTopic,51);
});
test('pinned topic moves read every forum page and reorder the complete pinned sequence',async()=>{
 const {driver,calls}=fixture(); const offsets=[];
 const topic=(id,pinned=true)=>({id,title:`Topic ${id}`,pinned,closed:false,hidden:false,topMessage:id+10,date:id});
 driver.getForumTopics=async(_chatId,offset)=>{
   offsets.push(offset||null);
   if (!offset) return {topics:[topic(55),topic(56)],nextCursor:{date:30,messageId:40,topicId:60},incomplete:false};
   return {topics:[topic(57)],incomplete:false};
 };
 await driver.movePinnedForumTopic(-1001234567890,56,'down');
 assert.deepEqual(offsets,[null,{date:30,messageId:40,topicId:60}]);
 const request=calls.find(item=>item.className==='channels.ReorderPinnedForumTopics');
 assert.deepEqual(request.order,[55,57,56]);
 await assert.rejects(driver.movePinnedForumTopic(-1001234567890,55,'up'),/边界/);
 assert.equal(calls.filter(item=>item.className==='channels.ReorderPinnedForumTopics').length,1);
});
test('forum HTTP routes validate topic IDs and dispatch to the selected account',async()=>{
 const calls=[]; const manager={getInstance:id=>id==='a'?{accountAction:async(action,params)=>{calls.push({action,params});return action==='get_forum_topics'?{topics:[]}:[];}}:undefined};
 const server=http.createServer((req,res)=>{handleApiRoute(req,res,manager,'').catch(e=>{res.statusCode=500;res.end(e.message);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try { const base=`http://127.0.0.1:${server.address().port}/api/instances/a/account`;
   assert.equal((await fetch(`${base}/forum-topics?chatId=-100123`)).status,200);
   assert.equal((await fetch(`${base}/forum-topics`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:55,action:'movePin',direction:'left'})})).status,400);
   assert.equal((await fetch(`${base}/forum-topics`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:55,action:'movePin',direction:'down'})})).status,200);
   assert.equal((await fetch(`${base}/forum-messages?chatId=-100123&topicId=55&offsetId=80`)).status,200);
   assert.equal((await fetch(`${base}/forum-messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:55,text:'hi',replyTo:80})})).status,200);
   assert.equal((await fetch(`${base}/forum-topic-read`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:55,maxId:80})})).status,200);
   assert.equal((await fetch(`${base}/forum-topic-read`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:0,maxId:80})})).status,400);
   assert.equal((await fetch(`${base}/forum-messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:-1,text:'hi'})})).status,400);
   assert.equal((await fetch(`${base}/send-gif`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:55,replyTo:80,docId:'77',accessHash:'88'})})).status,200);
   assert.equal((await fetch(`${base}/send-gif`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:-100123,topicId:0,docId:'77',accessHash:'88'})})).status,400);
   assert.deepEqual(calls.map(c=>c.action),['get_forum_topics','move_pinned_forum_topic','get_forum_messages','send_forum_message','mark_forum_topic_read','send_gif_document']);
   assert.deepEqual(calls[1].params,{chatId:-100123,topicId:55,direction:'down'});
   assert.deepEqual(calls[4].params,{chatId:-100123,topicId:55,maxId:80});
   assert.equal(calls[5].params.topMsgId,55);assert.equal(calls[5].params.replyTo,80);
 } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

async function map(media) {
  const user = new Api.User({id:bigInt(42), firstName:'Alice'});
  const message = new Api.Message({id:5, peerId:new Api.PeerUser({userId:bigInt(42)}), date:1, message:'', media});
  message.getChat = async () => user;
  message.getSender = async () => user;
  return (await Object.create(TelegramDriver.prototype).mapMessage(message)).media;
}
const point = (lat, long) => new Api.GeoPoint({lat,long,accessHash:bigInt(1)});

test('real Telegram geographic media retain only valid coordinates and safe venue metadata', async () => {
  const geo = await map(new Api.MessageMediaGeo({geo:point(0, 120.25)}));
  assert.equal(geo.type,'location'); assert.equal(geo.latitude,0); assert.equal(geo.longitude,120.25);
  const venue = await map(new Api.MessageMediaVenue({geo:point(31.2,121.5),title:'Test',address:'Address',provider:'',venueId:'',venueType:''}));
  assert.equal(venue.locationTitle,'Test'); assert.equal(venue.locationAddress,'Address');
  const live = await map(new Api.MessageMediaGeoLive({geo:point(1,2),period:60}));
  assert.equal(live.liveLocation,true); assert.equal(live.liveLocationPeriod,60);
  const empty = await map(new Api.MessageMediaGeo({geo:new Api.GeoPointEmpty()}));
  assert.equal(empty.type,'location'); assert.equal(empty.latitude,undefined);
  const invalid = await map(new Api.MessageMediaGeo({geo:point(91,1)}));
  assert.equal(invalid.latitude,undefined); assert.equal(invalid.longitude,undefined);
});
test('real Telegram contact and unknown media do not produce an empty bubble', async () => {
  const contact = await map(new Api.MessageMediaContact({phoneNumber:'+123',firstName:'A',lastName:'B',vcard:'private',userId:bigInt(7)}));
  assert.equal(contact.type,'contact'); assert.equal(contact.contactPhone,'+123'); assert.equal(contact.contactUserId,'7');
  assert.equal(contact.vcard,undefined);
  const unknown = await map(new Api.MessageMediaUnsupported());
  assert.equal(unknown.type,'unsupported');
});
test('Telegram game media retains only its public title and description for the message card', async () => {
  const game = new Api.Game({ id: bigInt(11), accessHash: bigInt(12), shortName: 'example', title: 'Example Game',
    description: 'A simple game', photo: new Api.PhotoEmpty({ id: bigInt(1) }) });
  const media = await map(new Api.MessageMediaGame({ game }));
  assert.deepEqual(media, { type: 'game', gameTitle: 'Example Game', gameDescription: 'A simple game', gameShortName: 'example' });
});
test('real animated Telegram documents retain their GIF or video media type', async () => {
  const animated = mimeType => new Api.MessageMediaDocument({document:new Api.Document({
    id:bigInt(11), accessHash:bigInt(12), fileReference:Buffer.alloc(0), date:1,
    mimeType, size:bigInt(123), dcId:2, attributes:[new Api.DocumentAttributeAnimated()],
  })});
  const gif = await map(animated('image/gif'));
  assert.equal(gif.type,'animation'); assert.equal(gif.mimeType,'image/gif');
  const mp4 = await map(animated('video/mp4'));
  assert.equal(mp4.type,'animation'); assert.equal(mp4.mimeType,'video/mp4');
});
test('Telegram round video documents retain their circular-message flag and dimensions', async () => {
  const document = new Api.Document({ id: bigInt(11), accessHash: bigInt(12), fileReference: Buffer.alloc(0), date: 1,
    mimeType: 'video/mp4', size: bigInt(123), dcId: 2,
    attributes: [new Api.DocumentAttributeVideo({ roundMessage: true, duration: 4, w: 240, h: 240 })] });
  const media = await map(new Api.MessageMediaDocument({ document }));
  assert.equal(media.type, 'video');
  assert.equal(media.roundVideo, true);
  assert.equal(media.duration, 4);
  assert.equal(media.width, 240);
  assert.equal(media.height, 240);
});
test('paid media mapping hides locked files and exposes only the unlocked Telegram media items', async () => {
  const locked = await map(new Api.MessageMediaPaidMedia({ starsAmount: bigInt(25), extendedMedia: [
    new Api.MessageExtendedMediaPreview({ w: 320, h: 240 }),
    new Api.MessageExtendedMediaPreview({ w: 320, h: 240 }),
  ] }));
  assert.equal(locked.type, 'paid_media');
  assert.equal(locked.paidMediaStars, '25');
  assert.equal(locked.paidMediaItemCount, 2);
  assert.equal(locked.paidMediaLocked, true);
  assert.deepEqual(locked.paidMediaItems, []);

  const photo = new Api.PhotoEmpty({ id: bigInt(91) });
  const unlocked = await map(new Api.MessageMediaPaidMedia({ starsAmount: bigInt(25), extendedMedia: [
    new Api.MessageExtendedMedia({ media: new Api.MessageMediaPhoto({ photo }) }),
  ] }));
  assert.equal(unlocked.paidMediaLocked, false);
  assert.deepEqual(unlocked.paidMediaItems.map(item => item.type), ['photo']);
});
test('animated GIF and WebM downloads retain their actual content type', async () => {
  const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tg-animation-'));
  try {
    for (const mime of ['image/gif','video/webm','video/mp4']) {
      const doc=new Api.Document({id:bigInt(11),accessHash:bigInt(12),fileReference:Buffer.alloc(0),date:1,mimeType:mime,size:bigInt(5),dcId:2,attributes:[new Api.DocumentAttributeAnimated()]});
      const message=new Api.Message({id:5,peerId:new Api.PeerUser({userId:bigInt(42)}),date:1,message:'',media:new Api.MessageMediaDocument({document:doc})});
      const driver=Object.create(TelegramDriver.prototype);
      driver.logger={debug(){}};
      driver.client={getMessages:async()=>[message],downloadMedia:async(_media,options)=>options.outputFile.write(Buffer.from('bytes'))};
      const result=await driver.downloadMediaFile(42,5,false,path.join(root,mime.replace('/','_')));
      assert.equal(result.mimeType,mime);
      assert.equal(await fs.readFile(result.filePath,'utf8'),'bytes');
    }
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

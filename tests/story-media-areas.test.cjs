'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapStoryMediaAreas } = require('../dist/bot/driver/story-media-areas');

test('maps supported Telegram story media areas and excludes malformed or unsupported entries', () => {
  const pos = { x: 50, y: 25, w: 20, h: 12, rotation: 0 };
  const areas = mapStoryMediaAreas([
    { className: 'MediaAreaUrl', coordinates: pos, url: 'https://example.com/path' },
    { className: 'MediaAreaSuggestedReaction', coordinates: pos, reaction: { className: 'ReactionEmoji', emoticon: '💯' } },
    { className: 'MediaAreaGeoPoint', coordinates: pos, geo: { lat: 35.6, long: 139.7 } },
    { className: 'MediaAreaVenue', coordinates: pos, geo: { lat: 35.6, long: 139.7 }, title: 'Cafe', address: 'Tokyo' },
    { className: 'MediaAreaChannelPost', coordinates: pos, channelId: 1234567890123n, msgId: 88 },
    { className: 'MediaAreaWeather', coordinates: pos, emoji: '☀️', temperatureC: 21.25 },
    { className: 'MediaAreaStarGift', coordinates: pos, slug: 'golden-gift_1' },
    { className: 'MediaAreaUrl', coordinates: { ...pos, x: 101 }, url: 'https://example.com/bad' },
    { className: 'MediaAreaUrl', coordinates: pos, url: 'x'.repeat(2049) },
    { className: 'MediaAreaUnknown', coordinates: pos },
  ]);
  assert.deepEqual(areas, [
    { type: 'url', ...pos, url: 'https://example.com/path' },
    { type: 'reaction', ...pos, emoji: '💯' },
    { type: 'geo', ...pos, latitude: 35.6, longitude: 139.7 },
    { type: 'venue', ...pos, latitude: 35.6, longitude: 139.7, title: 'Cafe', address: 'Tokyo' },
    { type: 'channel_post', ...pos, channelId: '1234567890123', messageId: 88 },
    { type: 'weather', ...pos, emoji: '☀️', temperatureC: 21.25 },
    { type: 'star_gift', ...pos, slug: 'golden-gift_1' },
  ]);
});

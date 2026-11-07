import type { StoryMediaArea } from '../adapter/types';

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function coordinates(value: any): Pick<StoryMediaArea, 'x' | 'y' | 'w' | 'h' | 'rotation'> | undefined {
  const x = finite(value?.x), y = finite(value?.y), w = finite(value?.w), h = finite(value?.h);
  const rotation = finite(value?.rotation) ?? 0;
  if (x == null || y == null || w == null || h == null || x < 0 || x > 100 || y < 0 || y > 100 ||
      w <= 0 || w > 100 || h <= 0 || h > 100 || Math.abs(rotation) > 360) return;
  return { x, y, w, h, rotation };
}

/** Convert Telegram story media areas to a small JSON-safe view model. */
export function mapStoryMediaAreas(rawAreas: unknown): StoryMediaArea[] {
  if (!Array.isArray(rawAreas)) return [];
  const result: StoryMediaArea[] = [];
  for (const raw of rawAreas as any[]) {
    const position = coordinates(raw?.coordinates);
    if (!position) continue;
    switch (raw?.className) {
      case 'MediaAreaUrl': {
        const url = typeof raw.url === 'string' && raw.url.length <= 2048 ? raw.url : '';
        if (url) result.push({ ...position, type: 'url', url });
        break;
      }
      case 'MediaAreaSuggestedReaction': {
        const reaction = raw.reaction;
        const emoji = reaction?.className === 'ReactionEmoji' && typeof reaction.emoticon === 'string'
          ? reaction.emoticon.slice(0, 32) : undefined;
        if (emoji) result.push({ ...position, type: 'reaction', emoji });
        break;
      }
      case 'MediaAreaVenue':
      case 'MediaAreaGeoPoint': {
        const latitude = finite(raw.geo?.lat), longitude = finite(raw.geo?.long);
        if (latitude == null || longitude == null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) break;
        if (raw.className === 'MediaAreaVenue') {
          result.push({ ...position, type: 'venue', latitude, longitude,
            title: typeof raw.title === 'string' ? raw.title.slice(0, 256) : '',
            address: typeof raw.address === 'string' ? raw.address.slice(0, 512) : '' });
        } else result.push({ ...position, type: 'geo', latitude, longitude });
        break;
      }
      case 'MediaAreaChannelPost': {
        const channelId = String(raw.channelId ?? '');
        const messageId = Number(raw.msgId);
        if (/^\d{1,20}$/.test(channelId) && Number.isSafeInteger(messageId) && messageId > 0) {
          result.push({ ...position, type: 'channel_post', channelId, messageId });
        }
        break;
      }
      case 'MediaAreaWeather': {
        const temperatureC = finite(raw.temperatureC);
        if (typeof raw.emoji === 'string' && raw.emoji.length <= 16 && temperatureC != null && temperatureC >= -100 && temperatureC <= 100) {
          result.push({ ...position, type: 'weather', emoji: raw.emoji, temperatureC });
        }
        break;
      }
      case 'MediaAreaStarGift': {
        const slug = typeof raw.slug === 'string' ? raw.slug : '';
        if (/^[a-zA-Z0-9_-]{1,128}$/.test(slug)) result.push({ ...position, type: 'star_gift', slug });
        break;
      }
    }
  }
  return result.slice(0, 100);
}

import { updateRefresh, advanceCycleIndex, statOrderToConfig } from '../database.js';
import { syncWidget } from './discord.js';
import { isDefaultImage } from './lastfm.js';
import type { LastFmService } from './lastfm.js';
import type { UserRow, DynamicField, WidgetPayload, StatKey, StatSlotConfig } from '../types.js';
import { DEFAULT_SUBTITLES } from '../types.js';

const DEFAULT_IMAGE_URL = 'https://lastfm-img.freetls.fastly.net/i/u/500x500/2a96cbd8b46e442fc41c2b86b821562f.png';

function formatDate(unixSeconds: string): string {
  const date = new Date(parseInt(unixSeconds, 10) * 1000);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function orDefault(url: string | null | undefined): string {
  return url ?? DEFAULT_IMAGE_URL;
}

function cropSquare(url: string | null | undefined): string {
  if (!url || isDefaultImage(url)) return DEFAULT_IMAGE_URL;
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&fit=cover&w=500&h=500&n=-1`;
}

function isLastFmCdnUrl(url: string): boolean {
  return url.includes('/i/u/');
}

async function probeContentType(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

function withTruthfulExtension(url: string, contentType: string | null): string {
  if (contentType === 'image/gif') return url.replace(/\.(png|jpe?g|webp)([?#]|$)/i, '.gif$2');
  return url;
}

async function finalizeImage(url: string | null | undefined): Promise<string> {
  if (!url || isDefaultImage(url)) return DEFAULT_IMAGE_URL;
  if (!isLastFmCdnUrl(url)) return cropSquare(url);
  const contentType = await probeContentType(url);
  if (!contentType) return cropSquare(url);
  return withTruthfulExtension(url, contentType);
}

export const CYCLE_PERIODS = ['overall', '30d', '7d'] as const;

function safeFetch<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return promise.catch(() => fallback);
}

function getPeriodLabel(period: string): string {
  if (period === '7d') return 'last 7d';
  if (period === '30d') return 'last 30d';
  return 'overall';
}

function pickForPeriod<T>(overall: T, period7d: T, period30d: T, period: string): T {
  if (period === '7d') return period7d;
  if (period === '30d') return period30d;
  return overall;
}

function getStatValue(key: StatKey, info: { playcount: number; artistCount: number }, lovedCount: number, currentPeriod: string, topTrack: { artist: string; name: string }, topTrack7: { artist: string; name: string }, topTrack30: { artist: string; name: string }, topArtist: { name: string }, topArtist7: { name: string }, topArtist30: { name: string }, topAlbum: { artist: string; name: string }, topAlbum7: { artist: string; name: string }, topAlbum30: { artist: string; name: string }): string {
  switch (key) {
    case 'scrobbles':
      return info.playcount.toLocaleString('en-US');
    case 'artists':
      return info.artistCount.toLocaleString('en-US');
    case 'loved_tracks':
      return lovedCount.toLocaleString('en-US');
    case 'top_track': {
      const t = pickForPeriod(topTrack, topTrack7, topTrack30, currentPeriod);
      return `${t.artist} - ${t.name}`;
    }
    case 'top_album': {
      const a = pickForPeriod(topAlbum, topAlbum7, topAlbum30, currentPeriod);
      return `${a.artist} - ${a.name}`;
    }
    case 'top_artist': {
      const a = pickForPeriod(topArtist, topArtist7, topArtist30, currentPeriod);
      return a.name;
    }
  }
}

function getCachedFields(user: UserRow): Map<string, DynamicField> {
  if (!user.cached_data) return new Map();
  try {
    const cached: WidgetPayload = JSON.parse(user.cached_data);
    return new Map(cached.data.dynamic.map((f) => [f.name, f]));
  } catch {
    return new Map();
  }
}

function fallbackField<T extends DynamicField>(field: T, cached: Map<string, DynamicField>): T {
  const prev = cached.get(field.name);
  if (!prev) return field;

  if (field.type === 3) {
    const url = (field.value as { url: string }).url;
    if (url === DEFAULT_IMAGE_URL) return prev as T;
  } else if (field.value === '—') {
    return prev as T;
  }

  return field;
}

export async function refreshUserWidget(
  user: UserRow,
  lastfmService: LastFmService,
): Promise<void> {
  const username = user.lastfm_username;
  const cached = getCachedFields(user);

  const fallbackArtist = { name: '—' as const, image: null };
  const fallbackAlbum = { name: '—' as const, artist: '—' as const, cover: null };
  const fallbackTrack = { name: '—' as const, artist: '—' as const, cover: null };
  const fallbackRecent = { name: '—' as const, artist: '—' as const, cover: null, nowPlaying: false };

  const [
    info, topArtist, topArtist7, topArtist30,
    topAlbum, topAlbum7, topAlbum30,
    topTrack, topTrack7, topTrack30, recentTrack, lovedCount,
  ] = await Promise.all([
    safeFetch(lastfmService.getUserInfo(username), { playcount: 0, artistCount: 0, name: username, registered: { unixtime: '0' }, image: [] }),
    safeFetch(lastfmService.getTopArtist(username), fallbackArtist),
    safeFetch(lastfmService.getTopArtist(username, '7day'), fallbackArtist),
    safeFetch(lastfmService.getTopArtist(username, '1month'), fallbackArtist),
    safeFetch(lastfmService.getTopAlbum(username), fallbackAlbum),
    safeFetch(lastfmService.getTopAlbum(username, '7day'), fallbackAlbum),
    safeFetch(lastfmService.getTopAlbum(username, '1month'), fallbackAlbum),
    safeFetch(lastfmService.getTopTrack(username), fallbackTrack),
    safeFetch(lastfmService.getTopTrack(username, '7day'), fallbackTrack),
    safeFetch(lastfmService.getTopTrack(username, '1month'), fallbackTrack),
    safeFetch(lastfmService.getRecentTrack(username), fallbackRecent),
    safeFetch(lastfmService.getLovedTrackCount(username), 0),
  ]);

  const statSlots = statOrderToConfig(user.stat_order, user.show_period_suffix === 1);
  const shouldCycle = user.primary_image_period === 'cycle' || user.secondary_image_period === 'cycle' || statSlots.some(s => s.period === 'cycle');
  const globalCyclePeriod = shouldCycle ? CYCLE_PERIODS[user.cycle_index] : null;

  const avatarRaw =
    info.image?.find((i) => i.size === 'extralarge')?.['#text'] ?? null;
  const recentArtistRaw =
    recentTrack.name !== '—' ? await safeFetch(lastfmService.getArtistImage(recentTrack.artist), null) : null;

  const [avatarUrl, artistImage, artistImage7, artistImage30, recentArtistImage] = await Promise.all([
    finalizeImage(avatarRaw),
    finalizeImage(topArtist.image),
    finalizeImage(topArtist7.image),
    finalizeImage(topArtist30.image),
    finalizeImage(recentArtistRaw),
  ]);
  const trackCover = orDefault(topTrack.cover);
  const albumCover = orDefault(topAlbum.cover);
  const trackCover7 = orDefault(topTrack7.cover);
  const trackCover30 = orDefault(topTrack30.cover);
  const albumCover7 = orDefault(topAlbum7.cover);
  const albumCover30 = orDefault(topAlbum30.cover);
  const recentCover = orDefault(recentTrack.cover);

  const imageSources: Record<string, string> = {
    avatar: avatarUrl,
    artist_overall: artistImage,
    artist_7d: artistImage7,
    artist_30d: artistImage30,
    track_overall: trackCover,
    track_7d: trackCover7,
    track_30d: trackCover30,
    album_overall: albumCover,
    album_7d: albumCover7,
    album_30d: albumCover30,
    last_scrobble: recentCover,
    last_scrobble_artist: recentArtistImage,
  };

  const hasRealImage: Record<string, boolean> = {
    artist_overall: !isDefaultImage(topArtist.image),
    artist_7d: !isDefaultImage(topArtist7.image),
    artist_30d: !isDefaultImage(topArtist30.image),
    track_overall: !isDefaultImage(topTrack.cover),
    track_7d: !isDefaultImage(topTrack7.cover),
    track_30d: !isDefaultImage(topTrack30.cover),
    album_overall: !isDefaultImage(topAlbum.cover),
    album_7d: !isDefaultImage(topAlbum7.cover),
    album_30d: !isDefaultImage(topAlbum30.cover),
    last_scrobble: !isDefaultImage(recentTrack.cover),
    last_scrobble_artist: !isDefaultImage(recentArtistImage),
  };

  const primaryImage = (() => {
    if (user.primary_image_type === 'avatar' || user.primary_image_type === 'last_scrobble' || user.primary_image_type === 'last_scrobble_artist') {
      return imageSources[user.primary_image_type];
    }
    const period = user.primary_image_period === 'cycle'
      ? CYCLE_PERIODS[user.cycle_index]
      : user.primary_image_period;
    return imageSources[`${user.primary_image_type}_${period}`] ?? DEFAULT_IMAGE_URL;
  })();

  const secondaryImage = (() => {
    if (user.secondary_image_type === 'avatar' || user.secondary_image_type === 'last_scrobble' || user.secondary_image_type === 'last_scrobble_artist') {
      return imageSources[user.secondary_image_type];
    }
    const period = user.secondary_image_period === 'cycle'
      ? CYCLE_PERIODS[user.cycle_index]
      : user.secondary_image_period;
    return imageSources[`${user.secondary_image_type}_${period}`] ?? DEFAULT_IMAGE_URL;
  })();

  const dynamic: DynamicField[] = [
    {
      type: 1,
      name: 'scrobbling_since',
       value: `scrobbling since ${formatDate(info.registered.unixtime)}`,
    },
    {
      type: 1,
      name: 'mini_profile_stat',
      value: `${info.playcount.toLocaleString('en-US')} scrobbles`,
    },
  ];

  statSlots.forEach((slot, i) => {
    const effectivePeriod = slot.period === 'cycle' && globalCyclePeriod ? globalCyclePeriod : slot.period;
    const baseSubtitle = DEFAULT_SUBTITLES[slot.key] ?? '';
    const subtitle = slot.showSuffix ? `${baseSubtitle} (${getPeriodLabel(effectivePeriod)})` : baseSubtitle;
    dynamic.push(
      { type: 1, name: `stat_subtitle_${i}`, value: subtitle },
      { type: 1, name: `stat_value_${i}`, value: getStatValue(slot.key, info, lovedCount, effectivePeriod, topTrack, topTrack7, topTrack30, topArtist, topArtist7, topArtist30, topAlbum, topAlbum7, topAlbum30) },
    );
  });

  dynamic.push(
    { type: 3, name: 'primary_image', value: { url: primaryImage } },
    { type: 3, name: 'secondary_image', value: { url: secondaryImage } },
  );

  const dynamicWithFallback = dynamic.map((f) => fallbackField(f, cached));

  const payload: WidgetPayload = {
    username: user.hide_username ? 'Last.fm' : info.name,
    data: { dynamic: dynamicWithFallback },
  };

  await syncWidget(user.discord_id, payload);

  if (shouldCycle) {
    advanceCycleIndex(user.discord_id);
  }

  const cachedStats = {
    total_scrobbles: info.playcount.toLocaleString('en-US'),
    total_artists: info.artistCount.toLocaleString('en-US'),
    loved_tracks: lovedCount.toLocaleString('en-US'),
    registered_unix: info.registered.unixtime,
    top_track: `${topTrack.artist} - ${topTrack.name}`,
    top_track_7d: `${topTrack7.artist} - ${topTrack7.name}`,
    top_track_30d: `${topTrack30.artist} - ${topTrack30.name}`,
    top_artist: topArtist.name,
    top_artist_7d: topArtist7.name,
    top_artist_30d: topArtist30.name,
    top_album: `${topAlbum.artist} - ${topAlbum.name}`,
    top_album_7d: `${topAlbum7.artist} - ${topAlbum7.name}`,
    top_album_30d: `${topAlbum30.artist} - ${topAlbum30.name}`,
  };

  const now = new Date().toISOString();
  updateRefresh(user.discord_id, now, JSON.stringify(payload), JSON.stringify(cachedStats));
}

import { updateRefresh } from '../database.js';
import { syncWidget } from './discord.js';
import { isDefaultImage } from './lastfm.js';
import type { LastFmService } from './lastfm.js';
import type { UserRow, DynamicField, WidgetPayload } from '../types.js';

const DEFAULT_IMAGE_URL = 'https://lastfm.freetls.fastly.net/i/u/500x500/2a96cbd8b46e442fc41c2b86b821562f.png';

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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const NO_PERIOD = new Set(['avatar', 'last_scrobble', 'random_artist', 'random_cover']);

export async function refreshUserWidget(
  user: UserRow,
  lastfmService: LastFmService,
): Promise<void> {
  const username = user.lastfm_username;

  const [
    info, topArtist, topArtist7, topArtist30,
    topAlbum, topAlbum7, topAlbum30,
    topTrack, topTrack7, topTrack30, recentTrack, lovedCount,
  ] = await Promise.all([
    lastfmService.getUserInfo(username),
    lastfmService.getTopArtist(username),
    lastfmService.getTopArtist(username, '7day'),
    lastfmService.getTopArtist(username, '1month'),
    lastfmService.getTopAlbum(username),
    lastfmService.getTopAlbum(username, '7day'),
    lastfmService.getTopAlbum(username, '1month'),
    lastfmService.getTopTrack(username),
    lastfmService.getTopTrack(username, '7day'),
    lastfmService.getTopTrack(username, '1month'),
    lastfmService.getRecentTrack(username),
    lastfmService.getLovedTrackCount(username),
  ]);

  const avatarUrl = orDefault(
    info.image?.find((i) => i.size === 'extralarge')?.['#text']?.replace('/300x300/', '/500x500/'),
  );

  const artistImage = orDefault(topArtist.image);
  const artistImage7 = orDefault(topArtist7.image);
  const artistImage30 = orDefault(topArtist30.image);
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
  };

  const randomArtistPool = ['artist_overall', 'artist_7d', 'artist_30d', 'album_overall', 'album_7d', 'album_30d'];
  const randomCoverPool = ['track_overall', 'track_7d', 'track_30d', 'last_scrobble'];

  const primaryImage = user.primary_image_type === 'random_artist'
    ? (shuffle(randomArtistPool).find((k) => hasRealImage[k]) ?? DEFAULT_IMAGE_URL)
    : user.primary_image_type === 'random_cover'
      ? (shuffle(randomCoverPool).find((k) => hasRealImage[k]) ?? DEFAULT_IMAGE_URL)
      : imageSources[NO_PERIOD.has(user.primary_image_type)
        ? user.primary_image_type
        : `${user.primary_image_type}_${user.primary_image_period}`];

  const dynamic: DynamicField[] = [
    {
      type: 1,
      name: 'scrobbling_since',
       value: `scrobbling since ${formatDate(info.registered.unixtime)}`,
    },
    { type: 2, name: 'total_scrobbles', value: info.playcount },
    { type: 2, name: 'total_artists', value: info.artistCount },
    { type: 2, name: 'loved_tracks', value: lovedCount },
    { type: 1, name: 'top_track', value: `${topTrack.artist} - ${topTrack.name}` },
    { type: 1, name: 'top_track_7d', value: `${topTrack7.artist} - ${topTrack7.name}` },
    { type: 1, name: 'top_track_30d', value: `${topTrack30.artist} - ${topTrack30.name}` },
    { type: 1, name: 'top_artist', value: topArtist.name },
    { type: 1, name: 'top_artist_7d', value: topArtist7.name },
    { type: 1, name: 'top_artist_30d', value: topArtist30.name },
    { type: 1, name: 'top_album', value: `${topAlbum.artist} - ${topAlbum.name}` },
    { type: 1, name: 'top_album_7d', value: `${topAlbum7.artist} - ${topAlbum7.name}` },
    { type: 1, name: 'top_album_30d', value: `${topAlbum30.artist} - ${topAlbum30.name}` },
  ];

  dynamic.push(
    { type: 3, name: 'primary_image', value: { url: primaryImage } },
    { type: 3, name: 'top_artist_picture', value: { url: artistImage } },
    { type: 3, name: 'top_artist_picture_7d', value: { url: artistImage7 } },
    { type: 3, name: 'top_artist_picture_30d', value: { url: artistImage30 } },
    { type: 3, name: 'top_track_cover', value: { url: trackCover } },
    { type: 3, name: 'top_track_cover_7d', value: { url: trackCover7 } },
    { type: 3, name: 'top_track_cover_30d', value: { url: trackCover30 } },
    { type: 3, name: 'top_album_cover', value: { url: albumCover } },
    { type: 3, name: 'top_album_cover_7d', value: { url: albumCover7 } },
    { type: 3, name: 'top_album_cover_30d', value: { url: albumCover30 } },
    { type: 3, name: 'avatar', value: { url: avatarUrl } },
    { type: 3, name: 'last_scrobble_cover', value: { url: recentCover } },
  );

  const payload: WidgetPayload = {
    username: info.name,
    data: { dynamic },
  };

  await syncWidget(user.discord_id, payload);

  const now = new Date().toISOString();
  updateRefresh(user.discord_id, now, JSON.stringify(payload));
}

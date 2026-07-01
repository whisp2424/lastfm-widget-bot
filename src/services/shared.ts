import { updateRefresh } from '../database.js';
import { syncWidget } from './discord.js';
import { isDefaultImage } from './lastfm.js';
import type { LastFmService } from './lastfm.js';
import type { UserRow, DynamicField, WidgetPayload } from '../types.js';

function formatDate(unixSeconds: string): string {
  const date = new Date(parseInt(unixSeconds, 10) * 1000);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function cacheBust(url: string | null): string | null {
  if (!url) return null;
  const ts = Date.now();
  return url.includes('?') ? `${url}&v=${ts}` : `${url}?v=${ts}`;
}

export async function refreshUserWidget(
  user: UserRow,
  lastfmService: LastFmService,
): Promise<void> {
  const username = user.lastfm_username;

  const [info, topArtist, topAlbum, topTrack, lovedCount] =
    await Promise.all([
      lastfmService.getUserInfo(username),
      lastfmService.getTopArtist(username),
      lastfmService.getTopAlbum(username),
      lastfmService.getTopTrack(username),
      lastfmService.getLovedTrackCount(username),
    ]);

  const avatarUrl = cacheBust(
    info.image?.find((i) => i.size === 'extralarge')?.['#text']?.replace('/300x300/', '/500x500/') ?? null,
  );

  const artistImage = cacheBust(!isDefaultImage(topArtist.image) ? topArtist.image : null);
  const trackCover = cacheBust(!isDefaultImage(topTrack.cover) ? topTrack.cover : null);
  const albumCover = cacheBust(!isDefaultImage(topAlbum.cover) ? topAlbum.cover : null);

  const images: Record<string, string | null> = {
    artist: artistImage,
    album: albumCover,
    avatar: avatarUrl,
  };

  const fallbackOrder =
    user.primary_source === 'album'
      ? (['album', 'artist', 'avatar'] as const)
      : user.primary_source === 'avatar'
        ? (['avatar', 'artist', 'album'] as const)
        : (['artist', 'album', 'avatar'] as const);

  const primaryImage = fallbackOrder.reduce<string | null>(
    (acc, key) => acc ?? images[key],
    null,
  );

  const dynamic: DynamicField[] = [
    {
      type: 1,
      name: 'scrobbling_since',
      value: `Scrobbling since ${formatDate(info.registered.unixtime)}`,
    },
    { type: 2, name: 'total_scrobbles', value: info.playcount },
    { type: 2, name: 'total_artists', value: info.artistCount },
    { type: 2, name: 'loved_tracks', value: lovedCount },
    { type: 1, name: 'top_track', value: `"${topTrack.name}" by ${topTrack.artist}` },
    { type: 1, name: 'top_artist', value: topArtist.name },
    { type: 1, name: 'top_album', value: `"${topAlbum.name}" by ${topAlbum.artist}` },
  ];

  if (primaryImage) {
    dynamic.push({
      type: 3,
      name: 'primary_image',
      value: { url: primaryImage },
    });
  }

  if (artistImage) {
    dynamic.push({
      type: 3,
      name: 'top_artist_picture',
      value: { url: artistImage },
    });
  }

  if (trackCover) {
    dynamic.push({
      type: 3,
      name: 'top_track_cover',
      value: { url: trackCover },
    });
  }

  if (albumCover) {
    dynamic.push({
      type: 3,
      name: 'top_album_cover',
      value: { url: albumCover },
    });
  }

  if (avatarUrl) {
    dynamic.push({ type: 3, name: 'avatar', value: { url: avatarUrl } });
  }

  const payload: WidgetPayload = {
    username: info.name,
    data: { dynamic },
  };

  await syncWidget(user.discord_id, payload);

  const now = new Date().toISOString();
  updateRefresh(user.discord_id, now, JSON.stringify(payload));
}

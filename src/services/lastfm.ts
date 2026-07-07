const API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const ARTIST_PAGE_BASE = 'https://www.last.fm/music/';
const DEFAULT_IMAGE_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

interface ImageEntry {
  '#text': string;
  size: string;
}

export function isDefaultImage(url: string | null | undefined): boolean {
  if (!url) return true;
  return url.includes(DEFAULT_IMAGE_HASH);
}

export class LastFmService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async fetch<T>(
    method: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(API_BASE);
    url.searchParams.set('method', method);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url);
    const data = (await res.json()) as T & {
      error?: number;
      message?: string;
    };

    if (data.error) {
      throw new Error(`Last.fm API error: ${data.message ?? data.error}`);
    }

    return data;
  }

  async getUserInfo(username: string) {
    const data = await this.fetch<{
      user: {
        playcount: string;
        artist_count: string;
        name: string;
        registered: { unixtime: string };
        image: ImageEntry[];
      };
    }>('user.getInfo', { user: username });

    return {
      playcount: parseInt(data.user.playcount, 10) || 0,
      artistCount: parseInt(data.user.artist_count, 10) || 0,
      name: data.user.name,
      registered: data.user.registered,
      image: data.user.image,
    };
  }

  async getTopArtist(username: string, period: string = 'overall'): Promise<{
    name: string;
    image: string | null;
  }> {
    const data = await this.fetch<{
      topartists: { artist: { name: string; mbid?: string }[] };
    }>('user.getTopArtists', { user: username, period, limit: 1 });
    const artist = data.topartists?.artist?.[0];
    if (!artist) return { name: '—', image: null };

    let image: string | null = null;
    try {
      image = await this.getArtistImage(artist.name);
    } catch {
      // image is optional
    }

    return { name: artist.name, image };
  }

  async getArtistImage(artist: string): Promise<string | null> {
    const url = `${ARTIST_PAGE_BASE}${encodeURIComponent(artist)}?_t=${Date.now()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(
      /<meta\s+property="og:image"\s+content="([^"]+)"/i,
    );
    return match?.[1]?.replace('/ar0/', '/500x500/') ?? null;
  }

  async getTopAlbum(
    username: string,
    period: string = 'overall',
  ): Promise<{
    name: string;
    artist: string;
    cover: string | null;
  }> {
    const data = await this.fetch<{
      topalbums: { album: { name: string; artist: { name: string } }[] };
    }>('user.getTopAlbums', { user: username, period, limit: 1 });
    const album = data.topalbums?.album?.[0];
    if (!album) return { name: '—', artist: '—', cover: null };

    let cover: string | null = null;
    try {
      const info = await this.fetch<{
        album: { image: ImageEntry[] };
      }>('album.getInfo', {
        artist: album.artist.name,
        album: album.name,
      });
      cover =
        info.album?.image?.find((i) => i.size === 'extralarge')?.['#text']
          ?.replace('/300x300/', '/500x500/') ?? null;
    } catch {
      // cover art is optional
    }

    return {
      name: album.name,
      artist: album.artist.name,
      cover,
    };
  }

  async getTopTrack(
    username: string,
    period: string = 'overall',
  ): Promise<{
    name: string;
    artist: string;
    cover: string | null;
  }> {
    const data = await this.fetch<{
      toptracks: { track: { name: string; artist: { name: string } }[] };
    }>('user.getTopTracks', { user: username, period, limit: 1 });
    const track = data.toptracks?.track?.[0];
    if (!track) return { name: '—', artist: '—', cover: null };

    let cover: string | null = null;
    try {
      const info = await this.fetch<{
        track: { album: { image: ImageEntry[] } };
      }>('track.getInfo', { artist: track.artist.name, track: track.name });
      cover =
        info.track?.album?.image?.find((i) => i.size === 'extralarge')?.[
          '#text'
        ]?.replace('/300x300/', '/500x500/') ?? null;
    } catch {
      // cover art is optional
    }

    return { name: track.name, artist: track.artist.name, cover };
  }

  async getRecentTrack(username: string): Promise<{
    name: string;
    artist: string;
    cover: string | null;
    nowPlaying: boolean;
  }> {
    const data = await this.fetch<{
      recenttracks: {
        track: {
          name: string;
          artist: { '#text': string };
          image: ImageEntry[];
          '@attr'?: { nowplaying: string };
        }[];
      };
    }>('user.getRecentTracks', { user: username, limit: 1 });

    const track = data.recenttracks?.track?.[0];
    if (!track) return { name: '—', artist: '—', cover: null, nowPlaying: false };

    const cover =
      track.image?.find((i) => i.size === 'extralarge')?.['#text']
        ?.replace('/300x300/', '/500x500/') ?? null;

    return {
      name: track.name,
      artist: track.artist['#text'],
      cover,
      nowPlaying: track['@attr']?.nowplaying === 'true',
    };
  }

  async getLovedTrackCount(username: string): Promise<number> {
    const data = await this.fetch<{
      lovedtracks: { '@attr': { total: string } };
    }>('user.getLovedTracks', { user: username, limit: 1 });
    return parseInt(data.lovedtracks?.['@attr']?.total ?? '0', 10);
  }

  async getArtistInfo(artist: string): Promise<{
    name: string;
    bio: string;
    tags: string[];
    similar: string[];
    playcount: number;
    listeners: number;
    url: string;
  }> {
    const data = await this.fetch<{
      artist: {
        name: string;
        url: string;
        bio: { summary: string; content: string };
        tags: { tag: { name: string }[] };
        similar: { artist: { name: string }[] };
        stats: { playcount: string; listeners: string };
      };
    }>('artist.getInfo', { artist, lang: 'en' });

    const a = data.artist;
    return {
      name: a.name,
      bio: a.bio?.summary?.replace(/<[^>]*>/g, '').trim() ?? '',
      tags: (a.tags?.tag ?? []).map((t) => t.name),
      similar: (a.similar?.artist ?? []).map((s) => s.name),
      playcount: parseInt(a.stats?.playcount ?? '0', 10),
      listeners: parseInt(a.stats?.listeners ?? '0', 10),
      url: a.url,
    };
  }

  async getAlbumInfo(artist: string, album: string): Promise<{
    name: string;
    artist: string;
    wiki: string;
    releaseDate: string;
    tracks: string[];
    tags: string[];
    playcount: number;
    listeners: number;
    url: string;
  }> {
    const data = await this.fetch<{
      album: {
        name: string;
        artist: string;
        url: string;
        wiki: { summary: string; published: string };
        tracks: { track: { name: string }[] };
        tags: { tag: { name: string }[] };
        playcount: string;
        listeners: string;
      };
    }>('album.getInfo', { artist, album, lang: 'en' });

    const a = data.album;
    return {
      name: a.name,
      artist: a.artist,
      wiki: a.wiki?.summary?.replace(/<[^>]*>/g, '').trim() ?? '',
      releaseDate: a.wiki?.published ?? '',
      tracks: (a.tracks?.track ?? []).map((t) => t.name),
      tags: (a.tags?.tag ?? []).map((t) => t.name),
      playcount: parseInt(a.playcount ?? '0', 10),
      listeners: parseInt(a.listeners ?? '0', 10),
      url: a.url,
    };
  }

  async getTrackInfo(artist: string, track: string): Promise<{
    name: string;
    artist: string;
    album: string;
    duration: number;
    tags: string[];
    playcount: number;
    listeners: number;
    url: string;
  }> {
    const data = await this.fetch<{
      track: {
        name: string;
        artist: { name: string };
        album?: { title: string };
        url: string;
        duration: string;
        wiki: { summary: string };
        toptags: { tag: { name: string }[] };
        playcount: string;
        listeners: string;
      };
    }>('track.getInfo', { artist, track, lang: 'en' });

    const t = data.track;
    return {
      name: t.name,
      artist: t.artist.name,
      album: t.album?.title ?? '',
      duration: parseInt(t.duration ?? '0', 10),
      tags: (t.toptags?.tag ?? []).map((tag) => tag.name),
      playcount: parseInt(t.playcount ?? '0', 10),
      listeners: parseInt(t.listeners ?? '0', 10),
      url: t.url,
    };
  }
}

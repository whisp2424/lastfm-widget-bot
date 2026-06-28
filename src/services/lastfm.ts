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

  async getTopArtist(username: string): Promise<{
    name: string;
    image: string | null;
  }> {
    const data = await this.fetch<{
      topartists: { artist: { name: string; mbid?: string }[] };
    }>('user.getTopArtists', { user: username, period: 'overall', limit: 1 });
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
    const url = `${ARTIST_PAGE_BASE}${encodeURIComponent(artist)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(
      /<meta\s+property="og:image"\s+content="([^"]+)"/i,
    );
    return match?.[1] ?? null;
  }

  async getTopAlbumName(username: string): Promise<string> {
    const data = await this.fetch<{
      topalbums: { album: { name: string }[] };
    }>('user.getTopAlbums', { user: username, period: 'overall', limit: 1 });
    return data.topalbums?.album?.[0]?.name ?? '—';
  }

  async getTopTrack(username: string): Promise<{
    name: string;
    artist: string;
    cover: string | null;
  }> {
    const data = await this.fetch<{
      toptracks: { track: { name: string; artist: { name: string } }[] };
    }>('user.getTopTracks', { user: username, period: 'overall', limit: 1 });
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

  async getLovedTrackCount(username: string): Promise<number> {
    const data = await this.fetch<{
      lovedtracks: { '@attr': { total: string } };
    }>('user.getLovedTracks', { user: username, limit: 1 });
    return parseInt(data.lovedtracks?.['@attr']?.total ?? '0', 10);
  }
}

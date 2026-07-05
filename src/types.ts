export type PrimaryImageType = 'avatar' | 'artist' | 'track' | 'album' | 'last_scrobble' | 'last_scrobble_artist';
export type PrimaryImagePeriod = 'overall' | '7d' | '30d' | 'cycle';

export type SecondaryImageType = PrimaryImageType;
export type SecondaryImagePeriod = PrimaryImagePeriod;

export type StatKey = 'scrobbles' | 'artists' | 'loved_tracks' | 'top_track' | 'top_album' | 'top_artist';
export type StatPeriod = 'overall' | '7d' | '30d' | 'cycle';

export interface StatSlotConfig {
  key: StatKey;
  period: StatPeriod;
  showSuffix: boolean;
}

export const DEFAULT_STAT_ORDER: StatSlotConfig[] = [
  { key: 'scrobbles', period: 'overall', showSuffix: false },
  { key: 'artists', period: 'overall', showSuffix: false },
  { key: 'loved_tracks', period: 'overall', showSuffix: false },
  { key: 'top_track', period: 'overall', showSuffix: false },
  { key: 'top_album', period: 'overall', showSuffix: false },
  { key: 'top_artist', period: 'overall', showSuffix: false },
];

export const DEFAULT_SUBTITLES: Record<StatKey, string> = {
  scrobbles: 'Scrobbles',
  artists: 'Artists',
  loved_tracks: 'Loved Tracks',
  top_track: 'Top Track',
  top_album: 'Top Album',
  top_artist: 'Top Artist',
};

export interface UserRow {
  discord_id: string;
  lastfm_username: string;
  authorized: number;
  access_token: string | null;
  last_refresh_at: string | null;
  cached_data: string | null;
  cached_stats: string | null;
  primary_image_type: PrimaryImageType;
  primary_image_period: PrimaryImagePeriod;
  cycle_index: number;
  hide_username: number;
  stat_order: string;
  show_period_suffix: number;
  secondary_image_type: SecondaryImageType;
  secondary_image_period: SecondaryImagePeriod;
}

export interface CachedStats {
  total_scrobbles: string;
  total_artists: string;
  loved_tracks: string;
  top_track: string;
  top_track_7d: string;
  top_track_30d: string;
  top_artist: string;
  top_artist_7d: string;
  top_artist_30d: string;
  top_album: string;
  top_album_7d: string;
  top_album_30d: string;
}

export interface DynamicField {
  type: 1 | 2 | 3;
  name: string;
  value: string | number | { url: string };
}

export interface WidgetPayload {
  username: string;
  data: {
    dynamic: DynamicField[];
  };
}

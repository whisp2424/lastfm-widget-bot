export type PrimaryImageType = 'avatar' | 'artist' | 'track' | 'album' | 'last_scrobble' | 'last_scrobble_artist';
export type PrimaryImagePeriod = 'overall' | '7d' | '30d' | 'cycle';

export interface UserRow {
  discord_id: string;
  lastfm_username: string;
  authorized: number;
  access_token: string | null;
  last_refresh_at: string | null;
  cached_data: string | null;
  primary_image_type: PrimaryImageType;
  primary_image_period: PrimaryImagePeriod;
  cycle_index: number;
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

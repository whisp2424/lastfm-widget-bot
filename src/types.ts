export type PrimarySource = 'artist' | 'track' | 'album' | 'avatar';

export interface UserRow {
  discord_id: string;
  lastfm_username: string;
  authorized: number;
  access_token: string | null;
  last_refresh_at: string | null;
  cached_data: string | null;
  primary_source: PrimarySource;
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

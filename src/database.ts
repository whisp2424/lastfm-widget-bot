import Database from 'better-sqlite3';
import path from 'node:path';
import type { UserRow, PrimaryImageType, PrimaryImagePeriod, SecondaryImageType, SecondaryImagePeriod, StatSlotConfig, StatKey } from './types.js';

const DB_PATH = path.join(process.cwd(), 'widget.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id    TEXT PRIMARY KEY,
      lastfm_username TEXT NOT NULL,
      authorized    INTEGER NOT NULL DEFAULT 0,
      access_token  TEXT,
      last_refresh_at TEXT,
      cached_data   TEXT,
      primary_image_type TEXT NOT NULL DEFAULT 'artist',
      primary_image_period TEXT NOT NULL DEFAULT 'overall',
      cycle_index INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_refresh_at TEXT NOT NULL
    )
  `);

  try {
    db.exec(`ALTER TABLE users ADD COLUMN primary_image_type TEXT NOT NULL DEFAULT 'artist'`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN primary_image_period TEXT NOT NULL DEFAULT 'overall'`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN cycle_index INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN hide_username INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN stat_order TEXT NOT NULL DEFAULT '["scrobbles","artists","loved_tracks","top_track","top_album","top_artist"]'`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN show_period_suffix INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN secondary_image_type TEXT NOT NULL DEFAULT 'avatar'`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN secondary_image_period TEXT NOT NULL DEFAULT 'overall'`);
  } catch {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN cached_stats TEXT`);
  } catch {
    // column already exists
  }
}

export function upsertUser(discordId: string, lastfmUsername: string): void {
  const stmt = getDb().prepare(`
    INSERT INTO users (discord_id, lastfm_username)
    VALUES (?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      lastfm_username = excluded.lastfm_username
  `);
  stmt.run(discordId, lastfmUsername);
}

export function getUser(discordId: string): UserRow | undefined {
  const stmt = getDb().prepare('SELECT * FROM users WHERE discord_id = ?');
  return stmt.get(discordId) as UserRow | undefined;
}

export function setAuthorized(discordId: string, accessToken: string): void {
  const stmt = getDb().prepare(`
    UPDATE users SET authorized = 1, access_token = ? WHERE discord_id = ?
  `);
  stmt.run(accessToken, discordId);
}

export function deauthorizeUser(discordId: string): void {
  getDb().prepare(`
    UPDATE users SET authorized = 0, access_token = NULL WHERE discord_id = ?
  `).run(discordId);
}

export function updateRefresh(
  discordId: string,
  now: string,
  cachedData: string,
  cachedStats: string,
): void {
  const stmt = getDb().prepare(`
    UPDATE users SET last_refresh_at = ?, cached_data = ?, cached_stats = ? WHERE discord_id = ?
  `);
  stmt.run(now, cachedData, cachedStats, discordId);
}

export function setPrimaryImageConfig(
  discordId: string,
  type: PrimaryImageType,
  period: PrimaryImagePeriod,
): void {
  const stmt = getDb().prepare(`
    UPDATE users SET primary_image_type = ?, primary_image_period = ?, cycle_index = 0 WHERE discord_id = ?
  `);
  stmt.run(type, period, discordId);
}

export function setHideUsername(discordId: string, hide: boolean): void {
  getDb().prepare(`
    UPDATE users SET hide_username = ? WHERE discord_id = ?
  `).run(hide ? 1 : 0, discordId);
}

export function setStatOrder(discordId: string, order: StatSlotConfig[]): void {
  getDb().prepare(`
    UPDATE users SET stat_order = ? WHERE discord_id = ?
  `).run(JSON.stringify(order), discordId);
}

export function statOrderToConfig(statOrder: string, oldShowSuffix = false): StatSlotConfig[] {
  try {
    const parsed = JSON.parse(statOrder);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed.map((key: string) => ({
        key: key as StatKey,
        period: 'overall' as const,
        showSuffix: oldShowSuffix,
      }));
    }
    return parsed as StatSlotConfig[];
  } catch {
    return [
      { key: 'scrobbles', period: 'overall', showSuffix: false },
      { key: 'artists', period: 'overall', showSuffix: false },
      { key: 'loved_tracks', period: 'overall', showSuffix: false },
      { key: 'top_track', period: 'overall', showSuffix: false },
      { key: 'top_album', period: 'overall', showSuffix: false },
      { key: 'top_artist', period: 'overall', showSuffix: false },
    ];
  }
}

export function setShowPeriodSuffix(discordId: string, show: boolean): void {
  getDb().prepare(`
    UPDATE users SET show_period_suffix = ? WHERE discord_id = ?
  `).run(show ? 1 : 0, discordId);
}

export function setSecondaryImageConfig(
  discordId: string,
  type: SecondaryImageType,
  period: SecondaryImagePeriod,
): void {
  getDb().prepare(`
    UPDATE users SET secondary_image_type = ?, secondary_image_period = ?, cycle_index = 0 WHERE discord_id = ?
  `).run(type, period, discordId);
}

export function advanceCycleIndex(discordId: string): void {
  getDb().prepare(`
    UPDATE users SET cycle_index = (cycle_index + 1) % 3 WHERE discord_id = ?
  `).run(discordId);
}

export function getAllAuthorizedUsers(): UserRow[] {
  const stmt = getDb().prepare('SELECT * FROM users WHERE authorized = 1');
  return stmt.all() as UserRow[];
}

export function getSchedulerNextRefresh(): number | null {
  const row = getDb().prepare('SELECT next_refresh_at FROM scheduler WHERE id = 1').get() as { next_refresh_at: string } | undefined;
  if (!row) return null;
  const ts = Date.parse(row.next_refresh_at);
  return isNaN(ts) ? null : ts;
}

export function setSchedulerNextRefresh(isoString: string): void {
  getDb().prepare(`
    INSERT INTO scheduler (id, next_refresh_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at
  `).run(isoString);
}

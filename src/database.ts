import Database from 'better-sqlite3';
import path from 'node:path';
import type { UserRow, PrimaryImageType, PrimaryImagePeriod } from './types.js';

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

export function updateRefresh(
  discordId: string,
  now: string,
  cachedData: string,
): void {
  const stmt = getDb().prepare(`
    UPDATE users SET last_refresh_at = ?, cached_data = ? WHERE discord_id = ?
  `);
  stmt.run(now, cachedData, discordId);
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

export function advanceCycleIndex(discordId: string, index: number): void {
  const stmt = getDb().prepare(`
    UPDATE users SET cycle_index = ? WHERE discord_id = ?
  `);
  stmt.run(index, discordId);
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

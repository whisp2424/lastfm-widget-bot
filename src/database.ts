import Database from 'better-sqlite3';
import path from 'node:path';
import type { UserRow } from './types.js';

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
      cached_data   TEXT
    )
  `);
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

export function getAllAuthorizedUsers(): UserRow[] {
  const stmt = getDb().prepare('SELECT * FROM users WHERE authorized = 1');
  return stmt.all() as UserRow[];
}

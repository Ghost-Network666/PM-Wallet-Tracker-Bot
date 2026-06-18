import Database from 'better-sqlite3';
import { normalizeAddress } from './utils.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface TrackedWallet {
  id: number;
  address: string;
  name: string;
  added_by: string;
  added_at: string;
  last_checked: string;
  last_positions_hash: string | null;
  last_activity_hash: string | null;
  active: number;
}

export interface WalletEvent {
  id: number;
  wallet_address: string;
  event_type: string;
  event_data: string;
  notified: number;
  created_at: string;
}

let db: Database.Database;

export function initDb(dbPath = 'data/data.db'): void {
  const dir = dirname(dbPath);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_positions_hash TEXT,
      last_activity_hash TEXT,
      active BOOLEAN DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS wallet_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      notified BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_address ON tracked_wallets(address);
    CREATE INDEX IF NOT EXISTS idx_events_wallet ON wallet_events(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_events_notified ON wallet_events(notified);
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function addWallet(address: string, name: string, addedBy: string): TrackedWallet {
  const addr = normalizeAddress(address);
  const stmt = getDb().prepare(`
    INSERT INTO tracked_wallets (address, name, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      name = excluded.name,
      added_by = excluded.added_by,
      active = 1
  `);
  stmt.run(addr, name, addedBy);

  return getWalletByAddress(addr)!;
}

export function removeWallet(identifier: string): boolean {
  const db = getDb();
  let result;

  if (/^0x[a-fA-F0-9]{40}$/.test(identifier)) {
    result = db.prepare('DELETE FROM tracked_wallets WHERE address = ?').run(normalizeAddress(identifier));
  } else {
    // Try name first, then address substring
    result = db.prepare('DELETE FROM tracked_wallets WHERE name = ?').run(identifier);
    if (result.changes === 0) {
      const like = `%${identifier}%`;
      result = db.prepare('DELETE FROM tracked_wallets WHERE address LIKE ? OR name LIKE ?').run(like, like);
    }
  }
  return result.changes > 0;
}

export function renameWallet(currentName: string, newName: string): boolean {
  const result = getDb()
    .prepare('UPDATE tracked_wallets SET name = ? WHERE name = ? AND active = 1')
    .run(newName, currentName);
  return result.changes > 0;
}

export function getWalletByAddress(address: string): TrackedWallet | null {
  return getDb()
    .prepare('SELECT * FROM tracked_wallets WHERE address = ? AND active = 1')
    .get(normalizeAddress(address)) as TrackedWallet | null;
}

function isValidAddressLike(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/i.test(s);
}

export function getWalletByNameOrAddress(identifier: string): TrackedWallet | null {
  const db = getDb();
  if (isValidAddressLike(identifier)) {
    return getWalletByAddress(identifier);
  }
  const byName = db.prepare('SELECT * FROM tracked_wallets WHERE name = ? AND active = 1').get(identifier) as TrackedWallet | null;
  if (byName) return byName;
  const like = `%${identifier}%`;
  return db.prepare('SELECT * FROM tracked_wallets WHERE (address LIKE ? OR name LIKE ?) AND active = 1 LIMIT 1').get(like, like) as TrackedWallet | null;
}

export function listWallets(): TrackedWallet[] {
  return getDb()
    .prepare('SELECT * FROM tracked_wallets WHERE active = 1 ORDER BY added_at DESC')
    .all() as TrackedWallet[];
}

export function updateWalletHashes(address: string, positionsHash: string | null, activityHash: string | null): void {
  const addr = normalizeAddress(address);
  getDb().prepare(`
    UPDATE tracked_wallets
    SET last_positions_hash = ?, last_activity_hash = ?, last_checked = CURRENT_TIMESTAMP
    WHERE address = ?
  `).run(positionsHash, activityHash, addr);
}

export function getAllActiveWallets(): TrackedWallet[] {
  return getDb()
    .prepare('SELECT * FROM tracked_wallets WHERE active = 1')
    .all() as TrackedWallet[];
}

export function recordEvent(walletAddress: string, eventType: string, eventData: unknown): number {
  const addr = normalizeAddress(walletAddress);
  const json = JSON.stringify(eventData);
  const result = getDb()
    .prepare('INSERT INTO wallet_events (wallet_address, event_type, event_data) VALUES (?, ?, ?)')
    .run(addr, eventType, json);
  return result.lastInsertRowid as number;
}

export function getUnnotifiedEvents(): WalletEvent[] {
  return getDb()
    .prepare('SELECT * FROM wallet_events WHERE notified = 0 ORDER BY created_at ASC')
    .all() as WalletEvent[];
}

export function markEventsNotified(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`UPDATE wallet_events SET notified = 1 WHERE id IN (${placeholders})`).run(...ids);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}

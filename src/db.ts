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
  min_size?: number;
  side_filter?: string;
  notify_first_time?: number;
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
      active BOOLEAN DEFAULT 1,
      min_size REAL DEFAULT 0,
      side_filter TEXT DEFAULT 'ALL',
      notify_first_time BOOLEAN DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS wallet_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      notified BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      dedup_key TEXT
    );

    CREATE TABLE IF NOT EXISTS wallet_market_interactions (
      wallet_address TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (wallet_address, market_slug)
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_address ON tracked_wallets(address);
    CREATE INDEX IF NOT EXISTS idx_events_wallet ON wallet_events(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_events_notified ON wallet_events(notified);
    CREATE INDEX IF NOT EXISTS idx_events_dedup ON wallet_events(wallet_address, dedup_key);
  `);

  // Add columns for existing DBs (ignore errors if already exist)
  try { db.exec(`ALTER TABLE tracked_wallets ADD COLUMN min_size REAL DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE tracked_wallets ADD COLUMN side_filter TEXT DEFAULT 'ALL';`); } catch {}
  try { db.exec(`ALTER TABLE tracked_wallets ADD COLUMN notify_first_time BOOLEAN DEFAULT 1;`); } catch {}
  try { db.exec(`ALTER TABLE wallet_events ADD COLUMN dedup_key TEXT;`); } catch {}
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

export function recordEvent(walletAddress: string, eventType: string, eventData: unknown, dedupKey?: string): number {
  const addr = normalizeAddress(walletAddress);
  const json = JSON.stringify(eventData);
  const key = dedupKey || null;
  if (key && hasSeenEvent(addr, key)) {
    return -1; // skipped as duplicate
  }
  const result = getDb()
    .prepare('INSERT INTO wallet_events (wallet_address, event_type, event_data, dedup_key) VALUES (?, ?, ?, ?)')
    .run(addr, eventType, json, key);
  const id = result.lastInsertRowid as number;
  return id;
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

export function updateWalletSettings(address: string, settings: { min_size?: number; side_filter?: string; notify_first_time?: number }) {
  const { min_size = 0, side_filter = 'ALL', notify_first_time = 1 } = settings;
  getDb().prepare(`
    UPDATE tracked_wallets 
    SET min_size = ?, side_filter = ?, notify_first_time = ? 
    WHERE address = ?
  `).run(min_size, side_filter, notify_first_time, normalizeAddress(address));
}

export function getWalletSettings(address: string) {
  return getDb().prepare(`
    SELECT min_size, side_filter, notify_first_time 
    FROM tracked_wallets 
    WHERE address = ?
  `).get(normalizeAddress(address)) || { min_size: 0, side_filter: 'ALL', notify_first_time: 1 };
}

export function markMarketSeen(address: string, slug: string) {
  getDb().prepare(`
    INSERT OR IGNORE INTO wallet_market_interactions (wallet_address, market_slug) 
    VALUES (?, ?)
  `).run(normalizeAddress(address), slug);
}

export function hasSeenMarket(address: string, slug: string) {
  return !!getDb().prepare(`
    SELECT 1 FROM wallet_market_interactions 
    WHERE wallet_address = ? AND market_slug = ?
  `).get(normalizeAddress(address), slug);
}

export function hasEventWithTx(walletAddress: string, txHash: string) {
  if (!txHash) return false;
  const row = getDb().prepare(`
    SELECT 1 FROM wallet_events 
    WHERE wallet_address = ? AND event_data LIKE ? 
    LIMIT 1
  `).get(normalizeAddress(walletAddress), `%${txHash}%`);
  return !!row;
}

export function hasSeenEvent(walletAddress: string, dedupKey: string): boolean {
  if (!dedupKey) return false;
  const row = getDb().prepare(`
    SELECT 1 FROM wallet_events 
    WHERE wallet_address = ? AND dedup_key = ?
    LIMIT 1
  `).get(normalizeAddress(walletAddress), dedupKey);
  if (row) return true;
  // Fallback for old events that may not have dedup_key stored yet
  if (dedupKey.startsWith('tx:')) {
    const tx = dedupKey.slice(3);
    return hasEventWithTx(walletAddress, tx);
  }
  return false;
}

export function backfillSeenEvent(walletAddress: string, eventType: string, eventData: unknown, dedupKey?: string): void {
  const addr = normalizeAddress(walletAddress);
  const json = JSON.stringify(eventData);
  const key = dedupKey || null;
  if (key && hasSeenEvent(addr, key)) return;
  try {
    getDb().prepare(
      'INSERT INTO wallet_events (wallet_address, event_type, event_data, notified, dedup_key) VALUES (?, ?, ?, 1, ?)'
    ).run(addr, eventType, json, key);
  } catch {
    // ignore duplicates or constraint issues
  }
}

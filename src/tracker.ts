import { getAllActiveWallets, updateWalletHashes, recordEvent, getUnnotifiedEvents, markEventsNotified, getWalletByAddress } from './db.js';
import { fetchWalletSnapshot } from './polymarket.js';
import { hashState, shortText, sleep, formatPnL, formatSide, formatDate, formatPrice, truncateAddress, formatDecimal } from './utils.js';

export interface TrackerConfig {
  intervalMs: number;
  sendNotification: (message: string) => Promise<void>;
  maxItems: number;
}

let running = false;

// In-memory previous snapshots for reliable diffing (keyed by normalized address)
const prevSnapshots = new Map<string, { positions: any[]; activity: any[]; trades: any[] }>();

/**
 * Prime the in-memory snapshot for a wallet so that the next poll can properly diff changes.
 * Called immediately after /add-wallet to start monitoring without waiting for full cycle.
 */
export function primeWalletForMonitoring(address: string, snapshot: { positions: any[]; trades: any[]; activity: any[] }) {
  const normAddr = address.toLowerCase();
  prevSnapshots.set(normAddr, snapshot);
}

function detectNewPositions(prev: any[], current: any[]): any[] {
  const prevKeys = new Set(prev.map(p => `${p.conditionId}:${p.outcomeIndex ?? ''}`));
  return current.filter(p => !prevKeys.has(`${p.conditionId}:${p.outcomeIndex ?? ''}`));
}

function detectClosedPositions(prev: any[], current: any[]): any[] {
  const curKeys = new Set(current.map(p => `${p.conditionId}:${p.outcomeIndex ?? ''}`));
  return prev.filter(p => !curKeys.has(`${p.conditionId}:${p.outcomeIndex ?? ''}`));
}

function detectNewTrades(prev: any[], current: any[]): any[] {
  const prevKeys = new Set(prev.map(t => `${t.transactionHash || ''}:${t.timestamp || ''}:${t.size}`));
  return current.filter(t => !prevKeys.has(`${t.transactionHash || ''}:${t.timestamp || ''}:${t.size}`));
}

function detectNewActivity(prev: any[], current: any[]): any[] {
  const prevKeys = new Set(prev.map(a => `${a.transactionHash || ''}:${a.timestamp}:${a.type}`));
  return current.filter(a => !prevKeys.has(`${a.transactionHash || ''}:${a.timestamp}:${a.type}`));
}

function formatPositionChange(type: 'new' | 'closed', pos: any): string {
  const emoji = type === 'new' ? '🟢' : '🔴';
  const label = type === 'new' ? 'New position opened' : 'Position closed';
  const title = shortText(pos.title || pos.slug || 'Unknown market', 55);
  const outcome = pos.outcome ? ` (${pos.outcome})` : '';
  const size = pos.size ? ` | Size: ${formatDecimal(pos.size)}` : '';
  const avg = pos.avgPrice ? ` | Avg ${formatPrice(pos.avgPrice, true)}` : '';
  const cur = pos.curPrice ? ` | Cur ${formatPrice(pos.curPrice, true)}` : '';
  const pnl = pos.cashPnl != null ? ` | PnL: ${formatPnL(pos.cashPnl)}` : '';
  return `${emoji} **${label}**: **${title}**${outcome}${size}${avg}${cur}${pnl}`;
}

function formatTrade(trade: any): string {
  const side = formatSide(trade.side);
  const title = shortText(trade.title || trade.slug || 'market', 50);
  const outcome = trade.outcome ? ` ${trade.outcome}` : '';
  const sizeStr = trade.size ? ` ${formatDecimal(trade.size)}` : '';
  const priceStr = trade.price ? ` @ ${formatPrice(trade.price, true)}` : '';
  const when = trade.timestamp ? ` • ${formatDate(trade.timestamp)}` : '';
  return `💱 ${side} **${title}**${outcome}${sizeStr}${priceStr}${when}`;
}

function formatActivity(act: any): string {
  const type = act.type || 'EVENT';
  const title = shortText(act.title || act.slug || '', 48);
  let extra = '';
  if (act.amount) extra += ` ${formatPnL(act.amount)}`;
  if (act.shares && act.price) extra += ` ${formatDecimal(act.shares)} @ ${formatPrice(act.price, true)}`;
  if (act.side) extra += ` ${formatSide(act.side)}`;
  const when = act.timestamp ? ` • ${formatDate(act.timestamp)}` : '';
  return `📜 **${type}** — ${title}${extra}${when}`;
}

export async function runTrackerOnce(config: TrackerConfig): Promise<void> {
  const wallets = getAllActiveWallets();
  if (wallets.length === 0) return;

  for (const wallet of wallets) {
    const snapshot = await fetchWalletSnapshot(wallet.address);

    const positions = snapshot.positions.slice(0, config.maxItems);
    const trades = snapshot.trades.slice(0, config.maxItems);
    const activity = snapshot.activity.slice(0, config.maxItems);

    const positionsHash = hashState(positions);
    const activityHash = hashState(activity);

    const prev = prevSnapshots.get(wallet.address);

    const isFirstRun = !prev && (wallet.last_positions_hash == null && wallet.last_activity_hash == null);

    if (!isFirstRun && prev) {
      // Positions diff
      if (positionsHash !== wallet.last_positions_hash) {
        const newlyOpened = detectNewPositions(prev.positions, positions);
        const newlyClosed = detectClosedPositions(prev.positions, positions);

        for (const p of newlyOpened) {
          recordEvent(wallet.address, 'position_new', p);
        }
        for (const p of newlyClosed) {
          recordEvent(wallet.address, 'position_closed', p);
        }
      }

      // Activity diff
      if (activityHash !== wallet.last_activity_hash) {
        const newActs = detectNewActivity(prev.activity, activity);
        for (const a of newActs.slice(0, 6)) {
          recordEvent(wallet.address, 'activity', a);
        }

        // Also surface new trades
        const newTrades = detectNewTrades(prev.trades, trades);
        for (const t of newTrades.slice(0, 5)) {
          recordEvent(wallet.address, 'trade', t);
        }
      }
    }

    // Store current snapshot in memory
    prevSnapshots.set(wallet.address, { positions, activity, trades });

    // Persist hashes to DB for restart resilience
    updateWalletHashes(wallet.address, positionsHash, activityHash);
  }

  // Dispatch notifications for any recorded events
  const pending = getUnnotifiedEvents();
  if (pending.length > 0) {
    for (const ev of pending) {
      try {
        const data = JSON.parse(ev.event_data);
        let msg = '';

        if (ev.event_type === 'trade') {
          msg = formatTrade(data);
        } else if (ev.event_type === 'activity') {
          msg = formatActivity(data);
        } else if (ev.event_type === 'position_new') {
          msg = formatPositionChange('new', data);
        } else if (ev.event_type === 'position_closed') {
          msg = formatPositionChange('closed', data);
        } else {
          msg = `📌 ${ev.event_type}`;
        }

        const w = getWalletByAddress(ev.wallet_address);
        const display = w ? `**${w.name}** (${truncateAddress(ev.wallet_address)})` : `Wallet ${truncateAddress(ev.wallet_address)}`;
        await config.sendNotification(`${display}\n${msg}`);
      } catch {
        // ignore malformed
      }
    }
    markEventsNotified(pending.map(e => e.id));
  }
}

export async function startTracker(config: TrackerConfig): Promise<void> {
  if (running) return;
  running = true;

  // eslint-disable-next-line no-constant-condition
  while (running) {
    try {
      await runTrackerOnce(config);
    } catch (err) {
      // Keep running even if a poll fails
      console.error('[tracker] poll error:', err);
    }
    await sleep(config.intervalMs);
  }
}

export function stopTracker(): void {
  running = false;
}

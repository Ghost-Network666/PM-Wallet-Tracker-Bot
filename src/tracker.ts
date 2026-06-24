import { getAllActiveWallets, updateWalletHashes, recordEvent, getUnnotifiedEvents, markEventsNotified, getWalletByAddress, getWalletSettings, hasSeenMarket, markMarketSeen, hasEventWithTx, hasSeenEvent } from './db.js';
import { fetchWalletSnapshot } from './polymarket.js';
import { hashState, shortText, sleep, formatPnL, formatSide, formatDate, formatPrice, truncateAddress, formatDecimal, getEventDedupKey } from './utils.js';
import type { PriceWatcher } from './price-watcher.js';

function buildLinks(data: any): string {
  const pm = data.url;
  const tx = data.transactionHash ? `https://polygonscan.com/tx/${data.transactionHash}` : '';
  return [pm ? `[🔗 Polymarket](${pm})` : '', tx ? `[⛓️ on-chain](${tx})` : '']
    .filter(Boolean)
    .join(' • ') || 'N/A';
}
import { EmbedBuilder } from 'discord.js';

export interface TrackerConfig {
  intervalMs: number;
  sendNotification: (payload: string | any) => Promise<void>;
  maxItems: number;
  priceWatcher?: PriceWatcher;
}

let running = false;

export let trackingIntervalMs = 10000;

export function setTrackingInterval(ms: number) {
  trackingIntervalMs = Math.max(5000, ms); // minimum 5s to avoid abuse/rate limits
}

export function getTrackingInterval() {
  return trackingIntervalMs;
}

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

function getActionEmoji(type: string): string {
  if (type.includes('trade') || type === 'TRADE') return '📈';
  if (type.includes('buy') || type === 'BUY') return '📈';
  if (type.includes('sell') || type === 'SELL') return '📉';
  if (type.includes('split') || type === 'SPLIT') return '🔄';
  if (type.includes('merge') || type === 'MERGE') return '🔄';
  if (type.includes('redeem') || type === 'REDEEM') return '💰';
  if (type.includes('transfer') || type === 'TRANSFER') return '📤';
  if (type.includes('cancel') || type === 'CANCEL') return '❌';
  if (type.includes('first') || type === 'FIRST_TIME') return '🆕';
  return '📌';
}

function getColorForType(type: string): number {
  if (type.includes('buy') || type.includes('new') || type.includes('redeem')) return 0x00ff00;
  if (type.includes('sell') || type.includes('closed')) return 0xff0000;
  return 0xaaaaaa;
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
  const prevKeys = new Set(prev.map(t => getEventDedupKey(t, 'trade')));
  return current.filter(t => !prevKeys.has(getEventDedupKey(t, 'trade')));
}

function detectNewActivity(prev: any[], current: any[]): any[] {
  const prevKeys = new Set(prev.map(a => getEventDedupKey(a, 'activity')));
  return current.filter(a => !prevKeys.has(getEventDedupKey(a, 'activity')));
}

function fieldForPositionChange(type: 'new' | 'closed', pos: any): { name: string; value: string } {
  const emoji = type === 'new' ? '🟢' : '🔴';
  const label = type === 'new' ? 'New Position' : 'Position Closed';
  const title = shortText(pos.title || pos.slug || 'Unknown market', 90);
  const outcome = pos.outcome ? ` (${pos.outcome})` : '';
  const parts: string[] = [];
  if (pos.size) parts.push(`Size: ${formatDecimal(pos.size)}`);
  if (pos.avgPrice) parts.push(`Avg ${formatPrice(pos.avgPrice, true)}`);
  if (pos.curPrice) parts.push(`Cur ${formatPrice(pos.curPrice, true)}`);
  if (pos.cashPnl != null) parts.push(`PnL: ${formatPnL(pos.cashPnl)}`);
  return {
    name: `${emoji} ${label} — ${title}${outcome}`,
    value: `${parts.join(' • ') || '—'}\n${buildLinks(pos)}`,
  };
}

function fieldForActivity(data: any): { name: string; value: string } {
  const niceType = (data.type || 'EVENT').toUpperCase();
  const emoji = getActionEmoji(niceType);
  const title = shortText(data.title || data.slug || (niceType === 'MAKER_REBATE' ? 'Maker Rebate' : 'Unknown market'), 90);
  const parts: string[] = [];
  if (data.amount) parts.push(formatPnL(data.amount));
  if (data.side && data.size && data.price) {
    const prob = (parseFloat(data.price) * 100).toFixed(2);
    parts.push(`${formatDecimal(data.size)} @ ${formatPrice(data.price, true)} (${prob}%) ${formatSide(data.side)}`);
  }
  const time = data.timestamp ? formatDate(data.timestamp) : '';
  return {
    name: `${emoji} ${niceType} — ${title}`,
    value: `${parts.join(' • ') || '—'}\n${[time, buildLinks(data)].filter(Boolean).join(' • ')}`,
  };
}

function fieldForTrade(data: any): { name: string; value: string } {
  const side = formatSide(data.side);
  const title = shortText(data.title || data.slug || 'Unknown market', 90);
  const outcome = data.outcome ? ` (${data.outcome})` : '';
  let detail = '—';
  if (data.size && data.price) {
    const value = parseFloat(data.size) * parseFloat(data.price);
    const prob = (parseFloat(data.price) * 100).toFixed(2);
    detail = `${side} ${formatDecimal(data.size)} @ ${formatPrice(data.price, true)} (${prob}%) ≈ ${formatPnL(value).replace(/^[^\$]+/, '')}`;
  }
  const time = data.timestamp ? formatDate(data.timestamp) : '';
  return {
    name: `📈 TRADE — ${title}${outcome}`,
    value: `${detail}\n${[time, buildLinks(data)].filter(Boolean).join(' • ')}`,
  };
}

function fieldForFirstTime(data: any): { name: string; value: string } {
  const title = shortText(data.title || data.slug || 'Unknown market', 90);
  const time = data.timestamp ? formatDate(data.timestamp) : '';
  return {
    name: `🆕 FIRST TIME — ${title}`,
    value: `${[time, buildLinks(data)].filter(Boolean).join(' • ')}`,
  };
}

export async function runTrackerOnce(config: TrackerConfig): Promise<void> {
  const wallets = getAllActiveWallets();
  if (wallets.length === 0) {
    // console.log('[tracker] No wallets to monitor.');
    return;
  }
  console.log(`[tracker] Polling ${wallets.length} wallet(s) using official @polymarket/client SDK...`);

  for (const wallet of wallets) {
    const snapshot = await fetchWalletSnapshot(wallet.address);

    // Push current open positions into the PriceWatcher so it can subscribe to their
    // tokenIds and fire market_resolved notifications via WSS (wins and losses).
    if (config.priceWatcher) {
      config.priceWatcher.updateWalletPositions(wallet.address, wallet.name, snapshot.positions);
    }

    const positions = snapshot.positions.slice(0, config.maxItems);
    const trades = snapshot.trades.slice(0, config.maxItems);
    const activity = snapshot.activity.slice(0, config.maxItems);

    const positionsHash = hashState(positions);
    const activityHash = hashState(activity);

    const prev = prevSnapshots.get(wallet.address);

    const settings = getWalletSettings(wallet.address) || { min_size: 0, side_filter: 'ALL', notify_first_time: 1 };
    const s = settings as any;

    // --- Positions: use snapshot diff when we have a prev baseline ---
    if (positionsHash !== wallet.last_positions_hash && prev) {
      const newlyOpened = detectNewPositions(prev.positions, positions);
      const newlyClosed = detectClosedPositions(prev.positions, positions);

      for (const p of newlyOpened) {
        const key = getEventDedupKey(p, 'position');
        if (hasSeenEvent(wallet.address, key)) continue;
        recordEvent(wallet.address, 'position_new', p, key);
      }
      for (const p of newlyClosed) {
        const key = getEventDedupKey(p, 'position');
        if (hasSeenEvent(wallet.address, key)) continue;
        recordEvent(wallet.address, 'position_closed', p, key);
      }
    }

    // --- Activity & Trades: ALWAYS vet recent items from SDK against DB dedup keys ---
    // This is resilient across restarts, hash jitter, and in-mem loss.
    // Old history was backfilled as notified on /add, so only genuinely new items pass.
    {
      // Activities (incl. REDEEM, MAKER_REBATE, and some TRADEs)
      const candidates = detectNewActivity(prev ? prev.activity : [], activity);
      const toConsider = (candidates.length > 0 ? candidates : activity).slice(0, 8);
      for (const a of toConsider) {
        const key = getEventDedupKey(a, 'activity');
        if (hasSeenEvent(wallet.address, key)) continue;
        // Legacy tx check
        if (a.transactionHash && hasEventWithTx(wallet.address, a.transactionHash)) continue;

        // Respect min_size / impact filter for activity (MAKER_REBATE etc often tiny noise)
        const amt = parseFloat(a.amount || a.shares || '0') || 0;
        if (s.min_size > 0 && Math.abs(amt) < s.min_size) continue;
        const typUpper = (a.type || '').toUpperCase();
        if (typUpper === 'MAKER_REBATE' && Math.abs(amt) < Math.max(50, s.min_size || 0)) continue;

        // Prefer dedicated 'trade' notifications for TRADE typed items (avoid near-dupe with trade list)
        if (typUpper === 'TRADE') {
          // still allow first_time for it, but don't create separate 'activity' record
          const slug = a.slug;
          if (s.notify_first_time && slug && !hasSeenMarket(wallet.address, slug)) {
            const ftKey = getEventDedupKey({ ...a, slug }, 'first_time');
            if (!hasSeenEvent(wallet.address, ftKey)) {
              recordEvent(wallet.address, 'first_time', { ...a, slug }, ftKey);
            }
            markMarketSeen(wallet.address, slug);
          }
          continue; // let trades list produce the 'trade' record
        }

        const slug = a.slug;
        const isMakerRebate = (a.type || '').toUpperCase() === 'MAKER_REBATE';
        if (s.notify_first_time && slug && !hasSeenMarket(wallet.address, slug) && !isMakerRebate) {
          const ftKey = getEventDedupKey({ ...a, slug }, 'first_time');
          if (!hasSeenEvent(wallet.address, ftKey)) {
            recordEvent(wallet.address, 'first_time', { ...a, slug }, ftKey);
          }
          markMarketSeen(wallet.address, slug);
        }
        if (!isMakerRebate || Math.abs(parseFloat(a.amount || '0')) >= 50) {
          recordEvent(wallet.address, 'activity', a, key);
        }
      }
    }

    {
      // Trades (deduped by key so no double with activity TRADE items)
      const candidates = detectNewTrades(prev ? prev.trades : [], trades);
      const toConsider = (candidates.length > 0 ? candidates : trades).slice(0, 6);
      for (const t of toConsider) {
        const key = getEventDedupKey(t, 'trade');
        if (hasSeenEvent(wallet.address, key)) continue;
        if (t.transactionHash && hasEventWithTx(wallet.address, t.transactionHash)) continue;
        if (s.min_size > 0 && parseFloat(t.size || '0') < s.min_size) continue;
        if (s.side_filter !== 'ALL' && t.side !== s.side_filter) continue;

        const slug = t.slug;
        if (s.notify_first_time && slug && !hasSeenMarket(wallet.address, slug)) {
          const ftKey = getEventDedupKey({ ...t, slug }, 'first_time');
          if (!hasSeenEvent(wallet.address, ftKey)) {
            recordEvent(wallet.address, 'first_time', { ...t, slug }, ftKey);
          }
          markMarketSeen(wallet.address, slug);
        }
        recordEvent(wallet.address, 'trade', t, key);
      }
    }

    // Store current snapshot in memory (for next diff)
    prevSnapshots.set(wallet.address, { positions, activity, trades });

    // Persist hashes to DB for restart resilience
    updateWalletHashes(wallet.address, positionsHash, activityHash);
  }

  // Dispatch notifications for any recorded events
  // BATCHED: one rich embed per wallet per cycle. Using embeds (not raw links in plain text)
  // avoids Discord auto-unfurling every polygonscan tx link into its own giant preview card.
  const pending = getUnnotifiedEvents();
  if (pending.length > 0) {
    console.log(`[tracker] Detected ${pending.length} change event(s) - sending batched notifications...`);

    const byWallet = new Map<string, typeof pending>();
    for (const ev of pending) {
      if (!byWallet.has(ev.wallet_address)) byWallet.set(ev.wallet_address, []);
      byWallet.get(ev.wallet_address)!.push(ev);
    }

    const MAX_FIELDS = 10;

    for (const [addr, evs] of byWallet.entries()) {
      const w = getWalletByAddress(addr);
      const short = truncateAddress(addr);
      const displayName = w && w.name && !w.name.startsWith('Unnamed') ? w.name : short;

      const fields: { name: string; value: string }[] = [];
      let overflowCount = 0;
      let compositeType = '';

      for (const ev of evs) {
        try {
          const data = JSON.parse(ev.event_data);
          compositeType += ` ${ev.event_type} ${data.side || ''}`;

          if (fields.length >= MAX_FIELDS) {
            overflowCount++;
            continue;
          }

          let field: { name: string; value: string };
          if (ev.event_type === 'position_new' || ev.event_type === 'position_closed') {
            field = fieldForPositionChange(ev.event_type === 'position_new' ? 'new' : 'closed', { ...data, title: data.title || data.slug });
          } else if (ev.event_type === 'trade') {
            field = fieldForTrade(data);
          } else if (ev.event_type === 'activity') {
            field = fieldForActivity(data);
          } else if (ev.event_type === 'first_time') {
            field = fieldForFirstTime(data);
          } else {
            field = { name: `📌 ${ev.event_type.toUpperCase()}`, value: '—' };
          }
          fields.push(field);
        } catch {
          // ignore malformed event payloads
        }
      }

      if (overflowCount > 0) {
        fields.push({
          name: `➕ ${overflowCount} more update${overflowCount > 1 ? 's' : ''}`,
          value: `Use \`/wallet-stats\` for the full history.`,
        });
      }

      if (fields.length === 0) continue;

      const embed = new EmbedBuilder()
        .setTitle(`${displayName}${displayName !== short ? ` (${short})` : ''}`)
        .setColor(getColorForType(compositeType.toLowerCase()))
        .addFields(fields)
        .setFooter({ text: `via official @polymarket/client SDK • ${evs.length} update${evs.length > 1 ? 's' : ''}` })
        .setTimestamp();

      try {
        await config.sendNotification({ embeds: [embed] });
      } catch (e) {
        console.error('[tracker] batch send error for', addr, e);
      }
    }

    markEventsNotified(pending.map(e => e.id));
  }
}

export async function startTracker(config: TrackerConfig): Promise<void> {
  if (running) return;
  running = true;

  if (config.intervalMs) {
    trackingIntervalMs = config.intervalMs;
  }

  // eslint-disable-next-line no-constant-condition
  while (running) {
    try {
      await runTrackerOnce(config);
    } catch (err) {
      // Keep running even if a poll fails
      console.error('[tracker] poll error:', err);
    }
    await sleep(trackingIntervalMs);
  }
}

export function stopTracker(): void {
  running = false;
}

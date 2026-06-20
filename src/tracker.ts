import { getAllActiveWallets, updateWalletHashes, recordEvent, getUnnotifiedEvents, markEventsNotified, getWalletByAddress, getWalletSettings, hasSeenMarket, markMarketSeen, hasEventWithTx, hasSeenEvent } from './db.js';
import { fetchWalletSnapshot, getCachedMarket } from './polymarket.js';
import { hashState, shortText, sleep, formatPnL, formatSide, formatDate, formatPrice, truncateAddress, formatDecimal, getEventDedupKey } from './utils.js';
import { EmbedBuilder } from 'discord.js';

export interface TrackerConfig {
  intervalMs: number;
  sendNotification: (payload: string | any) => Promise<void>;
  maxItems: number;
}

let running = false;

// In-memory previous snapshots for reliable diffing (keyed by normalized address)
const prevSnapshots = new Map<string, { positions: any[]; activity: any[]; trades: any[] }>();

const resolvedAlerted = new Set<string>();

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

export async function runTrackerOnce(config: TrackerConfig): Promise<void> {
  const wallets = getAllActiveWallets();
  if (wallets.length === 0) {
    // console.log('[tracker] No wallets to monitor.');
    return;
  }
  console.log(`[tracker] Polling ${wallets.length} wallet(s) using official @polymarket/client SDK...`);

  for (const wallet of wallets) {
    const snapshot = await fetchWalletSnapshot(wallet.address);

    // Resolution predictor (pre-emptive PnL)
    for (const pos of snapshot.positions || []) {
      const slug = pos.slug;
      if (slug) {
        try {
          const market = await getCachedMarket({ slug });
          const isResolved = market.resolution && (market.resolution.resolved || (market.state && market.state.resolved));
          if (isResolved) {
            const key = `${wallet.address}:${slug}`;
            if (!resolvedAlerted.has(key)) {
              const avg = parseFloat(pos.avgPrice || '0');
              const sz = parseFloat(pos.size || '0');
              const est = sz * (1 - avg);
              const emoji = est > 0 ? '🟢' : '🔴';
              const resEmbed = new EmbedBuilder()
                .setTitle(`🏆 Market Resolved!`)
                .setDescription(`**${market.question || pos.title}** resolved.`)
                .addFields(
                  { name: 'Wallet Position', value: `${formatDecimal(sz)} @ ${formatPrice(avg, true)}`, inline: false },
                  { name: 'Est. if redeem now', value: `${emoji} ${formatPnL(est)}` }
                )
                .setFooter({ text: 'Pre-emptive alert via official SDK' });
              await config.sendNotification({ embeds: [resEmbed] });
              resolvedAlerted.add(key);
            }
          }
        } catch {}
      }
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
        if (s.notify_first_time && slug && !hasSeenMarket(wallet.address, slug)) {
          const ftKey = getEventDedupKey({ ...a, slug }, 'first_time');
          if (!hasSeenEvent(wallet.address, ftKey)) {
            recordEvent(wallet.address, 'first_time', { ...a, slug }, ftKey);
          }
          markMarketSeen(wallet.address, slug);
        }
        recordEvent(wallet.address, 'activity', a, key);
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
  // BATCHED: group by wallet and send fewer messages (big reduction in channel flood)
  const pending = getUnnotifiedEvents();
  if (pending.length > 0) {
    console.log(`[tracker] Detected ${pending.length} change event(s) - sending batched notifications...`);

    const byWallet = new Map<string, typeof pending>();
    for (const ev of pending) {
      if (!byWallet.has(ev.wallet_address)) byWallet.set(ev.wallet_address, []);
      byWallet.get(ev.wallet_address)!.push(ev);
    }

    for (const [addr, evs] of byWallet.entries()) {
      const w = getWalletByAddress(addr);
      const short = truncateAddress(addr);
      const displayBase = w ? (w.name && w.name.includes('...') ? w.name : `${w.name}`) : short;

      const embeds: any[] = [];
      const plainMessages: string[] = [];

      for (const ev of evs) {
        try {
          const data = JSON.parse(ev.event_data);
          let display = w ? `**${displayBase}** (${short})` : `Wallet ${short}`;
          if (w && w.name.includes('...')) display = `**${displayBase}**`;

          let title = `${getActionEmoji(ev.event_type)} ${ev.event_type.toUpperCase()} for ${display}`;
          if (ev.event_type === 'first_time') {
            title = `${getActionEmoji(ev.event_type)} FIRST TIME interaction for ${display}`;
          } else if (ev.event_type === 'position_new') {
            title = `${getActionEmoji(ev.event_type)} New position for ${display}`;
          } else if (ev.event_type === 'position_closed') {
            title = `${getActionEmoji(ev.event_type)} Position closed for ${display}`;
          }

          if (ev.event_type === 'position_new' || ev.event_type === 'position_closed') {
            const p = data;
            const msg = formatPositionChange(ev.event_type === 'position_new' ? 'new' : 'closed', { ...p, title: p.title || p.slug });
            const prefix = `${displayBase} (${short})`;
            plainMessages.push(`${prefix}\n${msg}`);
            continue;
          }

          const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(getColorForType(ev.event_type))
            .setTimestamp();

          if (ev.event_type === 'trade') {
            const t = data;
            const value = (t.size && t.price) ? parseFloat(t.size) * parseFloat(t.price) : 0;
            embed.addFields(
              { name: 'Market', value: t.title || 'Unknown', inline: false },
              { name: 'Outcome', value: t.outcome || 'N/A', inline: true },
              { name: 'Details', value: `${formatSide(t.side)} ${formatDecimal(t.size)} @ ${formatPrice(t.price, true)} (value ≈ ${formatPnL(value)})`, inline: true },
              { name: 'Link', value: t.transactionHash ? `[🔗 on-chain](https://polygonscan.com/tx/${t.transactionHash})` : 'N/A' }
            );
            embeds.push(embed);
          } else if (ev.event_type === 'activity') {
            const a = data;
            const niceType = (a.type || 'EVENT').toUpperCase();
            title = `${getActionEmoji(niceType)} ${niceType} for ${display}`;
            const amt = a.amount ? formatPnL(a.amount) : '';
            embed.setTitle(title); // refresh with better type
            embed.addFields(
              { name: 'Market', value: a.title || 'Unknown', inline: false },
              { name: 'Impact', value: amt, inline: true },
              { name: 'Link', value: a.transactionHash ? `[🔗 on-chain](https://polygonscan.com/tx/${a.transactionHash})` : 'N/A' }
            );
            embeds.push(embed);
          } else if (ev.event_type === 'first_time') {
            const a = data;
            embed.addFields(
              { name: 'Market', value: a.title || a.slug || 'Unknown', inline: false },
              { name: 'Type', value: a.type || 'first_time', inline: true },
              { name: 'Link', value: a.transactionHash ? `[🔗 on-chain](https://polygonscan.com/tx/${a.transactionHash})` : 'N/A' }
            );
            embeds.push(embed);
          } else {
            embed.setDescription(`📌 ${ev.event_type}`);
            embeds.push(embed);
          }
        } catch {
          // ignore malformed
        }
      }

      // Send batched for this wallet (much less spam than one msg per event)
      try {
        if (plainMessages.length > 0) {
          for (const m of plainMessages) {
            await config.sendNotification(m);
          }
        }
        if (embeds.length > 0) {
          // Send as single message with up to 10 embeds + optional header
          const header = embeds.length > 1 ? `**${displayBase}** — ${embeds.length} updates` : undefined;
          const toSend = { ...(header ? { content: header } : {}), embeds: embeds.slice(0, 10) };
          await config.sendNotification(toSend);
          // If more than 10 (rare), fall back to additional
          if (embeds.length > 10) {
            await config.sendNotification({ embeds: embeds.slice(10, 20) });
          }
        }
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

import { getAllActiveWallets, updateWalletHashes, recordEvent, getUnnotifiedEvents, markEventsNotified, getWalletByAddress, getWalletSettings, hasSeenMarket, markMarketSeen, hasEventWithTx, hasSeenEvent } from './db.js';
import { fetchWalletSnapshot, getCachedMarket } from './polymarket.js';
import { hashState, shortText, sleep, formatPnL, formatSide, formatDate, formatPrice, truncateAddress, formatDecimal, getEventDedupKey } from './utils.js';

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
  const linkPart = buildLinks(pos) !== 'N/A' ? ` | ${buildLinks(pos)}` : '';
  return `${emoji} ${label}: ${title}${outcome}${size}${avg}${cur}${pnl}${linkPart}`;
}

function formatCompactActivity(data: any): string {
  const niceType = (data.type || 'EVENT').toUpperCase();
  const emoji = getActionEmoji(niceType);
  const title = shortText(data.title || data.slug || (niceType === 'MAKER_REBATE' ? 'Maker Rebate' : 'Unknown market'), 50);
  let extra = data.amount ? ` ${formatPnL(data.amount)}` : '';
  if (data.side && data.size && data.price) {
    const prob = (parseFloat(data.price) * 100).toFixed(2);
    extra += ` ${formatDecimal(data.size)} @ ${formatPrice(data.price, true)} (${prob}%) ${formatSide(data.side)}`;
  }
  const time = data.timestamp ? ` • ${formatDate(data.timestamp)}` : '';
  const links = buildLinks(data) !== 'N/A' ? ` ${buildLinks(data)}` : '';
  return `${emoji} ${niceType} — ${title}${extra}${time}${links}`;
}

function formatCompactTrade(data: any): string {
  const side = formatSide(data.side);
  const title = shortText(data.title || data.slug || 'Unknown market', 50);
  const outcome = data.outcome ? ` ${data.outcome}` : '';
  let extra = '';
  if (data.size && data.price) {
    const value = parseFloat(data.size) * parseFloat(data.price);
    const prob = (parseFloat(data.price) * 100).toFixed(2);
    extra = ` ${formatDecimal(data.size)} @ ${formatPrice(data.price, true)} (${prob}%) (≈ ${formatPnL(value).replace(/^[^\$]+/, '')}) ${side}`;
  }
  const time = data.timestamp ? ` • ${formatDate(data.timestamp)}` : '';
  const links = buildLinks(data) !== 'N/A' ? ` ${buildLinks(data)}` : '';
  return `📈 TRADE — ${title}${outcome}${extra}${time}${links}`;
}

function formatCompactFirstTime(data: any): string {
  const title = shortText(data.title || data.slug || 'Unknown market', 50);
  const time = data.timestamp ? ` • ${formatDate(data.timestamp)}` : '';
  const links = buildLinks(data) !== 'N/A' ? ` ${buildLinks(data)}` : '';
  return `🆕 FIRST TIME — ${title}${time}${links}`;
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
              let marketData: any = null;
              if (!pos.url && pos.slug) {
                marketData = await getCachedMarket({ slug: pos.slug }).catch(() => null);
              }
              const pm: string = String(pos.url || (marketData && marketData.url) || '');
              const resEmbed = new EmbedBuilder()
                .setTitle(`🏆 Market Resolved!`)
                .setDescription(`**${market.question || pos.title}** resolved.`)
                .addFields(
                  { name: 'Wallet Position', value: `${formatDecimal(sz)} @ ${formatPrice(avg, true)}`, inline: false },
                  { name: 'Est. if redeem now', value: `${emoji} ${formatPnL(est)}` },
                  { name: 'Links', value: pm ? `[🔗 Polymarket](${pm})` : 'N/A' }
                )
                .setFooter({ text: 'via official @polymarket/client SDK' });
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

      const plainMessages: string[] = [];

      for (const ev of evs) {
        try {
          const data = JSON.parse(ev.event_data);
          const prefix = w && w.name && w.name.startsWith('Unnamed') ? short : `${displayBase} (${short})`;

          let msg = '';
          if (ev.event_type === 'position_new' || ev.event_type === 'position_closed') {
            const p = data;
            msg = formatPositionChange(ev.event_type === 'position_new' ? 'new' : 'closed', { ...p, title: p.title || p.slug });
          } else if (ev.event_type === 'trade') {
            msg = formatCompactTrade(data);
          } else if (ev.event_type === 'activity') {
            msg = formatCompactActivity(data);
          } else if (ev.event_type === 'first_time') {
            msg = formatCompactFirstTime(data);
          } else {
            msg = `📌 ${ev.event_type.toUpperCase()}`;
          }

          plainMessages.push(`${prefix}\n${msg}`);
        } catch {
          // ignore malformed
        }
      }

      // Send batched for this wallet as clean compact text (one message per wallet for skimmability)
      try {
        if (plainMessages.length > 0) {
          const header = plainMessages.length > 1 ? `**${displayBase}** — ${plainMessages.length} updates` : '';
          const body = plainMessages.join('\n\n');
          const fullMsg = header ? `${header}\n${body}` : body;
          await config.sendNotification(fullMsg.length > 1900 ? fullMsg.slice(0, 1900) + '…' : fullMsg);
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

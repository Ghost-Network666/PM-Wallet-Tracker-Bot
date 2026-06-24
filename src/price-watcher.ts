import WebSocket from 'ws';
import { EmbedBuilder } from 'discord.js';
import type { PositionData } from './polymarket.js';
import { formatPnL, formatDecimal, formatPrice, truncateAddress } from './utils.js';

interface PositionEntry {
  walletAddress: string;
  walletName: string;
  position: PositionData;
}

const WSS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class PriceWatcher {
  private ws: WebSocket | null = null;
  private dead = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;

  // tokenId -> entries (one per wallet that holds this token)
  private registry = new Map<string, PositionEntry[]>();
  // tokenId -> live mid-price
  private prices = new Map<string, number>();
  // dedup resolved alerts (walletAddress:tokenId)
  private resolvedAlerted = new Set<string>();

  private sendNotification: (payload: any) => Promise<void>;

  constructor(sendNotification: (payload: any) => Promise<void>) {
    this.sendNotification = sendNotification;
  }

  getLivePrice(tokenId: string): number | null {
    return this.prices.get(tokenId) ?? null;
  }

  updateWalletPositions(walletAddress: string, walletName: string, positions: PositionData[]) {
    // Drop old entries for this wallet
    for (const [tokenId, entries] of this.registry) {
      const kept = entries.filter(e => e.walletAddress !== walletAddress);
      if (kept.length === 0) this.registry.delete(tokenId);
      else this.registry.set(tokenId, kept);
    }

    const toSubscribe: string[] = [];
    for (const pos of positions) {
      if (!pos.tokenId) continue;
      const entry: PositionEntry = { walletAddress, walletName, position: pos };
      if (!this.registry.has(pos.tokenId)) {
        this.registry.set(pos.tokenId, []);
        toSubscribe.push(pos.tokenId);
      }
      this.registry.get(pos.tokenId)!.push(entry);
    }

    if (toSubscribe.length > 0) {
      this.subscribe(toSubscribe);
    }
  }

  connect() {
    if (this.dead) return;
    console.log('[price-watcher] Connecting to Market Channel WSS...');
    this.ws = new WebSocket(WSS_URL);

    this.ws.on('open', () => {
      console.log('[price-watcher] Connected');
      this.reconnectDelay = 1000;

      // Re-subscribe to all tracked tokenIds on reconnect
      const all = [...this.registry.keys()];
      if (all.length > 0) this.subscribe(all);

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('PING');
      }, PING_INTERVAL_MS);
    });

    this.ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      try {
        const parsed = JSON.parse(text);
        const msgs: any[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of msgs) this.handleMessage(msg);
      } catch {}
    });

    this.ws.on('close', (code) => {
      console.log(`[price-watcher] Disconnected (${code}), reconnecting...`);
      this.clearTimers();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[price-watcher] Error:', err.message);
      this.clearTimers();
      this.ws?.terminate();
      this.scheduleReconnect();
    });
  }

  private subscribe(tokenIds: string[]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'market',
      assets_ids: tokenIds,
      custom_feature_enabled: true,
    }));
    console.log(`[price-watcher] Subscribed to ${tokenIds.length} token(s)`);
  }

  private handleMessage(msg: any) {
    const tokenId: string | undefined = msg.asset_id;
    if (!tokenId) return;

    switch (msg.event_type) {
      case 'price_change':
      case 'last_trade_price':
        if (msg.price != null) this.prices.set(tokenId, parseFloat(msg.price));
        break;

      case 'best_bid_ask': {
        const bid = msg.bid != null ? parseFloat(msg.bid) : null;
        const ask = msg.ask != null ? parseFloat(msg.ask) : null;
        if (bid != null && ask != null) this.prices.set(tokenId, (bid + ask) / 2);
        else if (bid != null) this.prices.set(tokenId, bid);
        else if (ask != null) this.prices.set(tokenId, ask);
        break;
      }

      case 'market_resolved': {
        const entries = this.registry.get(tokenId);
        if (!entries) break;
        for (const entry of entries) {
          const key = `${entry.walletAddress}:${tokenId}`;
          if (this.resolvedAlerted.has(key)) continue;
          this.resolvedAlerted.add(key);
          this.fireResolvedNotification(entry).catch(err =>
            console.error('[price-watcher] resolved notification error:', err)
          );
        }
        break;
      }
    }
  }

  private async fireResolvedNotification(entry: PositionEntry) {
    const { walletName, walletAddress, position: pos } = entry;
    const livePrice = pos.tokenId ? this.getLivePrice(pos.tokenId) : null;
    const avg = parseFloat(pos.avgPrice || '0');
    const sz = parseFloat(pos.size || '0');
    // Prefer live WSS price for settlement estimate; fall back to cashPnl
    const est = livePrice != null
      ? sz * livePrice - sz * avg
      : parseFloat(pos.cashPnl || '0') || 0;
    const emoji = est > 0 ? '🟢' : est < 0 ? '🔴' : '⚪';
    const displayName = walletName && !walletName.startsWith('Unnamed')
      ? walletName
      : truncateAddress(walletAddress);

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Market Resolved — ${displayName}`)
      .setDescription(`**${pos.title || pos.slug || 'Unknown market'}** has resolved.`)
      .addFields(
        { name: 'Position', value: `${pos.outcome || '—'} • ${formatDecimal(sz)} shares @ avg ${formatPrice(avg, true)}`, inline: false },
        { name: 'Est. P&L', value: `${emoji} ${formatPnL(est)}`, inline: true },
        ...(livePrice != null ? [{ name: 'Settlement Price', value: formatPrice(livePrice, true), inline: true }] : []),
        { name: 'Links', value: pos.url ? `[🔗 Polymarket](${pos.url})` : 'N/A', inline: false },
      )
      .setColor(est > 0 ? 0x00ff00 : est < 0 ? 0xff0000 : 0xaaaaaa)
      .setFooter({ text: 'via Polymarket Market Channel WSS' })
      .setTimestamp();

    await this.sendNotification({ embeds: [embed] });
  }

  private clearTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private scheduleReconnect() {
    if (this.dead) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this.connect();
    }, this.reconnectDelay);
  }

  destroy() {
    this.dead = true;
    this.clearTimers();
    this.ws?.terminate();
  }
}

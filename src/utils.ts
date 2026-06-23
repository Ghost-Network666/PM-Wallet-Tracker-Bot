import crypto from 'crypto';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export function isValidAddress(address: string): boolean {
  return ADDRESS_REGEX.test(address);
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function truncateAddress(address: string): string {
  if (!address) return '';
  const normalized = normalizeAddress(address);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

export function parseWalletIdentifier(identifier: string): { type: 'address' | 'url' | 'name'; value: string } {
  const trimmed = identifier.trim();

  // Strong priority for 0x addresses (on-chain verification)
  if (trimmed.toLowerCase().startsWith('0x')) {
    if (isValidAddress(trimmed)) {
      return { type: 'address', value: normalizeAddress(trimmed) };
    } else {
      // invalid 0x - will fail later with clear error
      return { type: 'name', value: trimmed };
    }
  }

  if (isValidAddress(trimmed)) {
    return { type: 'address', value: normalizeAddress(trimmed) };
  }

  // Support common Polymarket profile URL formats
  const urlMatch = trimmed.match(/polymarket\.com\/(?:@|profile\/)([a-zA-Z0-9_-]+)/i);
  if (urlMatch) {
    return { type: 'url', value: urlMatch[1] };
  }

  if (trimmed.startsWith('@')) {
    return { type: 'url', value: trimmed.slice(1) };
  }

  // Fallback treat as name (will try resolve as username via SDK)
  return { type: 'name', value: trimmed };
}

export function hashState(obj: unknown): string {
  const json = JSON.stringify(obj, Object.keys(obj as object).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

function toCompact(num: number): string {
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  let c: string;
  if (abs >= 1_000_000_000) c = (abs / 1e9).toFixed(1) + 'B';
  else if (abs >= 1_000_000) c = (abs / 1e6).toFixed(1) + 'M';
  else if (abs >= 10_000) c = Math.round(abs / 1e3) + 'k';
  else if (abs >= 1_000) c = (abs / 1e3).toFixed(1) + 'k';
  else c = abs.toFixed(2);
  return sign + c;
}

export function formatUsd(amount: string | number | null | undefined): string {
  if (amount == null) return '$0.00';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return '$0.00';
  return `$${toCompact(num)}`;
}

export function formatPnl(pnl: string | number | null | undefined): string {
  if (pnl == null) return '$0.00';
  const num = typeof pnl === 'string' ? parseFloat(pnl) : pnl;
  if (isNaN(num)) return '$0.00';
  const sign = num > 0 ? '+' : '';
  return `${sign}${formatUsd(num)}`;
}

export function shortText(text: string | null | undefined, max = 60): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** formatPrice for outcomes vs regular amounts */
export function formatPrice(price: number | string | null | undefined, isOutcomePrice = false): string {
  if (price == null) return '$0.00';
  const num = typeof price === 'string' ? parseFloat(price) : price;
  if (isNaN(num)) return '$0.00';
  if (isOutcomePrice && num < 1) {
    const pct = (num * 100).toFixed(2);
    const pStr = formatDecimal(num, 4);  // use improved decimal
    return `$${pStr} (${pct}%)`;
  }
  return `$${formatDecimal(num, 2)}`;
}

/** formatDecimal(123.456789) → 123.4568 ; 1000.0000 → 1000 ; 0.5000 → 0.5 */
export function formatDecimal(val: number | string | null | undefined, maxDecimals = 4): string {
  if (val == null) return '0';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '0';
  let s = num.toFixed(maxDecimals);
  // trim trailing zeros after decimal
  if (s.includes('.')) {
    s = s.replace(/\.?0+$/, '');
  }
  return s || '0';
}

/** formatPnL with emoji + compact for large values */
export function formatPnL(pnl: number | string | null | undefined): string {
  if (pnl == null) return '⚪ $0.00';
  const num = typeof pnl === 'string' ? parseFloat(pnl) : pnl;
  if (isNaN(num)) return '⚪ $0.00';
  const c = toCompact(num);
  if (num > 0) return `🟢 +$${c}`;
  if (num < 0) return `🔴 -$${c.replace(/^-/, '')}`;
  return '⚪ $0.00';
}

/** formatDate(timestamp) → 18 Jun 2026 14:32 UTC */
export function formatDate(ts: number | string | Date | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const day = d.getUTCDate();
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon} ${year} ${hh}:${mm} UTC`;
}

/** formatSide */
export function formatSide(side: string | null | undefined): string {
  const s = (side || '').toUpperCase();
  if (s === 'BUY') return '📈 BUY';
  if (s === 'SELL') return '📉 SELL';
  return s || '—';
}

/** Stable dedup key for activity/trade/position events. Prefers tx hash. */
export function getEventDedupKey(item: any, typeHint = ''): string {
  const tx = (item?.transactionHash || '').toString().toLowerCase().trim();
  if (/^0x[a-f0-9]{8,}$/.test(tx)) {
    return `tx:${tx}`;
  }
  // Stable key for positions using conditionId (no ts needed)
  if (item?.conditionId) {
    return `pos:${item.conditionId}:${item.outcomeIndex ?? ''}`;
  }
  const t = (item?.type || typeHint || 'EVENT').toString().toUpperCase();
  const ts = item?.timestamp ?? 0;
  const slug = (item?.slug || item?.title || '').toString().slice(0, 60);
  // Normalize numeric values for stable keys (avoid float/timestamp jitter)
  let val = (item?.amount ?? item?.size ?? item?.cashPnl ?? '').toString();
  const num = parseFloat(val);
  if (!isNaN(num)) val = num.toFixed(2);
  return `${t}:${ts}:${slug}:${val}`.slice(0, 180);
}

/**
 * Robustly extract numeric portfolio value from SDK response.
 * Handles different shapes returned by fetchPortfolioValue.
 */
export function getPortfolioValue(portfolioData: any): number {
  if (!portfolioData) return 0;
  if (Array.isArray(portfolioData) && portfolioData.length > 0) {
    const first = portfolioData[0];
    return parseFloat(first?.value || first?.totalValue || first?.portfolioValue || 0) || 0;
  }
  if (typeof portfolioData === 'object' && portfolioData !== null) {
    return parseFloat(portfolioData.value || portfolioData.totalValue || portfolioData.portfolioValue || 0) || 0;
  }
  return 0;
}

/** Centralized clean market title */
export function cleanMarketTitle(t: string | null | undefined): string {
  if (!t) return 'Unknown market';
  return t.replace(/\s+/g, ' ').trim();
}

/** Format open positions for rich embeds (used in add/stats) */
export function formatPositionsForEmbed(positions: any[]): string {
  if (!positions || positions.length === 0) {
    return 'No open positions. Recent activity shows these positions were redeemed (see Activity for realized PnL).';
  }
  return positions.slice(0, 5).map((p: any) => {
    const title = cleanMarketTitle(p.title || p.slug || 'Market');
    const outcome = p.outcome ? ` **${p.outcome}**` : '';
    const size = p.size ? `Size: **${formatDecimal(p.size)}**` : '';
    const avg = p.avgPrice ? ` | Avg: ${formatPrice(p.avgPrice, true)}` : '';
    const cur = p.curPrice ? ` | Cur: ${formatPrice(p.curPrice, true)}` : '';
    const pnl = p.cashPnl != null ? `\n**PnL:** ${formatPnL(p.cashPnl)}` : '';
    const realized = p.realizedPnl != null ? ` (Realized ${formatPnL(p.realizedPnl)})` : '';
    return `• **${title}**${outcome}\n  ${size}${avg}${cur}${pnl}${realized}`;
  }).join('\n\n');
}

/** Format trades for rich embeds */
export function formatTradesForEmbed(trades: any[]): string {
  if (!trades || trades.length === 0) return 'No recent trades';
  return trades.slice(0, 5).map((t: any) => {
    const side = formatSide(t.side);
    const title = cleanMarketTitle(t.title || 'Market');
    const outcome = t.outcome ? ` | **Outcome: ${t.outcome}**` : '';
    const shares = t.size ? `**${formatDecimal(t.size)}** shares` : '';
    const p = t.price ? parseFloat(t.price) : 0;
    const priceStr = t.price ? ` @ $${formatDecimal(p, 4)}` : '';
    const prob = t.price ? ` (${(p * 100).toFixed(2)}% prob)` : '';
    const value = (t.size && t.price) ? ` (≈ ${formatPnL(parseFloat(t.size) * p).replace(/^[^\$]+/, '')})` : '';
    const link = t.transactionHash ? ` [🔗 on-chain](https://polygonscan.com/tx/${t.transactionHash})` : '';
    return `• ${side} ${title}${outcome} ${shares}${priceStr}${prob}${value}${link}`;
  }).join('\n');
}

/** Format activity for rich embeds */
export function formatActivityForEmbed(activity: any[]): string {
  if (!activity || activity.length === 0) return 'No recent activity';
  const typeMap: Record<string, string> = {
    'MAKER_REBATE': 'Maker Rebate',
    'REDEEM': 'Redeem',
    'TRADE': 'Trade',
    'REWARD': 'Reward',
    'SPLIT': 'Split',
    'MERGE': 'Merge'
  };
  return activity.slice(0, 6).map((a: any) => {
    const rawType = a.type || 'EVENT';
    const type = typeMap[rawType] || rawType;
    const title = cleanMarketTitle(a.title || a.slug || '');
    const extra = a.amount ? ` ${formatPnL(a.amount)}` : '';
    const link = a.transactionHash ? ` [🔗 on-chain](https://polygonscan.com/tx/${a.transactionHash})` : '';
    return `• **${type}** ${title}${extra}${link}`;
  }).join('\n');
}

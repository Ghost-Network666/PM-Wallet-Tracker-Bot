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

  if (isValidAddress(trimmed)) {
    return { type: 'address', value: normalizeAddress(trimmed) };
  }

  // Support common Polymarket profile URL formats
  // https://polymarket.com/@username
  // https://polymarket.com/profile/username or /@username
  const urlMatch = trimmed.match(/polymarket\.com\/(?:@|profile\/)([a-zA-Z0-9_-]+)/i);
  if (urlMatch) {
    return { type: 'url', value: urlMatch[1] };
  }

  if (trimmed.startsWith('@')) {
    return { type: 'url', value: trimmed.slice(1) };
  }

  // Fallback treat as name (later we can try to resolve as username if no wallet found)
  return { type: 'name', value: trimmed };
}

export function hashState(obj: unknown): string {
  const json = JSON.stringify(obj, Object.keys(obj as object).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

export function formatUsd(amount: string | number | null | undefined): string {
  if (amount == null) return '$0.00';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return '$0.00';
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  return `${sign}$${abs.toFixed(2)}`;
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
    return `$${num.toFixed(4)} (${pct}%)`;
  }
  return `$${num.toFixed(2)}`;
}

/** formatDecimal(123.456789) → 123.4568 */
export function formatDecimal(val: number | string | null | undefined): string {
  if (val == null) return '0';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '0';
  return num.toFixed(4);
}

/** formatPnL with emoji */
export function formatPnL(pnl: number | string | null | undefined): string {
  if (pnl == null) return '⚪ $0.00';
  const num = typeof pnl === 'string' ? parseFloat(pnl) : pnl;
  if (isNaN(num)) return '⚪ $0.00';
  if (num > 0) return `🟢 +$${num.toFixed(2)}`;
  if (num < 0) return `🔴 -$${Math.abs(num).toFixed(2)}`;
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

import { createPublicClient, type Position, type Trade, type Activity } from '@polymarket/client';
import { normalizeAddress } from './utils.js';

export interface PositionData {
  conditionId: string;
  tokenId?: string | null;
  size?: string | null;
  avgPrice?: string | null;
  curPrice?: string | null;
  cashPnl?: string | null;
  realizedPnl?: string | null;
  title?: string | null;
  slug?: string | null;
  outcome?: string | null;
  outcomeIndex?: number | null;
}

export interface TradeData {
  side?: 'BUY' | 'SELL' | null;
  size?: string | null;
  price?: string | null;
  timestamp?: number | null;
  title?: string | null;
  slug?: string | null;
  outcome?: string | null;
  transactionHash?: string | null;
}

export interface ActivityData {
  type: string;
  timestamp: number;
  title?: string | null;
  amount?: string | null;
  side?: string | null;
  shares?: string | null;
  price?: string | null;
  slug?: string | null;
  transactionHash?: string | null;
}

let baseClient: ReturnType<typeof createPublicClient> | null = null;

function getBaseClient() {
  if (!baseClient) {
    baseClient = createPublicClient();
  }
  return baseClient;
}

// Adapter to exactly match the user-specified SDK usage:
// client.data.core.getPositions({ user: address })
export const client = {
  data: {
    core: {
      async getPositions({ user }: { user: string }) {
        const c = getBaseClient();
        const paginator = (c as any).listPositions({ user: normalizeAddress(user), pageSize: 200 });
        const page = await paginator.firstPage();
        return (page?.items || []) as any[];
      },
      async getTrades({ user }: { user: string }) {
        const c = getBaseClient();
        const paginator = (c as any).listTrades({ user: normalizeAddress(user), pageSize: 100 });
        const page = await paginator.firstPage();
        return (page?.items || []) as any[];
      },
      async getActivity({ user }: { user: string }) {
        const c = getBaseClient();
        const paginator = (c as any).listActivity({ user: normalizeAddress(user), pageSize: 100 });
        const page = await paginator.firstPage();
        return (page?.items || []) as any[];
      }
    }
  }
};

async function fetchFirstPage<T>(paginator: any): Promise<T[]> {
  try {
    const page = await paginator.firstPage();
    return (page?.items ?? []) as T[];
  } catch (err) {
    // Return empty on error to keep tracker resilient
    return [];
  }
}

export async function fetchPositions(address: string, pageSize = 100): Promise<PositionData[]> {
  const addr = normalizeAddress(address);
  try {
    const raw = await client.data.core.getPositions({ user: addr });
    return raw.map((p: any) => ({
      conditionId: p.conditionId,
      tokenId: p.tokenId ?? null,
      size: p.size ?? null,
      avgPrice: p.avgPrice ?? null,
      curPrice: p.curPrice ?? null,
      cashPnl: p.cashPnl ?? null,
      realizedPnl: p.realizedPnl ?? null,
      title: p.title ?? null,
      slug: p.slug ?? null,
      outcome: p.outcome ?? null,
      outcomeIndex: p.outcomeIndex ?? null,
    }));
  } catch {
    return [];
  }
}

export async function fetchTrades(address: string, pageSize = 50): Promise<TradeData[]> {
  const addr = normalizeAddress(address);
  try {
    const raw = await client.data.core.getTrades({ user: addr });
    return raw.map((t: any) => ({
      side: t.side ?? null,
      size: t.size ?? null,
      price: t.price ?? null,
      timestamp: t.timestamp ?? null,
      title: t.title ?? null,
      slug: t.slug ?? null,
      outcome: t.outcome ?? null,
      transactionHash: t.transactionHash ?? null,
    }));
  } catch {
    return [];
  }
}

export async function fetchActivity(address: string, pageSize = 50): Promise<ActivityData[]> {
  const addr = normalizeAddress(address);
  try {
    const raw = await client.data.core.getActivity({ user: addr });
    return raw.map((a: any) => ({
      type: a.type ?? 'UNKNOWN',
      timestamp: a.timestamp ?? Date.now(),
      title: a.title ?? null,
      amount: a.amount ?? null,
      side: a.side ?? null,
      shares: a.shares ?? null,
      price: a.price ?? null,
      slug: a.slug ?? null,
      transactionHash: a.transactionHash ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch all three data sources for a wallet.
 * Used by both stats command and background tracker.
 */
export async function fetchWalletSnapshot(address: string) {
  const [positions, trades, activity] = await Promise.all([
    fetchPositions(address),
    fetchTrades(address),
    fetchActivity(address),
  ]);
  return { positions, trades, activity };
}

/**
 * Resolve username -> address.
 * Prefers the official SDK search (Gamma-backed).
 * Falls back to direct Gamma public-search (as allowed for profile URL resolution).
 */
export async function resolveUsernameToAddress(username: string): Promise<string | null> {
  const clean = username.replace(/^@/, '').trim();
  if (!clean) return null;

  const c = getBaseClient();

  // 1. Try via official SDK search (preferred)
  try {
    const results = await c.search({ q: clean, pageSize: 5 });
    const firstPage = await results.firstPage();
    const profiles = (firstPage as any)?.items?.profiles ?? [];
    for (const p of profiles) {
      const addr = p?.proxyWallet || p?.wallet;
      if (typeof addr === 'string' && addr.length === 42) {
        return normalizeAddress(addr);
      }
    }
  } catch {
    // continue to fallback
  }

  // 2. Direct Gamma API fallback (public-search) - for profile URL resolution
  try {
    const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(clean)}&search_profiles=true&limit_per_type=3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'PM-Wallet-Tracker-Bot' } });
    if (res.ok) {
      const data: any = await res.json();
      const profiles = data?.profiles || data?.items?.profiles || [];
      for (const p of profiles) {
        const addr = p?.proxyWallet || p?.wallet || p?.address;
        if (typeof addr === 'string' && addr.length === 42) {
          return normalizeAddress(addr);
        }
      }
    }
  } catch {
    // ignore network issues
  }

  return null;
}

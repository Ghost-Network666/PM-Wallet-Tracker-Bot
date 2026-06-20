import { createPublicClient, type Position, type Trade, type Activity } from '@polymarket/client';
import { normalizeAddress, isValidAddress } from './utils.js';

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
  url?: string | null;
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
  url?: string | null;
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
  url?: string | null;
  transactionHash?: string | null;
}

let sdkClient: ReturnType<typeof createPublicClient> | null = null;

export function getSdkClient() {
  if (!sdkClient) {
    sdkClient = createPublicClient();
  }
  return sdkClient;
}

const marketCache = new Map<string, { data: any; time: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getCachedMarket(params: { slug: string } | { id: string } | { url: string }) {
  const key = 'slug' in params ? params.slug : 'id' in params ? params.id : params.url;
  const cached = marketCache.get(key);
  if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
    return cached.data;
  }
  const data = await getSdkClient().fetchMarket(params);
  marketCache.set(key, { data, time: Date.now() });
  return data;
}

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
  const client = getSdkClient();
  try {
    const paginator = client.listPositions({ user: addr, pageSize });
    const raw = await fetchFirstPage<any>(paginator);
    const items = raw.map((p: any) => ({
      conditionId: p.conditionId,
      tokenId: p.tokenId ?? null,
      size: p.size ?? null,
      avgPrice: p.avgPrice ?? null,
      curPrice: p.curPrice ?? null,
      cashPnl: p.cashPnl ?? null,
      realizedPnl: p.realizedPnl ?? null,
      title: p.title ?? null,
      slug: p.slug ?? null,
      url: null,
      outcome: p.outcome ?? null,
      outcomeIndex: p.outcomeIndex ?? null,
    }));
    // Enrich with official SDK url using only SDK call + slug param
    await Promise.all(items.map(async (item) => {
      if (item.slug) {
        try {
          const m = await getCachedMarket({ slug: item.slug });
          item.url = m?.url ?? null;
        } catch {}
      }
    }));
    return items;
  } catch {
    return [];
  }
}

export async function fetchTrades(address: string, pageSize = 50): Promise<TradeData[]> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();
  try {
    const paginator = client.listTrades({ user: addr, pageSize });
    const raw = await fetchFirstPage<any>(paginator);
    const items = raw.map((t: any) => ({
      side: t.side ?? null,
      size: t.size ?? null,
      price: t.price ?? null,
      timestamp: t.timestamp ?? null,
      title: t.title ?? null,
      slug: t.slug ?? null,
      url: null,
      outcome: t.outcome ?? null,
      transactionHash: t.transactionHash ?? null,
    }));
    // Enrich with official SDK url using only SDK call + slug param
    await Promise.all(items.map(async (item) => {
      if (item.slug) {
        try {
          const m = await getCachedMarket({ slug: item.slug });
          item.url = m?.url ?? null;
        } catch {}
      }
    }));
    return items;
  } catch {
    return [];
  }
}

export async function fetchActivity(address: string, pageSize = 50): Promise<ActivityData[]> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();
  try {
    const paginator = client.listActivity({ user: addr, pageSize });
    const raw = await fetchFirstPage<any>(paginator);
    const items = raw.map((a: any) => ({
      type: a.type ?? 'UNKNOWN',
      timestamp: a.timestamp ?? Date.now(),
      title: a.title ?? null,
      amount: a.amount ?? null,
      side: a.side ?? null,
      shares: a.shares ?? null,
      price: a.price ?? null,
      slug: a.slug ?? null,
      url: null,
      transactionHash: a.transactionHash ?? null,
    }));
    // Enrich with official SDK url using only SDK call + slug param
    await Promise.all(items.map(async (item) => {
      if (item.slug) {
        try {
          const m = await getCachedMarket({ slug: item.slug });
          item.url = m?.url ?? null;
        } catch {}
      }
    }));
    return items;
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

  let portfolioValue: any = null;
  try {
    const pv = await getSdkClient().fetchPortfolioValue({ user: address });
    portfolioValue = pv;
  } catch (e) {
    // ignore
  }

  return { positions, trades, activity, portfolioValue };
}

/**
 * Resolve username -> address using ONLY the official SDK (search).
 * No custom/third-party APIs for resolution.
 */
export async function resolveUsernameToAddress(username: string): Promise<string | null> {
  let clean = username.replace(/^@/, '').trim();
  if (!clean) return null;

  // If it's already a valid address, just return it (on-chain verification)
  if (isValidAddress(clean)) {
    return normalizeAddress(clean);
  }

  const c = getSdkClient();

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
  } catch (e) {
    console.error('[resolve] SDK search failed for:', clean, e);
  }

  return null;
}

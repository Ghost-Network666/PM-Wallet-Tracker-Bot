import { createPublicClient, type Position, type Trade, type Activity, type ClosedPosition, type PublicProfile, ActivityType } from '@polymarket/client';
import { normalizeAddress, isValidAddress } from './utils.js';

export interface PositionData {
  conditionId: string;
  tokenId?: string | null;
  oppositeTokenId?: string | null;
  size?: string | null;
  avgPrice?: string | null;
  curPrice?: string | null;
  initialValue?: string | null;
  currentValue?: string | null;
  totalBought?: string | null;
  cashPnl?: string | null;
  percentPnl?: number | null;
  realizedPnl?: string | null;
  percentRealizedPnl?: number | null;
  redeemable?: boolean | null;
  mergeable?: boolean | null;
  negativeRisk?: boolean | null;
  title?: string | null;
  slug?: string | null;
  url?: string | null;
  outcome?: string | null;
  outcomeIndex?: number | null;
  oppositeOutcome?: string | null;
  eventId?: string | null;
  eventSlug?: string | null;
  endDate?: string | null;
}

export interface ClosedPositionData {
  conditionId?: string | null;
  tokenId?: string | null;
  oppositeTokenId?: string | null;
  avgPrice?: string | null;
  curPrice?: string | null;
  totalBought?: string | null;
  realizedPnl?: string | null;
  timestamp?: number | null;
  title?: string | null;
  slug?: string | null;
  url?: string | null;
  eventSlug?: string | null;
  outcome?: string | null;
  outcomeIndex?: number | null;
  oppositeOutcome?: string | null;
  endDate?: string | null;
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
  outcomeIndex?: number | null;
  conditionId?: string | null;
  tokenId?: string | null;
  eventSlug?: string | null;
  transactionHash?: string | null;
}

export interface ActivityData {
  type: string;
  timestamp: number;
  title?: string | null;
  amount?: string | null;
  shares?: string | null;
  side?: string | null;
  price?: string | null;
  slug?: string | null;
  url?: string | null;
  eventSlug?: string | null;
  conditionId?: string | null;
  tokenId?: string | null;
  outcome?: string | null;
  outcomeIndex?: number | null;
  isCombo?: boolean | null;
  transactionHash?: string | null;
}

export interface ListPositionsOptions {
  pageSize?: number;
  market?: string[];
  eventId?: number[];
  sizeThreshold?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  sortBy?: 'CURRENT' | 'INITIAL' | 'TOKENS' | 'CASHPNL' | 'PERCENTPNL' | 'TITLE' | 'RESOLVING' | 'PRICE' | 'AVGPRICE';
  sortDirection?: 'ASC' | 'DESC';
  title?: string;
}

export interface ListClosedPositionsOptions {
  pageSize?: number;
  market?: string[];
  eventId?: number[];
  title?: string;
  sortBy?: 'TITLE' | 'PRICE' | 'AVGPRICE' | 'REALIZEDPNL' | 'TIMESTAMP';
  sortDirection?: 'ASC' | 'DESC';
}

export interface ListTradesOptions {
  pageSize?: number;
  takerOnly?: boolean;
  filterType?: 'TOKENS' | 'CASH';
  filterAmount?: number;
  market?: string[];
  eventId?: number[];
  side?: 'BUY' | 'SELL';
}

export interface ListActivityOptions {
  pageSize?: number;
  market?: string[];
  eventId?: number[];
  type?: ActivityType[];
  start?: number;
  end?: number;
  sortBy?: 'TOKENS' | 'TIMESTAMP' | 'CASH';
  sortDirection?: 'ASC' | 'DESC';
  side?: 'BUY' | 'SELL';
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

/** Enrich a batch of SDK items with the official Polymarket market URL, keyed by slug. */
async function enrichWithMarketUrl<T extends { slug?: string | null; url?: string | null }>(items: T[]): Promise<T[]> {
  await Promise.all(items.map(async (item) => {
    if (item.slug) {
      try {
        const m = await getCachedMarket({ slug: item.slug });
        item.url = m?.url ?? null;
      } catch {}
    }
  }));
  return items;
}

export async function fetchPositions(address: string, options: ListPositionsOptions = {}): Promise<PositionData[]> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();
  try {
    const paginator = client.listPositions({ user: addr, pageSize: options.pageSize ?? 100, ...options });
    const raw = await fetchFirstPage<Position>(paginator);
    const items: PositionData[] = raw.map((p: any) => ({ ...p, url: null }));
    return await enrichWithMarketUrl(items);
  } catch {
    return [];
  }
}

/** Closed (fully exited or resolved-and-redeemed) positions, sourced entirely from listClosedPositions. */
export async function fetchClosedPositions(address: string, options: ListClosedPositionsOptions = {}): Promise<ClosedPositionData[]> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();
  try {
    const paginator = client.listClosedPositions({ user: addr, pageSize: options.pageSize ?? 100, sortBy: options.sortBy ?? 'TIMESTAMP', sortDirection: options.sortDirection ?? 'DESC', ...options });
    const raw = await fetchFirstPage<ClosedPosition>(paginator);
    const items: ClosedPositionData[] = raw.map((p: any) => ({ ...p, url: null }));
    return await enrichWithMarketUrl(items);
  } catch {
    return [];
  }
}

export async function fetchTrades(address: string, options: ListTradesOptions = {}): Promise<TradeData[]> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();
  try {
    const paginator = client.listTrades({ user: addr, pageSize: options.pageSize ?? 50, ...options });
    const raw = await fetchFirstPage<Trade>(paginator);
    const items: TradeData[] = raw.map((t: any) => ({ ...t, url: null }));
    return await enrichWithMarketUrl(items);
  } catch {
    return [];
  }
}

export async function fetchActivity(address: string, options: ListActivityOptions = {}): Promise<ActivityData[]> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();
  try {
    const paginator = client.listActivity({ user: addr, pageSize: options.pageSize ?? 50, ...options });
    const raw = await fetchFirstPage<Activity>(paginator);
    const items: ActivityData[] = raw.map((a: any) => ({ ...a, url: null }));
    return await enrichWithMarketUrl(items);
  } catch {
    return [];
  }
}

/**
 * Fetch all three data sources for a wallet.
 * Used by both stats command and background tracker.
 */
export async function fetchWalletSnapshot(address: string, options: { trades?: ListTradesOptions; activity?: ListActivityOptions; positions?: ListPositionsOptions } = {}) {
  const [positions, trades, activity] = await Promise.all([
    fetchPositions(address, options.positions),
    fetchTrades(address, options.trades),
    fetchActivity(address, options.activity),
  ]);

  let portfolioValue: any = null;
  try {
    portfolioValue = await getSdkClient().fetchPortfolioValue({ user: address });
  } catch (e) {
    // ignore
  }

  return { positions, trades, activity, portfolioValue };
}

export interface WalletAnalytics {
  pnl: number;
  volume: number;
  wins: number;
  losses: number;
  winRate: number;
  rank: string | null;
  userName: string | null;
  profileImage: string | null;
  xUsername: string | null;
  verifiedBadge: boolean;
  marketsTraded: number;
}

/**
 * Wallet trading stats sourced entirely from official SDK endpoints:
 * - pnl/volume/rank/userName/profileImage/xUsername/verifiedBadge from listTraderLeaderboard
 *   (Polymarket's own all-time leaderboard entry for this wallet)
 * - win/loss counts from listClosedPositions' realizedPnl sign (no custom PnL math)
 * - marketsTraded from fetchTradedMarketCount
 * Wallets that aren't ranked on the leaderboard return pnl/volume/rank as 0/null (no estimation fallback).
 */
export async function fetchWalletAnalytics(address: string): Promise<WalletAnalytics> {
  const addr = normalizeAddress(address);
  const client = getSdkClient();

  let pnl = 0;
  let volume = 0;
  let rank: string | null = null;
  let userName: string | null = null;
  let profileImage: string | null = null;
  let xUsername: string | null = null;
  let verifiedBadge = false;
  try {
    const paginator = client.listTraderLeaderboard({ user: addr, timePeriod: 'ALL', orderBy: 'PNL', category: 'OVERALL' });
    const page = await paginator.firstPage();
    const entry = (page?.items ?? [])[0] as any;
    if (entry) {
      pnl = parseFloat(entry.pnl || '0') || 0;
      volume = parseFloat(entry.vol || '0') || 0;
      rank = entry.rank ?? null;
      userName = entry.userName ?? null;
      profileImage = entry.profileImage ?? null;
      xUsername = entry.xUsername ?? null;
      verifiedBadge = !!entry.verifiedBadge;
    }
  } catch {}

  let wins = 0;
  let losses = 0;
  try {
    const paginator = client.listClosedPositions({ user: addr, pageSize: 100 });
    const page = await paginator.firstPage();
    for (const cp of (page?.items ?? []) as any[]) {
      const r = parseFloat(cp.realizedPnl || '0') || 0;
      if (r > 0) wins++;
      else if (r < 0) losses++;
    }
  } catch {}

  let marketsTraded = 0;
  try {
    const traded = await client.fetchTradedMarketCount({ user: addr });
    marketsTraded = (traded as any)?.traded ?? 0;
  } catch {}

  const totalClosed = wins + losses;
  const winRate = totalClosed > 0 ? wins / totalClosed : 0;

  return { pnl, volume, wins, losses, winRate, rank, userName, profileImage, xUsername, verifiedBadge, marketsTraded };
}

/** Public profile (display name, bio, avatar, verification) sourced entirely from fetchPublicProfile. */
export async function fetchProfile(address: string): Promise<PublicProfile | null> {
  const addr = normalizeAddress(address);
  try {
    return await getSdkClient().fetchPublicProfile({ address: addr });
  } catch {
    return null;
  }
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
    const results = c.search({ q: clean, pageSize: 5, searchProfiles: true });
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

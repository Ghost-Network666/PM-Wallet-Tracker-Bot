# PM Wallet Tracker Bot

Discord bot that tracks Polymarket wallets in real-time using **only** the official Polymarket TypeScript SDK (`@polymarket/client`).

No third-party APIs for data fetching. No web scraping.

## Features

- **Strictly official SDK only** (`@polymarket/client`): listPositions, listTrades, listActivity, fetchMarket, fetchPortfolioValue etc. No third-party APIs.
- Per-wallet settings (min trade/impact size, side filter BUY/SELL/ALL, first-time market alerts).
- Spam-resistant: event deduplication (tx + composite keys), history backfill on add, batched notifications.
- Live /list-wallets with Portfolio Value (SDK + positions fallback), Unrealized/Realized PnL, open positions + est. current values.
- Position open/close detection with clean plain-text alerts.
- All notifications include **SDK-sourced Polymarket market link** + on-chain tx link.
- Compact formatting, trimmed decimals, structured embeds.
- Leaderboard, combined portfolio, export/import, detailed stats with filters.

## Commands

| Command              | Description |
|----------------------|-------------|
| `/add-wallet`        | Add a wallet (by 0x or @username/profile URL). Supports optional name, min_size, side filter, first_time notifications. |
| `/remove-wallet`     | Remove a tracked wallet |
| `/rename-wallet`     | Rename a tracked wallet |
| `/list-wallets`      | List **all** tracked wallets with live Portfolio, Unrealized/Realized PnL, open positions summary (clean & sorted). |
| `/wallet-stats`      | Detailed view for one wallet (positions, trades, activity, filters by days/type). |
| `/leaderboard`       | Rank wallets by realized PnL from activity. |
| `/combined-portfolio`| Sum portfolio values across all tracked wallets. |
| `/export-wallets`    | Export tracked wallets as JSON file. |
| `/import-wallets`    | Import wallets from JSON. |

## Components

| Component         | Description |
|-------------------|-------------|
| Discord commands  | Structured handlers + registry for clean dispatch (add/remove/rename/list/stats/leaderboard/etc.) |
| Database          | SQLite (tracked_wallets + wallet_events + market interactions for dedup) |
| Tracking engine   | Polling + diff detection + batched notifications (only official SDK) |
| Formatters        | Centralized in utils (compact PnL, clean titles, SDK links) |
| Configuration     | .env + per-wallet settings persisted in DB |
| Market links      | Always from SDK fetchMarket({slug}) — no hardcoded URLs |

The bot will start tracking wallets immediately after you add them and send notifications to your Discord channel whenever tracked wallets make moves.

## Requirements

- Node.js >= 20 (SDK officially prefers >= 24)
- A Discord bot token + application
- A text channel ID for notifications

## Setup

1. **Clone / download** this project and install dependencies:

```bash
npm install
```

2. **Create `.env`** from the example:

```bash
cp .env.example .env
```

Fill in:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_app_client_id
DISCORD_CHANNEL_ID=123456789012345678
TRACKING_INTERVAL=60000
```

3. **Register slash commands**:

```bash
npm run register          # global (takes time)
# or for faster dev:
DISCORD_GUILD_ID=your_guild_id npm run register
```

4. **Run in development**:

```bash
npm run dev
```

5. **Build & run production**:

```bash
npm run build
npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | - | Bot token |
| `DISCORD_CLIENT_ID` | Yes | - | Application ID |
| `DISCORD_CHANNEL_ID` | Yes | - | Channel for notifications |
| `DISCORD_GUILD_ID` | No | - | For guild-only command registration |
| `TRACKING_INTERVAL` | No | 60000 | Poll interval (ms) |
| `MAX_FETCH_ITEMS` | No | 100 | Max items fetched per data type per poll |

## Database

SQLite file `data.db` (created on first run).

Tables:
- `tracked_wallets`
- `wallet_events`

## How It Uses the SDK (ONLY)

```ts
import { createPublicClient } from '@polymarket/client';

const client = createPublicClient();

client.listPositions({ user: address, pageSize })
client.listTrades({ user: address, pageSize })
client.listActivity({ user: address, pageSize })
```

All wallet data (positions + PnL + trades + activity) comes exclusively from these methods.

## Notes

- Profile URL resolution (`@username`) uses Polymarket's public search (via SDK). If it fails, the bot will ask for the raw 0x address.
- First poll after adding a wallet will not spam notifications (initial hashes are saved).
- The bot is resilient: individual wallet fetch failures do not crash the loop.
- Consider running under PM2 or a process manager for production.

## License

MIT

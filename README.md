# PM Wallet Tracker Bot

Discord bot that tracks Polymarket wallets in real-time using **only** the official Polymarket TypeScript SDK (`@polymarket/client`).

No third-party APIs for data fetching. No web scraping.

## Features

- Slash commands for wallet management
- Local SQLite storage
- Background polling (default every 60s)
- Change detection for:
  - New / closed positions
  - New trades
  - New activity events (splits, merges, rewards, etc.)
- Clean Discord embed for `/wallet-stats` and list
- Notifications sent to a dedicated channel

## Commands the Bot Will Support

| Command | Description |
|---------|-------------|
| /add-wallet | Add a wallet by address or Polymarket URL |
| /remove-wallet | Remove a tracked wallet |
| /rename-wallet | Rename a tracked wallet |
| /list-wallets | List all tracked wallets |
| /wallet-stats | Show detailed stats for a wallet |

## Components

| Component         | Description |
|-------------------|-------------|
| Discord commands  | All 5 slash commands with proper handlers |
| Database          | SQLite with tracked wallets and event history |
| Tracking engine   | Polls SDK every 60s, detects changes, sends notifications |
| Formatters        | Human-readable output with emojis |
| Configuration     | `.env` with Discord token, channel ID, interval |
| Address resolver  | Extracts address from Polymarket profile URLs |

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

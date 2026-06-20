import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, Events, TextChannel } from 'discord.js';
import { initDb, getDb, closeDb, getAllActiveWallets } from './db.js';
import { handleCommand, commands } from './commands.js';
import { startTracker, stopTracker } from './tracker.js';
import { sleep } from './utils.js';

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const TRACKING_INTERVAL = parseInt(process.env.TRACKING_INTERVAL || '10000', 10);
const MAX_FETCH_ITEMS = parseInt(process.env.MAX_FETCH_ITEMS || '100', 10);

console.log(`🔧 Configured DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID}`);

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_CHANNEL_ID) {
  console.error('Missing required environment variables. Check .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

let notificationChannel: TextChannel | null = null;

async function sendNotification(payload: string | any) {
  if (!notificationChannel) {
    console.warn('[bot] No notification channel available');
    return;
  }
  try {
    if (typeof payload === 'string') {
      await notificationChannel.send(payload.length > 1900 ? payload.slice(0, 1900) + '…' : payload);
    } else {
      await notificationChannel.send(payload);
    }
  } catch (e) {
    console.error('[bot] Failed to send notification:', e);
  }
}

async function resolveNotificationChannel(): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch && ch.isTextBased() && 'send' in ch) {
      return ch as TextChannel;
    }
    console.error('Configured DISCORD_CHANNEL_ID is not a text channel.');
    return null;
  } catch (e) {
    console.error('Failed to fetch notification channel:', e);
    return null;
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  notificationChannel = await resolveNotificationChannel();
  if (!notificationChannel) {
    console.warn('⚠️  Notifications will not be sent until channel is fixed.');
  }

  // Start background tracker
  console.log(`🚀 Starting background tracker (interval: ${TRACKING_INTERVAL}ms)`);
  startTracker({
    intervalMs: TRACKING_INTERVAL,
    sendNotification,
    maxItems: MAX_FETCH_ITEMS,
  }).catch(err => console.error('Tracker crashed:', err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Enforce that the bot only responds to interactions in the configured channel
  if (interaction.channelId !== DISCORD_CHANNEL_ID) {
    if (interaction.isChatInputCommand()) {
      try {
        await interaction.reply({
          content: `This bot only works in the configured notification channel.`,
          ephemeral: true
        });
      } catch (e) {
        // ignore if reply fails
      }
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction, DISCORD_CHANNEL_ID);
  } else if (interaction.isButton()) {
    const { handleButton } = await import('./commands.js');
    await handleButton(interaction);
  } else if (interaction.isModalSubmit()) {
    const { handleModal } = await import('./commands.js');
    await handleModal(interaction);
  }
});

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  stopTracker();
  client.destroy();
  closeDb();
  await sleep(300);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopTracker();
  client.destroy();
  closeDb();
  process.exit(0);
});

// Boot
console.log('🚀 Starting PM Wallet Tracker Bot');
console.log('   • Discord commands: 5 slash commands ready');
console.log('   • Database: SQLite (tracked_wallets + wallet_events) - persistent across restarts');
console.log('   • Tracking engine: polling @polymarket/client SDK (ONLY official SDK methods)');
console.log('   • Address resolver: Polymarket profile URLs supported');
console.log('   • Notifications: will be sent to configured channel');

console.log('Initializing database...');
initDb();

console.log('Loading tracked wallets from database...');
const initialWallets = getAllActiveWallets();
if (initialWallets.length > 0) {
  console.log(`✅ Loaded ${initialWallets.length} tracked wallet(s) from persistent storage:`);
  initialWallets.forEach((w: any) => {
    console.log(`   - ${w.name} (${w.address.slice(0,6)}...${w.address.slice(-4)}) - added by ${w.added_by}`);
  });
} else {
  console.log('   (no wallets currently being tracked)');
}

console.log('Starting Discord client...');
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err);
  process.exit(1);
});

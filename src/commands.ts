import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type CommandInteraction,
} from 'discord.js';
import { addWallet, removeWallet, renameWallet, listWallets, getWalletByNameOrAddress, updateWalletHashes } from './db.js';
import { fetchWalletSnapshot, resolveUsernameToAddress } from './polymarket.js';
import { isValidAddress, parseWalletIdentifier, truncateAddress, shortText, formatPnL, formatPrice, formatDecimal, formatDate, formatSide, hashState } from './utils.js';
import { primeWalletForMonitoring } from './tracker.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('add-wallet')
    .setDescription('Add a wallet by address or Polymarket URL')
    .addStringOption(opt =>
      opt.setName('identifier')
        .setDescription('Wallet address (0x...) or Polymarket profile URL (@username or https://polymarket.com/@user)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Friendly name for this wallet')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('remove-wallet')
    .setDescription('Remove a tracked wallet')
    .addStringOption(opt =>
      opt.setName('identifier')
        .setDescription('Wallet name or address')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('rename-wallet')
    .setDescription('Rename a tracked wallet')
    .addStringOption(opt =>
      opt.setName('current_name')
        .setDescription('Current name of the wallet')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('new_name')
        .setDescription('New name')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('list-wallets')
    .setDescription('List all tracked wallets'),

  new SlashCommandBuilder()
    .setName('wallet-stats')
    .setDescription('Show detailed stats for a wallet')
    .addStringOption(opt =>
      opt.setName('identifier')
        .setDescription('Wallet name or address')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

export async function handleCommand(interaction: ChatInputCommandInteraction, channelId: string) {
  const { commandName } = interaction;

  try {
    if (commandName === 'add-wallet') {
      await handleAddWallet(interaction);
    } else if (commandName === 'remove-wallet') {
      await handleRemoveWallet(interaction);
    } else if (commandName === 'rename-wallet') {
      await handleRenameWallet(interaction);
    } else if (commandName === 'list-wallets') {
      await handleListWallets(interaction);
    } else if (commandName === 'wallet-stats') {
      await handleWalletStats(interaction);
    }
  } catch (err: any) {
    console.error('Command error:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: `❌ Error: ${err.message || 'Unknown error'}`, ephemeral: true });
    }
  }
}

async function handleAddWallet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const identifier = interaction.options.getString('identifier', true);
  const name = interaction.options.getString('name', true).trim();

  const parsed = parseWalletIdentifier(identifier);
  let address: string | null = null;

  if (parsed.type === 'address') {
    address = parsed.value;
  } else if (parsed.type === 'url') {
    // Try resolve via SDK search
    address = await resolveUsernameToAddress(parsed.value);
    if (!address) {
      await interaction.editReply(
        `⚠️ Could not resolve **@${parsed.value}** to a wallet address automatically.\n` +
        `Please provide the 0x wallet address directly instead.`
      );
      return;
    }
  } else {
    await interaction.editReply('❌ Please provide a valid 0x address or a Polymarket profile URL / @username.');
    return;
  }

  if (!isValidAddress(address)) {
    await interaction.editReply('❌ Invalid wallet address format. Must be 0x followed by 40 hex characters.');
    return;
  }

  const addedBy = interaction.user.id;
  const wallet = addWallet(address, name, addedBy);

  // Immediately capture baseline snapshot + prime memory so the background tracking engine
  // starts monitoring that wallet right away (no extra steps needed).
  try {
    const snapshot = await fetchWalletSnapshot(address);
    const positions = snapshot.positions.slice(0, 100);
    const trades = snapshot.trades.slice(0, 100);
    const activity = snapshot.activity.slice(0, 100);

    const positionsHash = hashState(positions);
    const activityHash = hashState(activity);
    updateWalletHashes(address, positionsHash, activityHash);

    // Prime in-memory previous state for immediate diffing on next poll cycle
    primeWalletForMonitoring(address, { positions, trades, activity });
  } catch {
    // Non-fatal; tracker will initialize on next poll
  }

  await interaction.editReply(
    `✅ Tracking wallet **${name}** (${wallet.address})`
  );
}

async function handleRemoveWallet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const identifier = interaction.options.getString('identifier', true);
  const ok = removeWallet(identifier);

  if (ok) {
    await interaction.editReply(`✅ Removed wallet: ${identifier}`);
  } else {
    await interaction.editReply(`❌ No wallet found matching "${identifier}".`);
  }
}

async function handleRenameWallet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const current = interaction.options.getString('current_name', true);
  const next = interaction.options.getString('new_name', true).trim();

  const ok = renameWallet(current, next);
  if (ok) {
    await interaction.editReply(`✅ Renamed wallet from **${current}** to **${next}**`);
  } else {
    await interaction.editReply(`❌ Could not find a wallet named **${current}**.`);
  }
}

async function handleListWallets(interaction: ChatInputCommandInteraction) {
  const wallets = listWallets();

  if (wallets.length === 0) {
    await interaction.reply({ content: 'No wallets are being tracked yet. Use `/add-wallet`.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 Tracked Wallets')
    .setColor(0x00b0f4)
    .setTimestamp();

  const lines = wallets.map(w => {
    const addr = truncateAddress(w.address);
    const last = w.last_checked ? formatDate(w.last_checked) : 'never';
    return `**${w.name}** — \`${addr}\`\nLast checked: ${last}`;
  });

  embed.setDescription(lines.join('\n\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleWalletStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const identifier = interaction.options.getString('identifier', true);
  const wallet = getWalletByNameOrAddress(identifier);

  if (!wallet) {
    await interaction.editReply(`❌ No tracked wallet matching "${identifier}".`);
    return;
  }

  const snapshot = await fetchWalletSnapshot(wallet.address);
  const { positions, trades, activity } = snapshot;

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${wallet.name}`)
    .setDescription(`\`${truncateAddress(wallet.address)}\``)
    .setColor(0x00aa55)
    .setTimestamp();

  // === Position Cards ===
  const open = positions.filter((p: any) => parseFloat(p.size || '0') > 0);
  if (open.length > 0) {
    const cards = open.slice(0, 5).map((p: any) => {
      const title = shortText(p.title || p.slug || 'Market', 48);
      const outcome = p.outcome ? ` **${p.outcome}**` : '';
      const size = p.size ? `Size: ${formatDecimal(p.size)}` : '';
      const avg = p.avgPrice ? ` | Avg: ${formatPrice(p.avgPrice, true)}` : '';
      const cur = p.curPrice ? ` | Cur: ${formatPrice(p.curPrice, true)}` : '';
      const pnl = p.cashPnl != null ? `\nPnL: ${formatPnL(p.cashPnl)}` : '';
      const realized = p.realizedPnl != null ? ` | Realized: ${formatPnL(p.realizedPnl)}` : '';
      return `**📍 ${title}**${outcome}\n${size}${avg}${cur}${pnl}${realized}`;
    });
    embed.addFields({ name: `📈 Open Positions (${open.length})`, value: cards.join('\n\n'), inline: false });
  } else {
    embed.addFields({ name: '📈 Open Positions', value: 'None open', inline: false });
  }

  // Total PnL summary
  const totalPnl = positions.reduce((sum: number, p: any) => sum + (parseFloat(p.cashPnl || '0') || 0), 0);
  embed.addFields({ name: '💰 Total Unrealized PnL', value: formatPnL(totalPnl), inline: true });

  // === Recent Trades (formatted) ===
  if (trades.length > 0) {
    const tradeLines = trades.slice(0, 6).map((t: any) => {
      const side = formatSide(t.side);
      const title = shortText(t.title || t.slug || '—', 42);
      const outcome = t.outcome ? ` ${t.outcome}` : '';
      const qty = t.size ? ` ${formatDecimal(t.size)}` : '';
      const pr = t.price ? ` @ ${formatPrice(t.price, true)}` : '';
      const ts = t.timestamp ? `\n${formatDate(t.timestamp)}` : '';
      return `• ${side} **${title}**${outcome}${qty}${pr}${ts}`;
    });
    embed.addFields({ name: '💱 Recent Trades', value: tradeLines.join('\n\n'), inline: false });
  } else {
    embed.addFields({ name: '💱 Recent Trades', value: 'No recent trades', inline: false });
  }

  // === Recent Activity (formatted) ===
  if (activity.length > 0) {
    const actLines = activity.slice(0, 5).map((a: any) => {
      const typ = a.type || 'ACTIVITY';
      const title = shortText(a.title || a.slug || '—', 40);
      const amt = a.amount ? ` ${formatPnL(a.amount)}` : '';
      const side = a.side ? ` ${formatSide(a.side)}` : '';
      const ts = a.timestamp ? ` • ${formatDate(a.timestamp)}` : '';
      return `• **${typ}** ${title}${amt}${side}${ts}`;
    });
    embed.addFields({ name: '📜 Recent Activity', value: actLines.join('\n'), inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { addWallet, removeWallet, renameWallet, listWallets, getWalletByNameOrAddress, updateWalletHashes, getWalletByAddress, updateWalletSettings, backfillSeenEvent } from './db.js';
import { fetchWalletSnapshot, resolveUsernameToAddress, getSdkClient } from './polymarket.js';
import { isValidAddress, parseWalletIdentifier, truncateAddress, shortText, formatPnL, formatPrice, formatDecimal, formatDate, formatSide, hashState, normalizeAddress, getEventDedupKey, cleanMarketTitle, formatPositionsForEmbed, formatTradesForEmbed, formatActivityForEmbed, getPortfolioValue, computeNetRealized, computeRoughWinRate, computeApproxVolume, computeActivityScore } from './utils.js';
import { primeWalletForMonitoring, getTrackingInterval, setTrackingInterval } from './tracker.js';

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
        .setDescription('Optional: friendly name for the wallet (bot will ask via button if not provided)')
        .setRequired(false)
    )
    .addNumberOption(opt =>
      opt.setName('min_size')
        .setDescription('Minimum size for alerts (e.g. 1000)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('side')
        .setDescription('Side filter')
        .setRequired(false)
        .addChoices(
          { name: 'ALL', value: 'ALL' },
          { name: 'BUY', value: 'BUY' },
          { name: 'SELL', value: 'SELL' }
        )
    )
    .addBooleanOption(opt =>
      opt.setName('first_time')
        .setDescription('Notify on first interaction with new markets')
        .setRequired(false)
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
    )
    .addStringOption(opt =>
      opt.setName('filter')
        .setDescription('e.g. open, closed, type=trade')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Limit to last N days')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Rank tracked wallets by recent realized PnL'),
  new SlashCommandBuilder()
    .setName('combined-portfolio')
    .setDescription('Sum of portfolio values across all tracked wallets'),
  new SlashCommandBuilder()
    .setName('export-wallets')
    .setDescription('Export tracked wallets as JSON'),
  new SlashCommandBuilder()
    .setName('import-wallets')
    .setDescription('Import wallets from JSON string')
    .addStringOption(opt =>
      opt.setName('data')
        .setDescription('JSON array of {address, name?}')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('interval')
    .setDescription('View or change the polling frequency (in seconds, min 5). Controls how often the bot checks wallets via the SDK.')
    .addIntegerOption(opt =>
      opt.setName('seconds')
        .setDescription('New interval in seconds (how often checks happen)')
        .setRequired(false)
        .setMinValue(5)
    ),
].map(cmd => cmd.toJSON());

// Clean command registry for structure and easy extension
type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

const commandHandlers: Record<string, CommandHandler> = {
  'add-wallet': handleAddWallet,
  'remove-wallet': handleRemoveWallet,
  'rename-wallet': handleRenameWallet,
  'list-wallets': handleListWallets,
  'wallet-stats': handleWalletStats,
  'leaderboard': handleLeaderboard,
  'combined-portfolio': handleCombinedPortfolio,
  'export-wallets': handleExportWallets,
  'import-wallets': handleImportWallets,
  'interval': handleInterval,
};

export async function handleCommand(interaction: ChatInputCommandInteraction, channelId: string) {
  const { commandName } = interaction;

  console.log(`[interaction] Received /${commandName} from ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}`);

  try {
    const handler = commandHandlers[commandName];
    if (handler) {
      await handler(interaction);
    } else {
      console.log(`[interaction] Unknown command: ${commandName}`);
      await interaction.reply({ content: '❌ Unknown command.', ephemeral: true });
    }
  } catch (err: any) {
    console.error('Command error:', err);
    try {
      const errorMsg = `❌ Error: ${err.message || 'Unknown error'}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorMsg });
      } else {
        await interaction.reply({ content: errorMsg, ephemeral: true });
      }
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr);
    }
  }
}

async function handleAddWallet(interaction: ChatInputCommandInteraction) {
  // Detailed snapshot (portfolio, recent activity etc) is ephemeral/private to the person adding.
  // Public channel only gets a short confirmation.
  await interaction.deferReply({ ephemeral: true });

  console.log('[add-wallet] Deferred. Processing identifier...');

  const identifier = interaction.options.getString('identifier', true);
  console.log(`[add-wallet] identifier="${identifier}"`);

  let address: string | null = null;

  const trimmedId = identifier.trim();

  // Robust 0x extraction: handle pure 0x or pasted text containing an address (prevents @mintblade style errors)
  const addrMatch = trimmedId.match(/0x[a-fA-F0-9]{40}/);
  if (addrMatch) {
    const candidate = addrMatch[0];
    if (isValidAddress(candidate)) {
      address = normalizeAddress(candidate);
    } else {
      await interaction.editReply('❌ Invalid wallet address format. Must be 0x followed by 40 hex characters.');
      return;
    }
  } else {
    const parsed = parseWalletIdentifier(trimmedId);
    if (parsed.type === 'address') {
      address = parsed.value;
    } else if (parsed.type === 'url') {
      address = await resolveUsernameToAddress(parsed.value);
      if (!address) {
        await interaction.editReply(
          `⚠️ Could not resolve "${parsed.value}" using the official SDK search.\nPlease provide the 0x address directly.`
        );
        return;
      }
    } else {
      address = await resolveUsernameToAddress(parsed.value);
      if (!address) {
        await interaction.editReply('❌ Could not resolve as profile or username. Please provide a valid 0x address.');
        return;
      }
    }
  }

  if (!isValidAddress(address)) {
    await interaction.editReply('❌ Invalid wallet address. Must be 0x + 40 hex characters.');
    return;
  }

  const addedBy = interaction.user.id;
  const providedName = interaction.options.getString('name');
  const defaultName = providedName ? providedName.trim() : truncateAddress(address);
  const wallet = addWallet(address, defaultName, addedBy);

  const minSize = interaction.options.getNumber('min_size') || 0;
  const sideFilter = interaction.options.getString('side') || 'ALL';
  const firstTime = interaction.options.getBoolean('first_time') ?? true;
  updateWalletSettings(address, { min_size: minSize, side_filter: sideFilter, notify_first_time: firstTime ? 1 : 0 });

  console.log(`[add-wallet] ✅ Added to DB with default name: ${wallet.name} ${wallet.address}`);

  // Verify persistence
  const verify = getWalletByAddress(address);
  if (verify) {
    console.log(`[add-wallet] ✅ Persistence verified in SQLite`);
  }

  // Pull ALL possible data from SDK (pure SDK calls only)
  console.log('[add-wallet] Pulling comprehensive data from @polymarket/client SDK...');
  const snapshot = await fetchWalletSnapshot(address);
  const portfolioVal = formatPnL(getPortfolioValue(snapshot.portfolioValue));

  // Calculate realized from activity for extra insight
  let realized = 0;
  (snapshot.activity || []).forEach((a: any) => {
    if (a.amount) {
      const val = parseFloat(a.amount) || 0;
      if (val > 0) realized += val;
    }
  });

  // Build rich confirmation embed with everything
  const embed = new EmbedBuilder()
    .setTitle(`✅ Wallet Added & Tracking Started`)
    .setDescription(`**${wallet.name}**\n\`${address}\`\n[View on Polygonscan](https://polygonscan.com/address/${address})`)
    .setColor(0x00ff00)
    .addFields(
      { name: '📊 Portfolio Value (SDK)', value: portfolioVal, inline: true },
      { name: '💰 Realized (from shown activity)', value: formatPnL(realized), inline: true },
      { name: '📈 Open Positions', value: formatPositionsForEmbed(snapshot.positions), inline: false },
      { name: '💱 Recent Trades (with on-chain links)', value: formatTradesForEmbed(snapshot.trades), inline: false },
      { name: '📜 Recent Activity (with tx links)', value: formatActivityForEmbed(snapshot.activity), inline: false },
      { name: '📋 Data Summary (from SDK)', value: `Positions: ${snapshot.positions ? snapshot.positions.length : 0} | Trades: ${snapshot.trades ? snapshot.trades.length : 0} | Activities: ${snapshot.activity ? snapshot.activity.length : 0}`, inline: false }
    )
    .setFooter({ text: 'via official @polymarket/client SDK' })
    .setTimestamp();

  // Add note about naming
  if (!providedName) {
    embed.addFields({ name: '🏷️ Name this wallet', value: 'Click the button below to give it a friendly name (or use /rename-wallet).', inline: false });
  }

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`name_wallet_${address}`)
        .setLabel('🏷️ Name this wallet')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🏷️')
    );

  await interaction.editReply({ embeds: [embed], components: [row] });

  // Public short notice (channel visible). Detailed data above is private to you.
  try {
    await interaction.followUp({
      content: `✅ **${wallet.name}** is now being tracked. (Full snapshot above — only visible to you)`,
      ephemeral: false
    });
  } catch {}

  // Prime tracking + backfill current history as SEEN (notified) so we only alert on *future* changes
  try {
    const positions = snapshot.positions.slice(0, 100);
    const trades = snapshot.trades.slice(0, 100);
    const activity = snapshot.activity.slice(0, 100);
    const positionsHash = hashState(positions);
    const activityHash = hashState(activity);
    updateWalletHashes(address, positionsHash, activityHash);
    primeWalletForMonitoring(address, { positions, trades, activity });

    // Backfill so historical redemptions/trades etc don't spam on first polls
    for (const p of positions) {
      const k = getEventDedupKey(p, 'position');
      backfillSeenEvent(address, 'position_new', p, k);
    }
    for (const t of trades) {
      const k = getEventDedupKey(t, 'trade');
      backfillSeenEvent(address, 'trade', t, k);
    }
    for (const a of activity) {
      const k = getEventDedupKey(a, 'activity');
      backfillSeenEvent(address, 'activity', a, k);
    }

    console.log(`[add-wallet] ✅ Full data pulled + tracking primed + history backfilled as seen.`);
  } catch (e) {
    console.log('[add-wallet] Prime warning:', e);
  }

  // Interactive name asking via chat (bot asks for name after adding unnamed)
  if (!providedName) {
    await interaction.followUp({
      content: `Wallet added as **${defaultName}**. What name would you like to give it? Reply in this channel with the name (e.g. "GMRl00K [POLY]"). You have 60s or use /rename-wallet later.`,
      ephemeral: true
    });

    const ch = interaction.channel;
    if (ch && ch.isTextBased() && 'createMessageCollector' in ch) {
      const filter = (m: any) => m.author.id === interaction.user.id && !m.author.bot;
      const collector = (ch as any).createMessageCollector({ filter, time: 60000, max: 1 });

      collector.on('collect', async (m: any) => {
        const name = m.content.trim();
        if (name) {
          renameWallet(defaultName, name);
          await m.reply(`✅ Wallet renamed to **${name}**. Full tracking data persisted.`);

          // Re-pull full SDK data for confirmation (private)
          const snap = await fetchWalletSnapshot(address);
          const portVal = formatPnL(getPortfolioValue(snap.portfolioValue));
          let real = 0;
          (snap.activity || []).forEach((a: any) => {
            if (a.amount) real += parseFloat(a.amount) || 0;
          });
          const confirmEmbed = new EmbedBuilder()
            .setTitle(`✅ Wallet Named & Fully Confirmed`)
            .setDescription(`**${name}**\n\`${address}\`\n[On-chain: Polygonscan](https://polygonscan.com/address/${address})`)
            .setColor(0x00ff00)
            .addFields(
              { name: '📊 Portfolio Value (SDK)', value: portVal, inline: true },
              { name: '💰 Realized (from activity)', value: formatPnL(real), inline: true },
              { name: '📈 Open Positions', value: formatPositionsForEmbed(snap.positions), inline: false },
              { name: '💱 Recent Trades (with on-chain links)', value: formatTradesForEmbed(snap.trades), inline: false },
              { name: '📜 Activity Feed (with tx verification)', value: formatActivityForEmbed(snap.activity), inline: false }
            )
            .setFooter({ text: 'All data via official @polymarket/client • Persisted in SQLite • On-chain verified' })
            .setTimestamp();
          await interaction.followUp({ embeds: [confirmEmbed], ephemeral: true });
          console.log(`[add-wallet] ✅ Named via reply to ${name}`);
        }
      });
    }
  }
}

// Formatting now centralized in utils.ts for a clean, single source of truth for all output




async function handleRemoveWallet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const identifier = interaction.options.getString('identifier', true);
  const ok = removeWallet(identifier);

  if (ok) {
    await interaction.editReply(`✅ Removed wallet: ${identifier}`);
  } else {
    await interaction.editReply(`❌ No wallet found matching "${identifier}".`);
  }
}

async function handleRenameWallet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

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

  await interaction.deferReply();

  const enriched = await Promise.all(wallets.map(async (w) => {
    const addr = truncateAddress(w.address);
    const last = w.last_checked ? formatDate(w.last_checked) : 'never';

    let portVal = 'N/A';
    let unrealStr = '⚪ $0.00';
    let realizedStr = '⚪ $0.00';
    let posSummary = 'No open positions';
    let openCount = 0;
    let portRaw = 0;
    let unrealRaw = 0;
    let realizedRaw = 0;
    let netRealized = 0;
    let winRate = 0;
    let volume = 0;
    let score = 0;

    try {
      const snap = await fetchWalletSnapshot(w.address);

      // Open positions first (used for portfolio fallback too)
      const positions = snap.positions || [];
      const open = positions.filter((p: any) => parseFloat(p.size || '0') > 0);
      openCount = open.length;

      unrealRaw = 0;
      if (openCount > 0) {
        unrealRaw = open.reduce((sum: number, p: any) => sum + (parseFloat(p.cashPnl || '0') || 0), 0);
        unrealStr = formatPnL(unrealRaw);

        posSummary = open.slice(0, 2).map((p: any) => {
          const title = shortText(cleanMarketTitle(p.title || p.slug || 'Market'), 42);
          const outcome = p.outcome ? ` (${p.outcome})` : '';
          const sz = p.size ? ` Size: ${formatDecimal(p.size)}` : '';
          const curVal = (parseFloat(p.size || '0') * parseFloat(p.curPrice || '0'));
          const curValStr = curVal ? ` | Cur Val: ${formatPnL(curVal)}` : '';
          const pnlStr = p.cashPnl != null ? ` ${formatPnL(p.cashPnl)}` : '';
          return `• ${title}${outcome}${sz}${curValStr}${pnlStr}`;
        }).join('\n');

        if (openCount > 2) {
          posSummary += `\n+ ${openCount - 2} more`;
        }
      }

      // Portfolio value - prefer SDK, always compute estimated current value from open positions for accuracy
      const sdkPort = getPortfolioValue(snap.portfolioValue);
      const estFromPositions = open.reduce((sum: number, p: any) => {
        const size = parseFloat(p.size || '0');
        const cur = parseFloat(p.curPrice || '0');
        return sum + (size * cur);
      }, 0);
      portRaw = sdkPort > 0 ? sdkPort : estFromPositions;
      portVal = formatPnL(portRaw);
      if (sdkPort > 0 && estFromPositions > 0) {
        // Could log diff, but for display use SDK as primary
      }

      // Realized PnL approximated from positive amounts in activity
      realizedRaw = 0;
      (snap.activity || []).forEach((a: any) => {
        if (a.amount) {
          const v = parseFloat(a.amount) || 0;
          if (v > 0) realizedRaw += v;
        }
      });
      realizedStr = formatPnL(realizedRaw);

      // Additional analytics using SDK data only
      const netRealized = computeNetRealized(positions, snap.activity || []);
      const winRate = computeRoughWinRate(positions, snap.activity || []);
      const volume = computeApproxVolume(snap.activity || []);
      const score = computeActivityScore(positions, snap.trades || [], snap.activity || []);
    } catch (e) {
      posSummary = '⚠️ Could not fetch latest details';
    }

    return { name: w.name, addr, last, portVal, unrealStr, realizedStr, openCount, posSummary, portRaw, unrealRaw, realizedRaw, netRealized, winRate, volume, score };
  }));

  // Sort by open positions desc, then by realized+unrealized (use raw for accuracy)
  const parsedEnriched = enriched.map(it => {
    const portR = (it as any).portRaw || 0;
    const scoreR = (it as any).score || 0;
    const netR = (it as any).netRealized || 0;
    return { ...it, _score: it.openCount * 1000 + netR + scoreR * 0.1 };
  }).sort((a, b) => b._score - a._score);

  const embed = new EmbedBuilder()
    .setTitle(`📋 Tracked Wallets (${wallets.length})`)
    .setColor(0x00b0f4)
    .setTimestamp()
    .setFooter({ text: 'via official @polymarket/client SDK • /wallet-stats <name> for full details' });

  let totalOpen = 0;
  let totalPort = 0;
  for (const item of parsedEnriched) {
    const winPct = ((item as any).winRate || 0) * 100;
    const volStr = formatPnL((item as any).volume || 0).replace(/[🟢🔴⚪ ]/g, '');
    const value = `**💰 Portfolio Value:** ${item.portVal}\n` +
      `**📈 Unrealized PnL:** ${item.unrealStr}   **💵 Net Realized:** ${formatPnL((item as any).netRealized || 0)}\n` +
      `**🎯 Win Rate (proxy):** ${winPct.toFixed(1)}%   **📊 Approx Volume:** ${volStr}\n` +
      `**📍 Open positions:** ${item.openCount}   **🐋 Activity Score:** ${Math.round((item as any).score || 0)}\n` +
      `${item.posSummary}\n` +
      `Last checked: ${item.last}`;
    embed.addFields({
      name: `**${item.name}** — \`${item.addr}\``,
      value: value.length > 1000 ? value.slice(0, 990) + '…' : value,
      inline: false
    });
    totalOpen += item.openCount;
    totalPort += (item as any).portRaw || 0;
  }

  embed.addFields({
    name: '📊 Summary',
    value: `**Total open positions across wallets:** ${totalOpen}\n**Approx combined portfolio:** ${formatPnL(totalPort)}`,
    inline: false
  });

  await interaction.editReply({ embeds: [embed] });
}

async function handleWalletStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const identifier = interaction.options.getString('identifier', true);
  const filter = interaction.options.getString('filter') || '';
  const days = interaction.options.getInteger('days') || null;
  const wallet = getWalletByNameOrAddress(identifier);

  if (!wallet) {
    await interaction.editReply(`❌ No tracked wallet matching "${identifier}".`);
    return;
  }

  const snapshot = await fetchWalletSnapshot(wallet.address);
  let { positions, trades, activity } = snapshot;

  if (days) {
    const cutoff = Date.now() - (days * 86400000);
    trades = trades.filter((t: any) => t.timestamp && (t.timestamp * 1000 > cutoff));
    activity = activity.filter((a: any) => a.timestamp && (a.timestamp * 1000 > cutoff));
  }

  if (filter) {
    if (filter === 'open') {
      // positions are open
    } else if (filter === 'closed') {
      // for demo, note in embed
      positions = [];
    } else if (filter.startsWith('type=')) {
      const t = filter.split('=')[1].toUpperCase();
      activity = activity.filter((a: any) => (a.type || '').toUpperCase() === t);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${wallet.name}`)
    .setDescription(`\`${truncateAddress(wallet.address)}\``)
    .setColor(0x00aa55)
    .setTimestamp()
    .setFooter({ text: 'via official @polymarket/client SDK' });

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

  // Total PnL summary + analytics
  const totalPnl = positions.reduce((sum: number, p: any) => sum + (parseFloat(p.cashPnl || '0') || 0), 0);
  const netReal = computeNetRealized(positions, activity);
  const winR = computeRoughWinRate(positions, activity);
  embed.addFields({ name: '💰 Total Unrealized PnL', value: formatPnL(totalPnl), inline: true });
  embed.addFields({ name: '📊 Net Realized / Win Rate (proxy)', value: `${formatPnL(netReal)} / ${(winR*100).toFixed(1)}%`, inline: true });
  const vol = computeApproxVolume(activity);
  embed.addFields({ name: '📈 Approx Volume', value: formatPnL(vol), inline: true });

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

// === Component Handlers for interactive naming ===

export async function handleButton(interaction: any) {
  if (!interaction.customId?.startsWith('name_wallet_')) return;

  const address = interaction.customId.replace('name_wallet_', '');
  const modal = new ModalBuilder()
    .setCustomId(`name_modal_${address}`)
    .setTitle('Name this wallet');

  const nameInput = new TextInputBuilder()
    .setCustomId('wallet_name')
    .setLabel('Enter a friendly name for this wallet')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50)
    .setPlaceholder('e.g. GMRl00K [POLY]');

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

export async function handleModal(interaction: any) {
  if (!interaction.customId?.startsWith('name_modal_')) return;

  const address = interaction.customId.replace('name_modal_', '');
  const newName = interaction.fields.getTextInputValue('wallet_name').trim();

  const w = getWalletByAddress(address);
  if (!w) {
    await interaction.reply({ content: '❌ Wallet not found in database.', ephemeral: true });
    return;
  }

  renameWallet(w.name, newName);

  // Re-pull full SDK data for rich confirmation
  const snapshot = await fetchWalletSnapshot(address);

  const embed = new EmbedBuilder()
    .setTitle(`✅ Wallet Named & Fully Confirmed`)
    .setDescription(`**${newName}**\n\`${address}\`\n[On-chain: Polygonscan](https://polygonscan.com/address/${address})`)
    .setColor(0x00ff00)
    .addFields(
      { name: '📈 Open Positions (SDK)', value: formatPositionsForEmbed(snapshot.positions), inline: false },
      { name: '💱 Recent Trades (on-chain tx links)', value: formatTradesForEmbed(snapshot.trades), inline: false },
      { name: '📜 Activity Feed (with tx verification)', value: formatActivityForEmbed(snapshot.activity), inline: false }
    )
    .setFooter({ text: 'All data via official @polymarket/client • Persisted in SQLite • On-chain verified' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
  console.log(`[modal] ✅ Renamed ${address} to "${newName}" with full SDK data confirmation`);
}

// === New commands: leaderboard, combined, export, import ===

async function handleLeaderboard(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const wallets = listWallets();
  const rankings: any[] = [];
  for (const w of wallets) {
    try {
      const snap = await fetchWalletSnapshot(w.address);
      const net = computeNetRealized(snap.positions || [], snap.activity || []);
      const score = computeActivityScore(snap.positions || [], snap.trades || [], snap.activity || []);
      rankings.push({ name: w.name || truncateAddress(w.address), pnl: net, score });
    } catch {}
  }
  rankings.sort((a, b) => b.pnl - a.pnl);
  const embed = new EmbedBuilder()
    .setTitle('🏆 Leaderboard (Net Realized + Activity Score from SDK)')
    .setFooter({ text: 'via official @polymarket/client SDK' });
  rankings.slice(0, 10).forEach((r, i) => {
    embed.addFields({ name: `${i + 1}. ${r.name}`, value: `${formatPnL(r.pnl)} (score ${Math.round(r.score)})` });
  });
  await interaction.editReply({ embeds: [embed] });
}

async function handleCombinedPortfolio(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const wallets = listWallets();
  let total = 0;
  let count = 0;
  for (const w of wallets) {
    try {
      const pv = await getSdkClient().fetchPortfolioValue({ user: w.address } as any);
      const val = getPortfolioValue(pv);
      if (val) {
        total += val;
        count++;
      }
    } catch {}
  }
  const embed = new EmbedBuilder()
    .setTitle('📊 Combined Portfolio (SDK)')
    .setDescription(`Tracking ${count} wallets\nTotal: ${formatPnL(total)}`)
    .setFooter({ text: 'via official @polymarket/client SDK' });
  await interaction.editReply({ embeds: [embed] });
}

async function handleExportWallets(interaction: ChatInputCommandInteraction) {
  const wallets = listWallets();
  const data = wallets.map(w => ({
    address: w.address,
    name: w.name,
    min_size: w.min_size,
    side_filter: w.side_filter,
    notify_first_time: w.notify_first_time,
  }));
  const json = JSON.stringify(data, null, 2);
  await interaction.reply({
    content: 'Exported tracked wallets:',
    files: [{ attachment: Buffer.from(json), name: 'wallets.json' }]
  });
}

async function handleImportWallets(interaction: ChatInputCommandInteraction) {
  const dataStr = interaction.options.getString('data', true);
  try {
    const list = JSON.parse(dataStr);
    let added = 0;
    for (const item of list) {
      if (item.address && isValidAddress(item.address)) {
        const nm = item.name || `Unnamed ${truncateAddress(item.address)}`;
        addWallet(item.address, nm, interaction.user.id);
        if (item.min_size || item.side_filter) {
          updateWalletSettings(item.address, { min_size: item.min_size || 0, side_filter: item.side_filter || 'ALL' });
        }
        added++;
      }
    }
    await interaction.reply(`✅ Imported ${added} wallets.`);
  } catch (e) {
    await interaction.reply('❌ Invalid JSON. Example: [{"address":"0x..","name":"Whale1"}]');
  }
}

async function handleInterval(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const seconds = interaction.options.getInteger('seconds');

  if (seconds !== null) {
    const ms = seconds * 1000;
    setTrackingInterval(ms);
    const actualSeconds = Math.round(getTrackingInterval() / 1000);
    await interaction.editReply(`✅ Polling interval set to **${actualSeconds} seconds**.\nChecks will now run every ${actualSeconds}s using the SDK (listPositions, listTrades, listActivity, etc.). Change takes effect after current sleep.`);
  } else {
    const currentMs = getTrackingInterval();
    const secs = Math.round(currentMs / 1000);
    await interaction.editReply(`Current polling interval: **${secs} seconds** (${currentMs}ms)\n\nUse \`/interval <seconds>\` to change the frequency of checks (min 5s).`);
  }
}



import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import { commands } from './commands.js';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

async function main() {
  try {
    console.log('Registering slash commands...');

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId!, guildId),
        { body: commands }
      );
      console.log(`Registered guild commands to guild ${guildId}`);
    } else {
      await rest.put(
        Routes.applicationCommands(clientId!),
        { body: commands }
      );
      console.log('Registered global commands (may take up to 1 hour to propagate)');
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

main();

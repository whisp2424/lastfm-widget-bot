import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { widgetCommand } from '../src/commands/widget.js';

const discordToken = process.env.DISCORD_TOKEN;
const discordClientId = process.env.DISCORD_CLIENT_ID;

if (!discordToken || !discordClientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(discordToken);

try {
  console.log('Registering slash commands...');
  await rest.put(Routes.applicationCommands(discordClientId), {
    body: [widgetCommand.builder.toJSON()],
  });
  console.log('Slash commands registered successfully.');
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}

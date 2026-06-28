import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { widgetCommand } from './commands/widget.js';
import { LastFmService } from './services/lastfm.js';
import { initScheduler, startScheduler } from './services/scheduler.js';
import { startWebServer } from './web/server.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

export const lastfm = new LastFmService(config.lastfmApiKey);

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user?.tag}`);

  initScheduler(lastfm);
  startScheduler();
  startWebServer();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'widget') return;

  await widgetCommand.execute(interaction, lastfm);
});

client.login(config.discordToken).catch((err) => {
  console.error('[bot] Failed to login:', err);
  process.exit(1);
});

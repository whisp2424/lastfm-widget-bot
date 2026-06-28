import {
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { getUser, upsertUser, setPrimarySource } from '../database.js';
import { refreshUserWidget } from '../services/shared.js';
import type { LastFmService } from '../services/lastfm.js';

export const widgetCommand = {
  builder: new SlashCommandBuilder()
    .setName('widget')
    .setDescription('Manage your Last.fm profile widget')
    .setIntegrationTypes([
      ApplicationIntegrationType.UserInstall,
    ])
    .setContexts([
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
      InteractionContextType.Guild,
    ])
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Link your Last.fm account to the widget')
        .addStringOption((opt) =>
          opt
            .setName('username')
            .setDescription('Your Last.fm username')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('refresh')
        .setDescription(
          'Refresh your widget with the latest Last.fm stats',
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('primary')
        .setDescription(
          'Choose which image takes priority in your widget',
        )
        .addStringOption((opt) =>
          opt
            .setName('source')
            .setDescription('The image source to prioritize')
            .setRequired(true)
            .addChoices(
              { name: 'Artist', value: 'artist' },
              { name: 'Album Cover', value: 'album' },
              { name: 'Avatar', value: 'avatar' },
            ),
        ),
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    lastfmService: LastFmService,
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      await handleSetup(interaction, lastfmService);
    } else if (subcommand === 'refresh') {
      await handleRefresh(interaction, lastfmService);
    } else if (subcommand === 'primary') {
      await handlePrimary(interaction);
    }
  },
};

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  lastfmService: LastFmService,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const username = interaction.options.getString('username', true);

  try {
    await lastfmService.getUserInfo(username);
  } catch (err) {
    console.error(`[setup] getUserInfo failed for ${username}:`, err);
    await interaction.editReply(
      `Could not find Last.fm user **${username}**. Please check the username and try again.`,
    );
    return;
  }

  upsertUser(interaction.user.id, username);

  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', config.discordClientId);
  authorizeUrl.searchParams.set('response_type', 'token');
  authorizeUrl.searchParams.set('scope', 'openid sdk.social_layer');
  authorizeUrl.searchParams.set(
    'redirect_uri',
    `${config.publicUrl}/callback`,
  );
  authorizeUrl.searchParams.set('state', interaction.user.id);

  const authorizeButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Authorize')
    .setURL(authorizeUrl.toString());

  const row =
    new ActionRowBuilder<ButtonBuilder>().addComponents(authorizeButton);

  await interaction.editReply({
    content: `Linked to Last.fm user **${username}**!\n\nTo complete setup, click the button below to authorize the application. After authorizing, close the browser tab and run \`/widget refresh\` to push your stats to the widget.`,
    components: [row],
  });
}

async function handlePrimary(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const user = getUser(interaction.user.id);

  if (!user) {
    await interaction.reply({
      content:
        'You haven\'t set up your widget yet. Use `/widget setup <username>` first.',
      ephemeral: true,
    });
    return;
  }

  const source = interaction.options.getString('source', true) as
    | 'artist'
    | 'album'
    | 'avatar';

  setPrimarySource(interaction.user.id, source);
  await interaction.reply({
    content: `Primary image set to **${source}**. Run \`/widget refresh\` to apply the change.`,
    ephemeral: true,
  });
}

async function handleRefresh(
  interaction: ChatInputCommandInteraction,
  lastfmService: LastFmService,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const user = getUser(interaction.user.id);

  if (!user) {
    await interaction.editReply(
      'You haven\'t set up your widget yet. Use `/widget setup <username>` first.',
    );
    return;
  }

  try {
    await refreshUserWidget(user, lastfmService);
    await interaction.editReply('Widget refreshed successfully!');
  } catch (err) {
    console.error(`[refresh] Failed for ${interaction.user.id}:`, err);
    await interaction.editReply(
      'An error occurred while refreshing your widget. Make sure you have authorized the application via `/widget setup`.',
    );
  }
}

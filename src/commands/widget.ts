import {
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  ComponentType,
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
        .setName('image')
        .setDescription(
          'Choose which image takes priority in your widget',
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
    } else if (subcommand === 'image') {
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

  const select = new StringSelectMenuBuilder()
    .setCustomId('primary_image_source')
    .setPlaceholder('Choose an image source...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Artist')
        .setDescription('Show the top artist image')
        .setValue('artist')
        .setEmoji('🎤'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Album Cover')
        .setDescription('Show the top track album cover')
        .setValue('album')
        .setEmoji('💿'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Avatar')
        .setDescription('Show your Last.fm avatar')
        .setValue('avatar')
        .setEmoji('👤'),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    select,
  );

  const embed = new EmbedBuilder()
    .setColor(0xba0000)
    .setTitle('Widget Primary Image')
    .setDescription(
      'Choose which image appears as the primary image on your Discord profile widget.\n\nThe selected source will be tried first, falling back to the others if unavailable.',
    )
    .addFields(
      { name: 'Current', value: `\`${user.primary_source}\``, inline: true },
    );

  const reply = await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true,
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) =>
      i.customId === 'primary_image_source' &&
      i.user.id === interaction.user.id,
    time: 60_000,
  });

  collector.on('collect', async (i) => {
    const value = i.values[0] as 'artist' | 'album' | 'avatar';
    setPrimarySource(interaction.user.id, value);

    const updatedEmbed = EmbedBuilder.from(embed).setFields(
      { name: 'Current', value: `\`${value}\``, inline: true },
    );

    await i.update({
      content: `Primary image set to **${value}**. Run \`/widget refresh\` to apply the change.`,
      embeds: [updatedEmbed],
      components: [],
    });
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch {
      // reply already cleaned up
    }
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

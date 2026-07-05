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
import { getUser, upsertUser, setPrimaryImageConfig, deauthorizeUser, setHideUsername } from '../database.js';
import { refreshUserWidget, CYCLE_PERIODS } from '../services/shared.js';
import { getNextRefreshIn, resetSchedulerTimer } from '../services/scheduler.js';
import { waitForOAuth } from '../oauth-store.js';
import type { LastFmService } from '../services/lastfm.js';
import type { PrimaryImagePeriod, PrimaryImageType, WidgetPayload, UserRow } from '../types.js';

const SUCCESS = 0xa6e3a1;
const ERROR = 0xba0000;
const INFO = 0xba0000;
const ACCENT = 0xD91C00;

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
        .setName('config')
        .setDescription(
          'Choose which image takes priority in your widget',
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('image')
        .setDescription(
          'Show details about your widget\'s primary image',
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
    } else if (subcommand === 'config') {
      await handleConfig(interaction, lastfmService);
    } else if (subcommand === 'image') {
      await handleImage(interaction, lastfmService);
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
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(ERROR)
          .setTitle('User Not Found')
          .setDescription(
            `Could not find Last.fm user **${username}**. Please check the username and try again.`,
          ),
      ],
    });
    return;
  }

  upsertUser(interaction.user.id, username);

  const existingUser = getUser(interaction.user.id);
  if (existingUser?.authorized) {
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('reauth_yes').setLabel('Yes, Reauthenticate').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('reauth_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    const msg = await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(INFO)
          .setTitle('Already Linked')
          .setDescription(`You are already linked to **${existingUser.lastfm_username}**. Do you want to reauthenticate?`),
      ],
      components: [confirmRow],
    });

    try {
      const confirm = await msg.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id,
        time: 60_000,
      });

      if (confirm.customId === 'reauth_no') {
        await confirm.update({ embeds: [new EmbedBuilder().setColor(INFO).setTitle('Cancelled').setDescription('Reauthentication cancelled.')], components: [] });
        return;
      }

      deauthorizeUser(interaction.user.id);
      await confirm.deferUpdate();
    } catch {
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(ERROR).setTitle('Timed Out').setDescription('Reauthentication prompt expired. Use `/widget setup <username>` to try again.')], components: [] });
      return;
    }
  }

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
    embeds: [
      new EmbedBuilder()
        .setColor(INFO)
        .setTitle('Link Last.fm Account')
        .setDescription(
          `Click the button below to authorize the application for **${username}**.\n\nThis will allow the bot to update your Discord profile widget.`,
        ),
    ],
    components: [row],
  });

  try {
    await waitForOAuth(interaction.user.id, 5 * 60 * 1000);
  } catch {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(ERROR)
          .setTitle('Authorization Timed Out')
          .setDescription(
            'You did not complete the authorization within 5 minutes. Use `/widget setup <username>` to try again.',
          ),
      ],
      components: [],
    });
    return;
  }

  const user = getUser(interaction.user.id);
  if (!user) return;

  try {
    await refreshUserWidget(user, lastfmService);
    resetSchedulerTimer();

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS)
          .setTitle('Setup Complete')
          .setDescription(
            'Authorization successful! Your widget has been updated with the latest stats.',
          ),
      ],
      components: [],
    });
  } catch (err) {
    console.error(`[setup] Refresh failed for ${interaction.user.id}:`, err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(ERROR)
          .setTitle('Refresh Failed')
          .setDescription(
            'Authorization successful, but the widget refresh failed. Run `/widget refresh` to try again.',
          ),
      ],
      components: [],
    });
  }
}

function formatConfig(type: string, period?: string): string {
  if (type === 'avatar') return 'Avatar';
  if (type === 'last_scrobble') return 'Last Scrobble';
  if (type === 'last_scrobble_artist') return 'Last Scrobble Artist';
  const periodLabel = period === '7d' ? 'Last 7 Days' : period === '30d' ? 'Last 30 Days' : period === 'cycle' ? 'Cycle' : 'Overall';
  return `Top ${type.charAt(0).toUpperCase() + type.slice(1)} (${periodLabel})`;
}

function timeAgo(isoString: string): string {
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:R>`;
}

function formatTimeLeft(ms: number): string {
  return `<t:${Math.floor((Date.now() + ms) / 1000)}:R>`;
}

function unauthorizedEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ERROR)
    .setTitle('Not Set Up')
    .setDescription('You haven\'t set up your widget yet. Use `/widget setup <username>` first.');
}

function buildMainConfigEmbed(user: UserRow): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(INFO)
    .setTitle('Widget Configuration')
    .setDescription(
      `Currently linked to **${user.lastfm_username}**\n\nUse the dropdown below to configure your widget settings.`
    );

  if (user.last_refresh_at) {
    embed.addFields({ name: 'Last Refreshed', value: timeAgo(user.last_refresh_at), inline: false });
  }

  const nextIn = getNextRefreshIn();
  if (nextIn !== null) {
    embed.addFields({ name: 'Next Auto-Refresh', value: formatTimeLeft(nextIn), inline: false });
  }

  return embed;
}

async function handleConfig(
  interaction: ChatInputCommandInteraction,
  lastfmService: LastFmService,
): Promise<void> {
  const initialUser = getUser(interaction.user.id);

  if (!initialUser || !initialUser.authorized) {
    await interaction.reply({ embeds: [unauthorizedEmbed()], ephemeral: true });
    return;
  }

  let user: UserRow = initialUser;

  await interaction.deferReply({ ephemeral: true });

  const refreshBtn = new ButtonBuilder()
    .setCustomId('config_refresh')
    .setLabel('Refresh')
    .setStyle(ButtonStyle.Secondary);

  const reauthBtn = new ButtonBuilder()
    .setCustomId('config_reauth')
    .setLabel('Reauthenticate')
    .setStyle(ButtonStyle.Primary);

  const backBtn = new ButtonBuilder()
    .setCustomId('config_back')
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);

  const hideUsernameBtn = new ButtonBuilder()
    .setCustomId('config_toggle_hide')
    .setLabel('...')
    .setStyle(ButtonStyle.Secondary);

  const settingsSelect = new StringSelectMenuBuilder()
    .setCustomId('config_select')
    .setPlaceholder('Select a setting...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Primary Image')
        .setDescription('Choose which image takes priority in your widget')
        .setValue('primary_image')
        .setEmoji('🖼️'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Hide Username')
        .setDescription('Replace your username with "Last.fm" in the widget')
        .setValue('hide_username')
        .setEmoji('👤'),
    );

  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId('primary_type')
    .setPlaceholder('Choose an image type...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Avatar').setDescription('Show your Last.fm avatar').setValue('avatar').setEmoji('👤'),
      new StringSelectMenuOptionBuilder().setLabel('Top Artist').setDescription('Show your top artist image').setValue('artist').setEmoji('🎤'),
      new StringSelectMenuOptionBuilder().setLabel('Top Track').setDescription('Show your top track album cover').setValue('track').setEmoji('🎵'),
      new StringSelectMenuOptionBuilder().setLabel('Top Album').setDescription('Show your top album cover').setValue('album').setEmoji('💿'),
      new StringSelectMenuOptionBuilder().setLabel('Last Scrobble').setDescription('Show the cover of your most recent scrobble').setValue('last_scrobble').setEmoji('🔄'),
      new StringSelectMenuOptionBuilder().setLabel('Last Scrobble Artist').setDescription("Show your most recent scrobble's artist picture").setValue('last_scrobble_artist').setEmoji('🎨'),
    );

  const periodSelect = new StringSelectMenuBuilder()
    .setCustomId('primary_period')
    .setPlaceholder('Choose a time period...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Overall').setDescription('All-time top track/album').setValue('overall').setEmoji('🏆'),
      new StringSelectMenuOptionBuilder().setLabel('Last 7 Days').setDescription('Top track/album from the past week').setValue('7d').setEmoji('📅'),
      new StringSelectMenuOptionBuilder().setLabel('Last 30 Days').setDescription('Top track/album from the past month').setValue('30d').setEmoji('📆'),
      new StringSelectMenuOptionBuilder().setLabel('Cycle').setDescription('Cycle through periods on each refresh').setValue('cycle').setEmoji('🔄'),
    );

  const mainEmbed = buildMainConfigEmbed(user);
  let refreshUsed = false;

  function getMainComponents(loading = false): ActionRowBuilder<any>[] {
    const select = loading ? StringSelectMenuBuilder.from(settingsSelect).setDisabled(true) : settingsSelect;
    const reauth = loading ? ButtonBuilder.from(reauthBtn).setDisabled(true) : reauthBtn;
    const btn = refreshUsed || loading ? ButtonBuilder.from(refreshBtn).setDisabled(true) : refreshBtn;
    return [
      new ActionRowBuilder<any>().addComponents(select),
      new ActionRowBuilder<any>().addComponents(reauth, btn),
    ];
  }

  function getTypeComponents(loading = false): ActionRowBuilder<any>[] {
    const select = loading ? StringSelectMenuBuilder.from(typeSelect).setDisabled(true) : typeSelect;
    const back = loading ? ButtonBuilder.from(backBtn).setDisabled(true) : backBtn;
    return [
      new ActionRowBuilder<any>().addComponents(select),
      new ActionRowBuilder<any>().addComponents(back),
    ];
  }

  function getPeriodComponents(loading = false): ActionRowBuilder<any>[] {
    const select = loading ? StringSelectMenuBuilder.from(periodSelect).setDisabled(true) : periodSelect;
    const back = loading ? ButtonBuilder.from(backBtn).setDisabled(true) : backBtn;
    return [
      new ActionRowBuilder<any>().addComponents(select),
      new ActionRowBuilder<any>().addComponents(back),
    ];
  }

  const reply = await interaction.editReply({ embeds: [mainEmbed], components: getMainComponents() });

  let state: 'main' | 'primary_image' | 'hide_username' = 'main';
  let selectedType: string | null = null;

  function getFreshUser(): void {
    const fresh = getUser(interaction.user.id);
    if (fresh) user = fresh;
  }

  const collector = reply.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    time: 120_000,
  });

  collector.on('collect', async (i) => {
    try {
      if (i.customId === 'config_select' && i.isStringSelectMenu()) {
        const value = i.values[0];
        if (value === 'primary_image') {
          state = 'primary_image';
          selectedType = null;
          await i.update({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Primary Image')
                .setDescription('Choose which image appears as the primary image on your Discord profile widget.')
                .addFields({ name: 'Current', value: formatConfig(user.primary_image_type, user.primary_image_period) }),
            ],
            components: getTypeComponents(),
          });
        } else if (value === 'hide_username') {
          state = 'hide_username';
          await i.update({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Hide Username')
                .setDescription(`When enabled, your widget will show "Last.fm" instead of your username.`),
            ],
            components: [
              new ActionRowBuilder<any>().addComponents(
                ButtonBuilder.from(hideUsernameBtn)
                  .setLabel(user.hide_username ? 'On' : 'Off')
                  .setStyle(user.hide_username ? ButtonStyle.Success : ButtonStyle.Danger),
              ),
              new ActionRowBuilder<any>().addComponents(backBtn),
            ],
          });
        }

      } else if (i.customId === 'config_back') {
        state = 'main';
        getFreshUser();
        await i.update({
          embeds: [buildMainConfigEmbed(user)],
          components: getMainComponents(),
        });

      } else if (i.customId === 'config_refresh') {
        await i.deferUpdate();
        if (!user.authorized) {
          await interaction.followUp({
            embeds: [new EmbedBuilder().setColor(ERROR).setTitle('Not Authorized').setDescription('Please reauthenticate first.')],
            ephemeral: true,
          });
          return;
        }

        refreshUsed = true;
        await interaction.editReply({ components: getMainComponents(true) });

        try {
          await refreshUserWidget(user, lastfmService);
          resetSchedulerTimer();
          getFreshUser();
          if (state === 'main') {
            await interaction.editReply({
              embeds: [buildMainConfigEmbed(user)],
              components: getMainComponents(),
            });
          }
        } catch (err) {
          console.error(`[config] Refresh failed:`, err);
          await interaction.editReply({
            embeds: [buildMainConfigEmbed(user)],
            components: getMainComponents(),
          });
          await interaction.followUp({
            embeds: [new EmbedBuilder().setColor(ERROR).setTitle('Refresh Failed').setDescription('Could not refresh your widget.')],
            ephemeral: true,
          });
        }

      } else if (i.customId === 'config_reauth') {
        await i.deferUpdate();
        await interaction.editReply({ components: getMainComponents(true) });

        const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.searchParams.set('client_id', config.discordClientId);
        authorizeUrl.searchParams.set('response_type', 'token');
        authorizeUrl.searchParams.set('scope', 'openid sdk.social_layer');
        authorizeUrl.searchParams.set('redirect_uri', `${config.publicUrl}/callback`);
        authorizeUrl.searchParams.set('state', interaction.user.id);

        const authBtn = new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Authorize')
          .setURL(authorizeUrl.toString());

        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(INFO).setTitle('Reauthorize').setDescription('Click the button below to reauthorize the application.')],
          components: [new ActionRowBuilder<any>().addComponents(authBtn)],
        });

        try {
          await waitForOAuth(interaction.user.id, 5 * 60 * 1000);
          getFreshUser();
          await interaction.editReply({
            embeds: [buildMainConfigEmbed(user)],
            components: getMainComponents(),
          });
        } catch {
          await interaction.editReply({
            embeds: [buildMainConfigEmbed(user)],
            components: getMainComponents(),
          });
        }

      } else if (i.customId === 'config_toggle_hide' && i.isButton()) {
        await i.deferUpdate();
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(INFO)
              .setTitle('Hide Username')
              .setDescription(`When enabled, your widget will show "Last.fm" instead of your username.`),
          ],
          components: [
            new ActionRowBuilder<any>().addComponents(
              ButtonBuilder.from(hideUsernameBtn).setDisabled(true),
            ),
            new ActionRowBuilder<any>().addComponents(ButtonBuilder.from(backBtn).setDisabled(true)),
          ],
        });

        const newHide = !user.hide_username;
        setHideUsername(interaction.user.id, newHide);
        user.hide_username = newHide ? 1 : 0;

        try {
          await refreshUserWidget(user, lastfmService);
          resetSchedulerTimer();
        } catch (err) {
          console.error(`[config] Refresh failed:`, err);
        }
        getFreshUser();

        state = 'main';
        await interaction.editReply({
          embeds: [buildMainConfigEmbed(user)],
          components: getMainComponents(),
        });

      } else if (i.customId === 'primary_type' && i.isStringSelectMenu()) {
        selectedType = i.values[0];
        if (selectedType === 'avatar' || selectedType === 'last_scrobble' || selectedType === 'last_scrobble_artist') {
          await i.deferUpdate();
          await interaction.editReply({ components: getTypeComponents(true) });

          setPrimaryImageConfig(interaction.user.id, selectedType as 'avatar' | 'last_scrobble' | 'last_scrobble_artist', 'overall');
          user.primary_image_type = selectedType as 'avatar' | 'last_scrobble' | 'last_scrobble_artist';
          user.primary_image_period = 'overall';
          try {
            await refreshUserWidget(user, lastfmService);
            resetSchedulerTimer();
          } catch (err) {
            console.error(`[config] Refresh failed:`, err);
          }
          getFreshUser();
          state = 'main';
          await interaction.editReply({
            embeds: [buildMainConfigEmbed(user)],
            components: getMainComponents(),
          });
        } else if (selectedType) {
          await i.update({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Primary Image')
                .setDescription(`Choose a time period for the **${formatConfig(selectedType)}** image.`)
                .addFields({ name: 'Current', value: formatConfig(user.primary_image_type, user.primary_image_period) }),
            ],
            components: getPeriodComponents(),
          });
        }

      } else if (i.customId === 'primary_period' && selectedType && i.isStringSelectMenu()) {
        await i.deferUpdate();
        await interaction.editReply({ components: getPeriodComponents(true) });

        const period = i.values[0] as PrimaryImagePeriod;
        setPrimaryImageConfig(interaction.user.id, selectedType as 'artist' | 'track' | 'album', period);
        user.primary_image_type = selectedType as 'artist' | 'track' | 'album';
        user.primary_image_period = period;
        try {
          await refreshUserWidget(user, lastfmService);
          resetSchedulerTimer();
        } catch (err) {
          console.error(`[config] Refresh failed:`, err);
        }
        getFreshUser();
        state = 'main';
        await interaction.editReply({
          embeds: [buildMainConfigEmbed(user)],
          components: getMainComponents(),
        });
      }
    } catch (err) {
      console.error(`[config] Interaction error:`, err);
    }
  });

  collector.on('end', async () => {
    try { await interaction.editReply({ components: [] }); } catch {}
  });
}

function getPeriodLabel(period: string): string {
  if (period === '7d') return 'Last 7 Days';
  if (period === '30d') return 'Last 30 Days';
  if (period === 'overall') return 'Overall';
  return period;
}

function possessive(name: string): string {
  return name.endsWith('s') || name.endsWith('S') ? `${name}'` : `${name}'s`;
}

function getField(
  dynamic: WidgetPayload['data']['dynamic'],
  name: string,
): string | number | { url: string } | undefined {
  return dynamic.find((f) => f.name === name)?.value;
}

function buildArtistEmbed(
  name: string,
  info: { tags: string; similar: string; playcount: number; listeners: number; bio: string },
  imageUrl: string | null,
  title: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(title)
    .setDescription(`**${name}**`)
    .setThumbnail(imageUrl);

  if (info.tags) {
    embed.addFields({ name: 'Tags', value: info.tags, inline: false });
  }

  embed.addFields(
    { name: 'Playcount', value: info.playcount.toLocaleString(), inline: true },
    { name: 'Listeners', value: info.listeners.toLocaleString(), inline: true },
  );

  if (info.similar) {
    embed.addFields({ name: 'Similar Artists', value: info.similar, inline: false });
  }

  if (info.bio) {
    const truncated = info.bio.length > 300 ? info.bio.slice(0, 300) + '...' : info.bio;
    embed.addFields({ name: 'About', value: truncated, inline: false });
  }

  return embed;
}

function buildAlbumEmbed(
  name: string,
  artist: string,
  info: { tags: string; tracks: string; releaseDate: string; playcount: number; listeners: number; wiki: string },
  imageUrl: string | null,
  title: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(title)
    .setDescription(`**${artist}** — ${name}`)
    .setThumbnail(imageUrl);

  embed.addFields(
    { name: 'Playcount', value: info.playcount.toLocaleString(), inline: true },
    { name: 'Listeners', value: info.listeners.toLocaleString(), inline: true },
  );

  if (info.releaseDate) {
    embed.addFields({ name: 'Release Date', value: info.releaseDate, inline: true });
  }

  if (info.tracks) {
    embed.addFields({ name: `Tracks`, value: info.tracks, inline: false });
  }

  if (info.tags) {
    embed.addFields({ name: 'Tags', value: info.tags, inline: false });
  }

  if (info.wiki) {
    const truncated = info.wiki.length > 300 ? info.wiki.slice(0, 300) + '...' : info.wiki;
    embed.addFields({ name: 'About', value: truncated, inline: false });
  }

  return embed;
}

function buildTrackEmbed(
  name: string,
  artist: string,
  info: { tags: string; album: string; duration: number; playcount: number; listeners: number },
  coverUrl: string | null,
  title: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(title)
    .setDescription(`**${artist}** — ${name}`)
    .setThumbnail(coverUrl);

  if (info.album) {
    embed.addFields({ name: 'Album', value: info.album, inline: true });
  }

  if (info.duration > 0) {
    const minutes = Math.floor(info.duration / 60);
    const seconds = info.duration % 60;
    embed.addFields({ name: 'Duration', value: `${minutes}:${seconds.toString().padStart(2, '0')}`, inline: true });
  }

  embed.addFields(
    { name: 'Playcount', value: info.playcount.toLocaleString(), inline: true },
    { name: 'Listeners', value: info.listeners.toLocaleString(), inline: true },
  );

  if (info.tags) {
    embed.addFields({ name: 'Tags', value: info.tags, inline: false });
  }

  return embed;
}

function buildAvatarEmbed(
  username: string,
  stats: { scrobbles: string | number; artists: string | number; loved: string | number; since: string },
  imageUrl: string | null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`${username} — Last.fm Profile`)
    .setThumbnail(imageUrl)
    .addFields(
      { name: 'Total Scrobbles', value: String(stats.scrobbles), inline: true },
      { name: 'Artists', value: String(stats.artists), inline: true },
      { name: 'Loved Tracks', value: String(stats.loved), inline: true },
    );

  if (stats.since) {
    embed.addFields({ name: 'Scrobbling Since', value: stats.since, inline: false });
  }

  return embed;
}

async function handleImage(
  interaction: ChatInputCommandInteraction,
  lastfmService: LastFmService,
): Promise<void> {
  const user = getUser(interaction.user.id);

  if (!user || !user.authorized) {
    await interaction.reply({ embeds: [unauthorizedEmbed()], ephemeral: true });
    return;
  }

  if (!user.cached_data) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(ERROR)
          .setTitle('No Data Yet')
          .setDescription('Your widget hasn\'t been refreshed yet. Use `/widget refresh` first.'),
      ],
      ephemeral: true,
    });
    return;
  }

  const payload: WidgetPayload = JSON.parse(user.cached_data);
  const dynamic = payload.data.dynamic;

  const gf = (name: string) => getField(dynamic, name);
  const gfs = (name: string, fallback = '—'): string => {
    const v = getField(dynamic, name);
    return v === undefined || typeof v === 'object' ? fallback : String(v);
  };

  const primaryImageField = gf('primary_image');
  const primaryImageUrl = typeof primaryImageField === 'object' ? primaryImageField.url : null;

  const type = user.primary_image_type;
  const effectivePeriod = user.primary_image_period === 'cycle'
    ? CYCLE_PERIODS[(user.cycle_index - 1 + 3) % 3]
    : user.primary_image_period;

  const userUrl = `https://www.last.fm/user/${encodeURIComponent(user.lastfm_username)}`;
  const publicBase = 'https://www.last.fm/music/';
  const tagBase = 'https://www.last.fm/tag/';
  const enc = (s: string) => encodeURIComponent(s);
  const tagLink = (t: string) => `[${t}](${tagBase}${enc(t)})`;
  const artistLink = (n: string) => `[${n}](${publicBase}${enc(n)})`;
  const trackLink = (track: string, artist: string) => `[${track}](${publicBase}${enc(artist)}/_/${enc(track)})`;

  await interaction.deferReply({ ephemeral: false });

  if (!primaryImageUrl) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(ERROR).setTitle('No Image Data').setDescription('No primary image data available. Try refreshing your widget first.')],
    });
    return;
  }

  const periodLabel = getPeriodLabel(effectivePeriod);
  const typeTitle = type === 'avatar' ? 'Avatar'
    : type === 'last_scrobble' ? 'Last Scrobble'
    : type === 'last_scrobble_artist' ? 'Last Scrobble Artist'
    : `Top ${type.charAt(0).toUpperCase() + type.slice(1)}`;
  const title = periodLabel ? `${typeTitle} — ${periodLabel}` : typeTitle;

  let embed: EmbedBuilder;
  let linkButtons: ActionRowBuilder<ButtonBuilder>;

  if (type === 'avatar') {
    embed = buildAvatarEmbed(
      payload.username,
      {
        scrobbles: gfs('total_scrobbles'),
        artists: gfs('total_artists'),
        loved: gfs('loved_tracks'),
        since: gfs('scrobbling_since', ''),
      },
      primaryImageUrl,
    );

    linkButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View Profile').setURL(userUrl),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View Library').setURL(`${userUrl}/library/artists`),
    );

  } else if (type === 'last_scrobble') {
    const recent = await lastfmService.getRecentTrack(user.lastfm_username);
    const raw = await lastfmService.getTrackInfo(recent.artist, recent.name).catch(() => null);

    embed = buildTrackEmbed(
      recent.name,
      recent.artist,
      {
        tags: raw?.tags?.length ? raw.tags.slice(0, 8).map(tagLink).join(', ') : '',
        album: raw?.album ?? '',
        duration: raw?.duration ?? 0,
        playcount: raw?.playcount ?? 0,
        listeners: raw?.listeners ?? 0,
      },
      primaryImageUrl,
      title,
    );

    const trackUrl = `${publicBase}${enc(recent.artist)}/_/${enc(recent.name)}`;

    linkButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Last.fm').setURL(trackUrl),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`View in ${possessive(user.lastfm_username)} Library`).setURL(`${userUrl}/library/music/${enc(recent.artist)}/_/${enc(recent.name)}`),
    );

  } else if (type === 'last_scrobble_artist') {
    const recent = await lastfmService.getRecentTrack(user.lastfm_username);
    const raw = await lastfmService.getArtistInfo(recent.artist).catch(() => null);

    embed = buildArtistEmbed(
      recent.artist,
      {
        tags: raw?.tags?.length ? raw.tags.slice(0, 8).map(tagLink).join(', ') : '',
        similar: raw?.similar?.length ? raw.similar.slice(0, 5).map(artistLink).join(', ') : '',
        playcount: raw?.playcount ?? 0,
        listeners: raw?.listeners ?? 0,
        bio: raw?.bio ?? '',
      },
      primaryImageUrl,
      title,
    );

    linkButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Last.fm').setURL(`${publicBase}${enc(recent.artist)}`),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`View in ${possessive(user.lastfm_username)} Library`).setURL(`${userUrl}/library/music/${enc(recent.artist)}`),
    );

  } else if (type === 'artist') {
    const suffix = effectivePeriod === 'overall' ? '' : `_${effectivePeriod}`;
    const name = String(gf(`top_artist${suffix}`) ?? '');
    if (!name || name === '—') {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(ERROR).setTitle('No Data').setDescription('No artist data available for the current period.')],
      });
      return;
    }

    const raw = await lastfmService.getArtistInfo(name).catch(() => null);

    embed = buildArtistEmbed(
      name,
      {
        tags: raw?.tags?.length ? raw.tags.slice(0, 8).map(tagLink).join(', ') : '',
        similar: raw?.similar?.length ? raw.similar.slice(0, 5).map(artistLink).join(', ') : '',
        playcount: raw?.playcount ?? 0,
        listeners: raw?.listeners ?? 0,
        bio: raw?.bio ?? '',
      },
      primaryImageUrl,
      title,
    );

    linkButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Last.fm').setURL(`${publicBase}${enc(name)}`),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`View in ${possessive(user.lastfm_username)} Library`).setURL(`${userUrl}/library/music/${enc(name)}`),
    );

  } else if (type === 'track') {
    const suffix = effectivePeriod === 'overall' ? '' : `_${effectivePeriod}`;
    const value = String(gf(`top_track${suffix}`) ?? '');
    const parts = value.split(' - ');
    const trackArtist = parts[0] ?? '';
    const trackName = parts[1] ?? '';
    if (!trackName || trackName === '—' || !trackArtist || trackArtist === '—') {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(ERROR).setTitle('No Data').setDescription('No track data available for the current period.')],
      });
      return;
    }

    const raw = await lastfmService.getTrackInfo(trackArtist, trackName).catch(() => null);

    embed = buildTrackEmbed(
      trackName,
      trackArtist,
      {
        tags: raw?.tags?.length ? raw.tags.slice(0, 8).map(tagLink).join(', ') : '',
        album: raw?.album ?? '',
        duration: raw?.duration ?? 0,
        playcount: raw?.playcount ?? 0,
        listeners: raw?.listeners ?? 0,
      },
      primaryImageUrl,
      title,
    );

    const trackUrl = `${publicBase}${enc(trackArtist)}/_/${enc(trackName)}`;

    linkButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Last.fm').setURL(trackUrl),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`View in ${possessive(user.lastfm_username)} Library`).setURL(`${userUrl}/library/music/${enc(trackArtist)}/_/${enc(trackName)}`),
    );

  } else if (type === 'album') {
    const suffix = effectivePeriod === 'overall' ? '' : `_${effectivePeriod}`;
    const value = String(gf(`top_album${suffix}`) ?? '');
    const parts = value.split(' - ');
    const albumArtist = parts[0] ?? '';
    const albumName = parts[1] ?? '';
    if (!albumName || albumName === '—' || !albumArtist || albumArtist === '—') {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(ERROR).setTitle('No Data').setDescription('No album data available for the current period.')],
      });
      return;
    }

    const raw = await lastfmService.getAlbumInfo(albumArtist, albumName).catch(() => null);

    embed = buildAlbumEmbed(
      albumName,
      albumArtist,
      {
        tags: raw?.tags?.length ? raw.tags.slice(0, 8).map(tagLink).join(', ') : '',
        tracks: raw?.tracks?.length ? raw.tracks.slice(0, 10).map((t) => trackLink(t, albumArtist)).join(', ') : '',
        releaseDate: raw?.releaseDate ?? '',
        playcount: raw?.playcount ?? 0,
        listeners: raw?.listeners ?? 0,
        wiki: raw?.wiki ?? '',
      },
      primaryImageUrl,
      title,
    );

    const albumUrl = `${publicBase}${enc(albumArtist)}/${enc(albumName)}`;

    linkButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Last.fm').setURL(albumUrl),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`View in ${possessive(user.lastfm_username)} Library`).setURL(`${userUrl}/library/music/${enc(albumArtist)}/${enc(albumName)}`),
    );
  } else {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(ERROR).setTitle('Unknown Type').setDescription('Unknown primary image type.')],
    });
    return;
  }

  await interaction.editReply({ embeds: [embed], components: [linkButtons] });
}

async function handleRefresh(
  interaction: ChatInputCommandInteraction,
  lastfmService: LastFmService,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const user = getUser(interaction.user.id);

  if (!user || !user.authorized) {
    await interaction.editReply({ embeds: [unauthorizedEmbed()] });
    return;
  }

  try {
    await refreshUserWidget(user, lastfmService);
    resetSchedulerTimer();
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS)
          .setTitle('Widget Refreshed')
          .setDescription('Your widget has been updated with the latest Last.fm stats.'),
      ],
    });
  } catch (err) {
    console.error(`[refresh] Failed for ${interaction.user.id}:`, err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(ERROR)
          .setTitle('Refresh Failed')
          .setDescription(
            'An error occurred while refreshing your widget. Make sure you have authorized the application via `/widget setup`.',
          ),
      ],
    });
  }
}

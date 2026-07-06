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
import { getUser, upsertUser, setPrimaryImageConfig, setSecondaryImageConfig, setHideUsername, deauthorizeUser, statOrderToConfig, setStatOrder } from '../database.js';
import { refreshUserWidget, CYCLE_PERIODS } from '../services/shared.js';
import { getNextRefreshIn, resetSchedulerTimer } from '../services/scheduler.js';
import { waitForOAuth } from '../oauth-store.js';
import type { LastFmService } from '../services/lastfm.js';
import { DEFAULT_STAT_ORDER } from '../types.js';
import type { PrimaryImagePeriod, SecondaryImageType, SecondaryImagePeriod, WidgetPayload, UserRow, StatKey, StatSlotConfig, StatPeriod } from '../types.js';

const SUCCESS = 0xa6e3a1;
const ERROR = 0xba0000;
const INFO = 0xba0000;

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
    .setDescription('Use the dropdown below to configure your widget settings.')
    .addFields({ name: 'Linked Account', value: `**${user.lastfm_username}**`, inline: true });

  if (user.last_refresh_at) {
    embed.addFields({ name: 'Last Refreshed', value: timeAgo(user.last_refresh_at), inline: true });
  }

  const nextIn = getNextRefreshIn();
  if (nextIn !== null) {
    embed.addFields({ name: 'Next Auto-Refresh', value: formatTimeLeft(nextIn), inline: true });
  }

  return embed;
}

const STAT_KEY_LABELS: Record<string, string> = {
  scrobbles: 'Scrobbles',
  artists: 'Artists',
  loved_tracks: 'Loved Tracks',
  top_track: 'Top Track',
  top_album: 'Top Album',
  top_artist: 'Top Artist',
};

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

  const hideUsernameSelect = new StringSelectMenuBuilder()
    .setCustomId('config_hide_username')
    .setPlaceholder('Choose visibility...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Show Username').setDescription('Display your Last.fm username in the widget').setValue('show').setEmoji('👤'),
      new StringSelectMenuOptionBuilder().setLabel('Hide Username').setDescription('Replace your username with "Last.fm"').setValue('hide').setEmoji('🔒'),
    );

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
        .setLabel('Secondary Image')
        .setDescription('Choose a secondary image for your widget')
        .setValue('secondary_image')
        .setEmoji('🖼️'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Widget Editor')
        .setDescription('Customize your widget stats')
        .setValue('stat_order')
        .setEmoji('✏️'),
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

  const secondaryTypeSelect = StringSelectMenuBuilder.from(typeSelect).setCustomId('secondary_type');
  const secondaryPeriodSelect = StringSelectMenuBuilder.from(periodSelect).setCustomId('secondary_period');

  // ---- Widget Editor (was "Stat Order") ----

  const saveBtn = new ButtonBuilder()
    .setCustomId('stat_order_save')
    .setLabel('Save Changes')
    .setStyle(ButtonStyle.Success);

  const resetOrderBtn = new ButtonBuilder()
    .setCustomId('stat_order_reset')
    .setLabel('Reset All')
    .setStyle(ButtonStyle.Secondary);

  const slotPeriodSelect = new StringSelectMenuBuilder()
    .setCustomId('slot_period')
    .setPlaceholder('Choose period...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Overall').setDescription('All-time stats').setValue('overall'),
      new StringSelectMenuOptionBuilder().setLabel('Last 7 Days').setDescription('Stats from the past week').setValue('7d'),
      new StringSelectMenuOptionBuilder().setLabel('Last 30 Days').setDescription('Stats from the past month').setValue('30d'),
      new StringSelectMenuOptionBuilder().setLabel('Cycle').setDescription('Cycle through periods on each refresh').setValue('cycle'),
    );

  const changePeriodBtn = new ButtonBuilder()
    .setCustomId('slot_change_period')
    .setLabel('Change period')
    .setStyle(ButtonStyle.Secondary);

  const toggleSuffixBtn = new ButtonBuilder()
    .setCustomId('slot_toggle_suffix')
    .setLabel('Hide period suffix')
    .setStyle(ButtonStyle.Secondary);

  function buildToggleSuffixBtn(show: boolean): ButtonBuilder {
    return ButtonBuilder.from(toggleSuffixBtn)
      .setLabel(show ? 'Hide period suffix' : 'Show period suffix')
      .setStyle(ButtonStyle.Secondary);
  }

  const switchStatBtn = new ButtonBuilder()
    .setCustomId('slot_switch_stat')
    .setLabel('Switch stats')
    .setStyle(ButtonStyle.Secondary);

  const saveSlotBtn = new ButtonBuilder()
    .setCustomId('slot_save_slot')
    .setLabel('Save changes')
    .setStyle(ButtonStyle.Success);

  const cancelSlotBtn = new ButtonBuilder()
    .setCustomId('slot_cancel')
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);

  const confirmSelectBtn = new ButtonBuilder()
    .setCustomId('slot_select_confirm')
    .setLabel('Save changes')
    .setStyle(ButtonStyle.Success);

  const cancelSelectBtn = new ButtonBuilder()
    .setCustomId('slot_select_cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  let pendingSlotConfig: StatSlotConfig | null = null;
  let selectionMode: 'period' | 'stat' | null = null;

  function parseSlots(): StatSlotConfig[] {
    return statOrderToConfig(user.stat_order, user.show_period_suffix === 1);
  }

  function getPeriodSuffix(period: string): string {
    if (period === '7d') return 'last 7d';
    if (period === '30d') return 'last 30d';
    if (period === 'cycle') return 'cycle';
    return 'overall';
  }

  function getResolvedPeriodLabel(period: string): string {
    if (period === 'cycle') return CYCLE_PERIODS[(user.cycle_index - 1 + 3) % 3];
    return getPeriodSuffix(period);
  }

  function buildWidgetEmbed(slots: StatSlotConfig[], unsaved: boolean): EmbedBuilder {
    const title = unsaved ? 'Widget Editor (unsaved)' : 'Widget Editor';
    const embed = new EmbedBuilder()
      .setColor(INFO)
      .setTitle(title)
      .setDescription('Select a slot to edit below.')
      .setFooter({ text: 'Press Save Changes to apply.' });

    if (user.cached_data) {
      try {
        const payload: WidgetPayload = JSON.parse(user.cached_data);
        const img = payload.data.dynamic.find(f => f.name === 'primary_image');
        if (img && img.type === 3) embed.setThumbnail((img.value as { url: string }).url);
        for (let i = 0; i < 6; i++) {
          const slot = slots[i];
          const val = payload.data.dynamic.find(f => f.name === `stat_value_${i}`);
          const statName = STAT_KEY_LABELS[slot.key] ?? slot.key;
          const subtitle = slot.showSuffix ? `${statName} (${getResolvedPeriodLabel(slot.period)})` : statName;
          embed.addFields({
            name: val ? String(val.value) : '\u200b',
            value: subtitle,
            inline: true,
          });
        }
      } catch { /* fall through */ }
    }

    return embed;
  }

  function buildSlotPickSelect(slots: StatSlotConfig[]): StringSelectMenuBuilder {
    const select = new StringSelectMenuBuilder()
      .setCustomId('slot_pick')
      .setPlaceholder('Choose a slot to edit...');
    slots.forEach((slot, i) => {
      select.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(`Slot #${i + 1} (${STAT_KEY_LABELS[slot.key]})`)
          .setValue(`${i}`),
      );
    });
    return select;
  }

  const statAssignSelect = new StringSelectMenuBuilder()
    .setCustomId('stat_assign')
    .setPlaceholder('Replace with...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Scrobbles').setValue('scrobbles'),
      new StringSelectMenuOptionBuilder().setLabel('Artists').setValue('artists'),
      new StringSelectMenuOptionBuilder().setLabel('Loved Tracks').setValue('loved_tracks'),
      new StringSelectMenuOptionBuilder().setLabel('Top Track').setValue('top_track'),
      new StringSelectMenuOptionBuilder().setLabel('Top Album').setValue('top_album'),
      new StringSelectMenuOptionBuilder().setLabel('Top Artist').setValue('top_artist'),
    );

  function buildWidgetComponents(slots: StatSlotConfig[], loading = false): ActionRowBuilder<any>[] {
    const pick = loading ? StringSelectMenuBuilder.from(buildSlotPickSelect(slots)).setDisabled(true) : buildSlotPickSelect(slots);
    const back = loading ? ButtonBuilder.from(backBtn).setDisabled(true) : backBtn;
    const reset = loading ? ButtonBuilder.from(resetOrderBtn).setDisabled(true) : resetOrderBtn;
    const save = loading ? ButtonBuilder.from(saveBtn).setDisabled(true) : saveBtn;
    return [
      new ActionRowBuilder<any>().addComponents(pick),
      new ActionRowBuilder<any>().addComponents(save, back, reset),
    ];
  }

  function getSlotDetailPayload(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
    if (selectedSlot === null || !pendingSlotConfig) return { embeds: [], components: [] };
    const slot = pendingSlotConfig;
    const resolvedLabel = getResolvedPeriodLabel(slot.period);
    const showSuffix = slot.showSuffix;
    const statName = STAT_KEY_LABELS[slot.key] ?? slot.key;
    const subtitle = showSuffix ? `${statName} (${resolvedLabel})` : statName;

    const statLabel = (STAT_KEY_LABELS[slot.key] ?? slot.key).toLowerCase();

    let periodText: string;
    if (slot.period === 'overall') {
      periodText = `Currently showing overall ${statLabel}`;
    } else if (slot.period === 'cycle') {
      periodText = `Currently using cycle period, showing ${statLabel} for the ${resolvedLabel}`;
    } else {
      periodText = `Currently showing ${statLabel} for the ${resolvedLabel}`;
    }

    let statValue = '\u200b';
    if (user.cached_data) {
      try {
        const payload: WidgetPayload = JSON.parse(user.cached_data);
        const val = payload.data.dynamic.find(f => f.name === `stat_value_${selectedSlot}`);
        if (val) statValue = String(val.value);
      } catch {}
    }

    return {
      embeds: [
        new EmbedBuilder()
          .setColor(INFO)
          .setTitle(`Editing Slot #${selectedSlot + 1}`)
          .addFields({ name: statValue, value: subtitle, inline: false })
          .setFooter({ text: `${periodText}, period suffix will be ${showSuffix ? 'shown' : 'hidden'}.` }),
      ],
      components: [
        new ActionRowBuilder<any>().addComponents(changePeriodBtn, buildToggleSuffixBtn(showSuffix)),
        new ActionRowBuilder<any>().addComponents(saveSlotBtn, switchStatBtn, cancelSlotBtn),
      ],
    };
  }

  async function slotDetailView(i: any): Promise<void> {
    const payload = getSlotDetailPayload();
    if (payload.embeds.length) await i.update(payload);
  }

  function getPeriodSelectComponents(): ActionRowBuilder<any>[] {
    return [
      new ActionRowBuilder<any>().addComponents(slotPeriodSelect),
      new ActionRowBuilder<any>().addComponents(confirmSelectBtn, cancelSelectBtn),
    ];
  }

  function getStatSelectComponents(): ActionRowBuilder<any>[] {
    return [
      new ActionRowBuilder<any>().addComponents(statAssignSelect),
      new ActionRowBuilder<any>().addComponents(confirmSelectBtn, cancelSelectBtn),
    ];
  }

  let selectedSlot: number | null = null;
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

  function getSecondaryTypeComponents(loading = false): ActionRowBuilder<any>[] {
    const select = loading ? StringSelectMenuBuilder.from(secondaryTypeSelect).setDisabled(true) : secondaryTypeSelect;
    const back = loading ? ButtonBuilder.from(backBtn).setDisabled(true) : backBtn;
    return [
      new ActionRowBuilder<any>().addComponents(select),
      new ActionRowBuilder<any>().addComponents(back),
    ];
  }

  function getSecondaryPeriodComponents(loading = false): ActionRowBuilder<any>[] {
    const select = loading ? StringSelectMenuBuilder.from(secondaryPeriodSelect).setDisabled(true) : secondaryPeriodSelect;
    const back = loading ? ButtonBuilder.from(backBtn).setDisabled(true) : backBtn;
    return [
      new ActionRowBuilder<any>().addComponents(select),
      new ActionRowBuilder<any>().addComponents(back),
    ];
  }

  const reply = await interaction.editReply({ embeds: [mainEmbed], components: getMainComponents() });

  let state: 'main' | 'primary_image' | 'secondary_image' | 'hide_username' | 'stat_order' = 'main';
  let selectedType: string | null = null;
  let selectedSecondaryType: string | null = null;
  let pendingChanges = false;

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
                .setDescription('Choose whether your Last.fm username appears in the widget.')
                .addFields({ name: 'Current', value: user.hide_username ? 'Hidden' : 'Visible', inline: true }),
            ],
            components: [
              new ActionRowBuilder<any>().addComponents(hideUsernameSelect),
              new ActionRowBuilder<any>().addComponents(backBtn),
            ],
          });
        } else if (value === 'secondary_image') {
          state = 'secondary_image';
          selectedSecondaryType = null;
          await i.update({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Secondary Image')
                .setDescription('Choose which image appears as the secondary image on your Discord profile widget.')
                .addFields({ name: 'Current', value: formatConfig(user.secondary_image_type, user.secondary_image_period) }),
            ],
            components: getSecondaryTypeComponents(),
          });
        } else if (value === 'stat_order') {
          state = 'stat_order';
          selectedSlot = null;
          pendingSlotConfig = null;
          pendingChanges = false;
          const slots = parseSlots();
          await i.update({
            embeds: [buildWidgetEmbed(slots, false)],
            components: buildWidgetComponents(slots),
          });
        }

      } else if (i.customId === 'config_back') {
        if (state === 'stat_order' && selectedSlot !== null) {
          selectedSlot = null;
          pendingSlotConfig = null;
          const slots = parseSlots();
          await i.update({
            embeds: [buildWidgetEmbed(slots, pendingChanges)],
            components: buildWidgetComponents(slots),
          });
        } else if (state === 'primary_image' && selectedType) {
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
        } else if (state === 'secondary_image' && selectedSecondaryType) {
          selectedSecondaryType = null;
          await i.update({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Secondary Image')
                .setDescription('Choose which image appears as the secondary image on your Discord profile widget.')
                .addFields({ name: 'Current', value: formatConfig(user.secondary_image_type, user.secondary_image_period) }),
            ],
            components: getSecondaryTypeComponents(),
          });
        } else {
          if (pendingChanges) {
            setStatOrder(interaction.user.id, parseSlots());
            try {
              await refreshUserWidget(user, lastfmService);
              resetSchedulerTimer();
            } catch {}
            getFreshUser();
            pendingChanges = false;
          }
          state = 'main';
          getFreshUser();
          await i.update({
            embeds: [buildMainConfigEmbed(user)],
            components: getMainComponents(),
          });
        }

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

      } else if (i.customId === 'config_hide_username' && i.isStringSelectMenu()) {
        const hide = i.values[0] === 'hide';
        await i.deferUpdate();
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(INFO)
              .setTitle('Hide Username')
              .setDescription('Choose whether your Last.fm username appears in the widget.'),
          ],
          components: [
            new ActionRowBuilder<any>().addComponents(
              StringSelectMenuBuilder.from(hideUsernameSelect).setDisabled(true),
            ),
            new ActionRowBuilder<any>().addComponents(ButtonBuilder.from(backBtn).setDisabled(true)),
          ],
        });

        setHideUsername(interaction.user.id, hide);
        user.hide_username = hide ? 1 : 0;

        try {
          await refreshUserWidget(user, lastfmService);
          resetSchedulerTimer();
        } catch (err) {
          console.error(`[config] Refresh failed:`, err);
        }
        getFreshUser();

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(INFO)
              .setTitle('Hide Username')
              .setDescription('Choose whether your Last.fm username appears in the widget.')
              .addFields({ name: 'Current', value: user.hide_username ? 'Hidden' : 'Visible', inline: true }),
          ],
          components: [
            new ActionRowBuilder<any>().addComponents(hideUsernameSelect),
            new ActionRowBuilder<any>().addComponents(backBtn),
          ],
        });

      } else if (i.customId === 'slot_pick' && i.isStringSelectMenu()) {
        selectedSlot = parseInt(i.values[0], 10);
        const slots = parseSlots();
        pendingSlotConfig = { ...slots[selectedSlot] };
        await slotDetailView(i);

      } else if (i.customId === 'slot_toggle_suffix') {
        if (pendingSlotConfig) pendingSlotConfig.showSuffix = !pendingSlotConfig.showSuffix;
        await slotDetailView(i);

      } else if (i.customId === 'slot_change_period') {
        selectionMode = 'period';
        await i.update({ components: getPeriodSelectComponents() });

      } else if (i.customId === 'slot_switch_stat') {
        selectionMode = 'stat';
        await i.update({ components: getStatSelectComponents() });

      } else if (i.customId === 'slot_period' && i.isStringSelectMenu() && selectionMode === 'period') {
        if (pendingSlotConfig) pendingSlotConfig.period = i.values[0] as StatPeriod;
        selectionMode = null;
        await slotDetailView(i);

      } else if (i.customId === 'stat_assign' && i.isStringSelectMenu() && selectionMode === 'stat') {
        if (pendingSlotConfig) pendingSlotConfig.key = i.values[0] as StatKey;
        selectionMode = null;
        await slotDetailView(i);

      } else if (i.customId === 'slot_select_confirm') {
        selectionMode = null;
        await slotDetailView(i);

      } else if (i.customId === 'slot_select_cancel') {
        selectionMode = null;
        await slotDetailView(i);

      } else if (i.customId === 'slot_save_slot') {
        if (selectedSlot !== null && pendingSlotConfig) {
          const slots = parseSlots();
          slots[selectedSlot] = pendingSlotConfig;
          user.stat_order = JSON.stringify(slots);
          pendingChanges = true;
        }
        selectedSlot = null;
        pendingSlotConfig = null;
        selectionMode = null;
        const slots = parseSlots();
        await i.update({
          embeds: [buildWidgetEmbed(slots, true)],
          components: buildWidgetComponents(slots),
        });

      } else if (i.customId === 'slot_cancel') {
        selectedSlot = null;
        pendingSlotConfig = null;
        selectionMode = null;
        const slots = parseSlots();
        await i.update({
          embeds: [buildWidgetEmbed(slots, pendingChanges)],
          components: buildWidgetComponents(slots),
        });

      } else if (i.customId === 'stat_order_reset') {
        user.stat_order = JSON.stringify(DEFAULT_STAT_ORDER);
        pendingChanges = true;
        await i.update({
          embeds: [buildWidgetEmbed(DEFAULT_STAT_ORDER, true)],
          components: buildWidgetComponents(DEFAULT_STAT_ORDER),
        });

      } else if (i.customId === 'stat_order_save') {
        await i.deferUpdate();
        const slots = parseSlots();
        await interaction.editReply({ components: buildWidgetComponents(slots, true) });

        setStatOrder(interaction.user.id, slots);

        try {
          await refreshUserWidget(user, lastfmService);
          resetSchedulerTimer();
        } catch (err) {
          console.error(`[config] Refresh failed:`, err);
        }
        getFreshUser();
        pendingChanges = false;

        const freshSlots = parseSlots();
        await interaction.editReply({
          embeds: [buildWidgetEmbed(freshSlots, false)],
          components: buildWidgetComponents(freshSlots),
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
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Primary Image')
                .setDescription('Choose which image appears as the primary image on your Discord profile widget.')
                .addFields({ name: 'Current', value: formatConfig(user.primary_image_type, user.primary_image_period) }),
            ],
            components: getTypeComponents(),
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
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(INFO)
              .setTitle('Primary Image')
              .setDescription(`Choose a time period for the **${formatConfig(selectedType)}** image.`)
              .addFields({ name: 'Current', value: formatConfig(user.primary_image_type, user.primary_image_period) }),
          ],
          components: getPeriodComponents(),
        });
      } else if (i.customId === 'secondary_type' && i.isStringSelectMenu()) {
        selectedSecondaryType = i.values[0];
        if (selectedSecondaryType === 'avatar' || selectedSecondaryType === 'last_scrobble' || selectedSecondaryType === 'last_scrobble_artist') {
          await i.deferUpdate();
          await interaction.editReply({ components: getSecondaryTypeComponents(true) });

          setSecondaryImageConfig(interaction.user.id, selectedSecondaryType as 'avatar' | 'last_scrobble' | 'last_scrobble_artist', 'overall');
          user.secondary_image_type = selectedSecondaryType as 'avatar' | 'last_scrobble' | 'last_scrobble_artist';
          user.secondary_image_period = 'overall';
          try {
            await refreshUserWidget(user, lastfmService);
            resetSchedulerTimer();
          } catch (err) {
            console.error(`[config] Refresh failed:`, err);
          }
          getFreshUser();
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Secondary Image')
                .setDescription('Choose which image appears as the secondary image on your Discord profile widget.')
                .addFields({ name: 'Current', value: formatConfig(user.secondary_image_type, user.secondary_image_period) }),
            ],
            components: getSecondaryTypeComponents(),
          });
        } else if (selectedSecondaryType) {
          await i.update({
            embeds: [
              new EmbedBuilder()
                .setColor(INFO)
                .setTitle('Secondary Image')
                .setDescription(`Choose a time period for the **${formatConfig(selectedSecondaryType)}** image.`)
                .addFields({ name: 'Current', value: formatConfig(user.secondary_image_type, user.secondary_image_period) }),
            ],
            components: getSecondaryPeriodComponents(),
          });
        }

      } else if (i.customId === 'secondary_period' && selectedSecondaryType && i.isStringSelectMenu()) {
        await i.deferUpdate();
        await interaction.editReply({ components: getSecondaryPeriodComponents(true) });

        const period = i.values[0] as SecondaryImagePeriod;
        setSecondaryImageConfig(interaction.user.id, selectedSecondaryType as 'artist' | 'track' | 'album', period);
        user.secondary_image_type = selectedSecondaryType as 'artist' | 'track' | 'album';
        user.secondary_image_period = period;
        try {
          await refreshUserWidget(user, lastfmService);
          resetSchedulerTimer();
        } catch (err) {
          console.error(`[config] Refresh failed:`, err);
        }
        getFreshUser();
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(INFO)
              .setTitle('Secondary Image')
              .setDescription(`Choose a time period for the **${formatConfig(selectedSecondaryType)}** image.`)
              .addFields({ name: 'Current', value: formatConfig(user.secondary_image_type, user.secondary_image_period) }),
          ],
          components: getSecondaryPeriodComponents(),
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
    .setColor(INFO)
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
    .setColor(INFO)
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
    .setColor(INFO)
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
    .setColor(INFO)
    .setTitle(`${username} — Last.fm Profile`)
    .setThumbnail(imageUrl);

  if (stats.since) {
    embed.addFields({ name: 'Scrobbling Since', value: stats.since, inline: false });
  }

  embed.addFields(
    { name: 'Total Scrobbles', value: `**${stats.scrobbles}** scrobbles`, inline: false },
    { name: 'Loved Tracks', value: `**${stats.loved}** loved tracks`, inline: false },
    { name: 'Artists', value: `**${stats.artists}** different artists`, inline: false },
  );

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

  const cachedStats: Record<string, string> = user.cached_stats ? JSON.parse(user.cached_stats) : {};

  const gf = (name: string) => {
    const fromPayload = getField(dynamic, name);
    if (fromPayload !== undefined) return fromPayload;
    return cachedStats[name] as string | number | { url: string } | undefined;
  };
  const gfs = (name: string, fallback = '—'): string => {
    const v = gf(name);
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

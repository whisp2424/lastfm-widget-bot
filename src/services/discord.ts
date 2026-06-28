import { config } from '../config.js';
import type { WidgetPayload } from '../types.js';

const API_BASE = 'https://discord.com/api/v9';

export async function syncWidget(
  discordUserId: string,
  payload: WidgetPayload,
): Promise<void> {
  const url = `${API_BASE}/applications/${config.discordClientId}/users/${discordUserId}/identities/0/profile`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${config.discordToken}`,
      'User-Agent':
        'DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
}

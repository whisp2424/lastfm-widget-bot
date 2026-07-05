import { config } from '../config.js';
import type { WidgetPayload } from '../types.js';

const API_BASE = 'https://discord.com/api/v9';

async function patchWidget(
  identityId: string,
  discordUserId: string,
  payload: WidgetPayload,
): Promise<Response> {
  const url = `${API_BASE}/applications/${config.discordClientId}/users/${discordUserId}/identities/${identityId}/profile`;

  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${config.discordToken}`,
      'User-Agent':
        'DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)',
    },
    body: JSON.stringify(payload),
  });
}

export async function syncWidget(
  discordUserId: string,
  payload: WidgetPayload,
): Promise<void> {
  let response = await patchWidget(discordUserId, discordUserId, payload);

  if (!response.ok) {
    const text = await response.text();
    const body = tryParse(text);

    if (body?.code === 50035 && hasMismatchError(body)) {
      response = await patchWidget('0', discordUserId, payload);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error (${response.status}): ${text}`);
  }
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasMismatchError(body: Record<string, unknown>): boolean {
  const errors = body.errors as Record<string, { _errors?: { code?: string }[] }> | undefined;
  return errors?.provider_issued_user_id?._errors?.some(
    (e) => e.code === 'APPLICATION_IDENTITY_PROVIDER_USER_ID_MISMATCH',
  ) ?? false;
}

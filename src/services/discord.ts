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

async function patchWithRetry(
  identityId: string,
  discordUserId: string,
  payload: WidgetPayload,
): Promise<Response> {
  let response = await patchWidget(identityId, discordUserId, payload);

  if (response.status === 429) {
    await sleep(await getRetryAfterMs(response));
    response = await patchWidget(identityId, discordUserId, payload);
  }

  return response;
}

async function getRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000 + 500, 30_000);
  }

  try {
    const body = (await response.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === 'number') {
      return Math.min(body.retry_after * 1000 + 500, 30_000);
    }
  } catch {
    // fall through to default
  }

  return 5_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncWidget(
  discordUserId: string,
  payload: WidgetPayload,
): Promise<void> {
  let response = await patchWithRetry(discordUserId, discordUserId, payload);

  if (!response.ok) {
    const text = await response.text();
    const body = tryParse(text);

    if (body?.code === 50035 && hasMismatchError(body)) {
      response = await patchWithRetry('0', discordUserId, payload);
    } else {
      throw new Error(`Discord API error (${response.status}): ${text}`);
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

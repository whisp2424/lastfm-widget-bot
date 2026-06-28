import { getAllAuthorizedUsers } from '../database.js';
import { refreshUserWidget } from './shared.js';
import type { LastFmService } from './lastfm.js';

const AUTO_REFRESH_INTERVAL = 1_800_000;
const DELAY_BETWEEN_USERS_MS = 2_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastfmService: LastFmService | null = null;

export function initScheduler(svc: LastFmService): void {
  lastfmService = svc;
}

export function startScheduler(): void {
  if (intervalHandle) return;
  if (!lastfmService) {
    console.warn('[scheduler] LastFmService not initialized yet');
    return;
  }

  void runAutoRefresh();

  intervalHandle = setInterval(() => {
    void runAutoRefresh();
  }, AUTO_REFRESH_INTERVAL);
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function runAutoRefresh(): Promise<void> {
  const users = getAllAuthorizedUsers();
  if (!lastfmService) return;

  for (const user of users) {
    try {
      await refreshUserWidget(user, lastfmService);
      await sleep(DELAY_BETWEEN_USERS_MS);
    } catch (err) {
      console.error(
        `[scheduler] Failed to refresh user ${user.discord_id}:`,
        err,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

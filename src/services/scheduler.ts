import { getAllAuthorizedUsers, getSchedulerNextRefresh, setSchedulerNextRefresh } from '../database.js';
import { refreshUserWidget } from './shared.js';
import type { LastFmService } from './lastfm.js';

const AUTO_REFRESH_INTERVAL = 1_800_000;
const DELAY_BETWEEN_USERS_MS = 2_000;

let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
let lastfmService: LastFmService | null = null;

export function initScheduler(svc: LastFmService): void {
  lastfmService = svc;
}

export function startScheduler(): void {
  if (timeoutHandle) return;
  if (!lastfmService) {
    console.warn('[scheduler] LastFmService not initialized yet');
    return;
  }

  scheduleNext();
}

function scheduleNext(): void {
  let nextRefreshAt = getSchedulerNextRefresh();
  const now = Date.now();

  if (nextRefreshAt === null || nextRefreshAt <= now) {
    nextRefreshAt = now + AUTO_REFRESH_INTERVAL;
    setSchedulerNextRefresh(new Date(nextRefreshAt).toISOString());
  }

  const delay = nextRefreshAt - now;

  timeoutHandle = setTimeout(() => {
    void runAutoRefresh();
    const next = Date.now() + AUTO_REFRESH_INTERVAL;
    setSchedulerNextRefresh(new Date(next).toISOString());
    scheduleNext();
  }, delay);
}

export function getNextRefreshIn(): number | null {
  const nextRefreshAt = getSchedulerNextRefresh();
  if (nextRefreshAt === null) return null;
  return Math.max(0, nextRefreshAt - Date.now());
}

export function resetSchedulerTimer(): void {
  const next = Date.now() + AUTO_REFRESH_INTERVAL;
  setSchedulerNextRefresh(new Date(next).toISOString());
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  scheduleNext();
}

export { AUTO_REFRESH_INTERVAL };

export function stopScheduler(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
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

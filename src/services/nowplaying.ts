import { getAllAuthorizedUsers } from '../database.js';
import { refreshUserWidget } from './shared.js';
import { resetSchedulerTimer } from './scheduler.js';
import type { LastFmService } from './lastfm.js';

const FAST_INTERVAL = 45_000;
const SLOW_INTERVAL = 300_000;
const DELAY_BETWEEN_USERS = 1_500;
const IDLE_THRESHOLD = 3;

interface TrackState {
  artist: string;
  track: string;
  nowPlaying: boolean;
  idleCount: number;
}

export class NowPlayingMonitor {
  private lastfmService: LastFmService;
  private states = new Map<string, TrackState>();
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(lastfmService: LastFmService) {
    this.lastfmService = lastfmService;
  }

  start(): void {
    if (this.timeoutHandle) return;
    console.log('[nowplaying] Starting now-playing monitor');
    void this.poll();
  }

  stop(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.states.clear();
  }

  private scheduleNext(anyActive: boolean): void {
    const delay = anyActive ? FAST_INTERVAL : SLOW_INTERVAL;
    this.timeoutHandle = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    const users = getAllAuthorizedUsers();
    let anyActive = false;

    for (const user of users) {
      try {
        const recent = await this.lastfmService.getRecentTrack(user.lastfm_username);
        const curr: TrackState = {
          artist: recent.artist,
          track: recent.name,
          nowPlaying: recent.nowPlaying,
          idleCount: 0,
        };

        const prev = this.states.get(user.discord_id);

        if (prev) {
          const changed = prev.nowPlaying !== curr.nowPlaying
            || (curr.nowPlaying && (prev.artist !== curr.artist || prev.track !== curr.track));

          if (changed) {
            console.log(
              `[nowplaying] ${user.lastfm_username} now-playing changed (playing: ${curr.nowPlaying}, artist: ${curr.artist}, track: ${curr.track}), refreshing widget`,
            );
            await refreshUserWidget(user, this.lastfmService);
            resetSchedulerTimer();
          }
        }

        curr.idleCount = curr.nowPlaying ? 0 : (prev?.idleCount ?? 0) + 1;

        if (curr.idleCount < IDLE_THRESHOLD) anyActive = true;

        this.states.set(user.discord_id, curr);
        await sleep(DELAY_BETWEEN_USERS);
      } catch (err) {
        console.error(`[nowplaying] Failed to poll ${user.lastfm_username}:`, err);
      }
    }

    this.scheduleNext(anyActive);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { getAllAuthorizedUsers } from '../database.js';
import { refreshUserWidget } from './shared.js';
import { resetSchedulerTimer } from './scheduler.js';
import type { LastFmService } from './lastfm.js';

const POLL_INTERVAL = 45_000;
const DELAY_BETWEEN_USERS = 1_500;

interface TrackState {
  artist: string;
  track: string;
  nowPlaying: boolean;
}

export class NowPlayingMonitor {
  private lastfmService: LastFmService;
  private states = new Map<string, TrackState>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(lastfmService: LastFmService) {
    this.lastfmService = lastfmService;
  }

  start(): void {
    if (this.intervalHandle) return;
    console.log('[nowplaying] Starting now-playing monitor');
    void this.poll();
    this.intervalHandle = setInterval(() => void this.poll(), POLL_INTERVAL);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.states.clear();
  }

  private async poll(): Promise<void> {
    const users = getAllAuthorizedUsers();
    for (const user of users) {
      try {
        const recent = await this.lastfmService.getRecentTrack(user.lastfm_username);
        const curr: TrackState = {
          artist: recent.artist,
          track: recent.name,
          nowPlaying: recent.nowPlaying,
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

        this.states.set(user.discord_id, curr);
        await sleep(DELAY_BETWEEN_USERS);
      } catch (err) {
        console.error(`[nowplaying] Failed to poll ${user.lastfm_username}:`, err);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

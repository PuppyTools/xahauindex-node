import { isRateLimited, rateLimitWaitMs } from './rateLimit.js';
import { sleep } from './retry.js';

export type QuotaLane = 'live' | 'backfill';

export const BACKFILL_QUOTA_PAUSE_MS = 15_000;

export class NodeQuota {
  private coolUntil = 0;
  private backfillPauseUntil = 0;
  private liveDepth = 0;
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly backfillPauseExtraMs = BACKFILL_QUOTA_PAUSE_MS) {}

  get liveBusy(): boolean {
    return this.liveDepth > 0;
  }

  coolDown(waitMs: number, extras?: { pauseBackfillMs?: number }): void {
    const until = Date.now() + Math.max(0, waitMs);
    if (until > this.coolUntil) {
      this.coolUntil = until;
    }
    const pause = extras?.pauseBackfillMs ?? 0;
    if (pause > 0) {
      this.backfillPauseUntil = Math.max(this.backfillPauseUntil, Date.now() + pause);
    }
  }

  beginLive(): void {
    this.liveDepth += 1;
  }

  endLive(): void {
    this.liveDepth = Math.max(0, this.liveDepth - 1);
  }

  async waitReady(lane: QuotaLane, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('aborted');
      }
      const now = Date.now();
      const cool = this.coolUntil - now;
      if (cool > 0) {
        await sleep(cool, signal);
        continue;
      }
      if (lane === 'backfill') {
        const pause = this.backfillPauseUntil - Date.now();
        if (this.liveDepth > 0 || pause > 0) {
          await sleep(Math.max(20, pause), signal);
          continue;
        }
      }
      return;
    }
  }

  async run<T>(lane: QuotaLane, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.waitReady(lane, signal);
    const release = await this.lock(signal);
    try {
      await this.waitReady(lane, signal);
      return await fn();
    } catch (error) {
      if (isRateLimited(error)) {
        const waitMs = rateLimitWaitMs(error);
        this.coolDown(waitMs, { pauseBackfillMs: waitMs + this.backfillPauseExtraMs });
      }
      throw error;
    } finally {
      release();
    }
  }

  private async lock(signal?: AbortSignal): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const at = this.waiters.indexOf(finish);
          if (at >= 0) {
            this.waiters.splice(at, 1);
          }
          reject(signal?.reason ?? new Error('aborted'));
        };
        this.waiters.push(finish);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.locked = true;
    return () => {
      this.locked = false;
      const next = this.waiters.shift();
      next?.();
    };
  }
}

export async function withQuota<T>(
  quota: NodeQuota | undefined,
  lane: QuotaLane,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (quota === undefined) {
    return fn();
  }
  return quota.run(lane, fn, signal);
}

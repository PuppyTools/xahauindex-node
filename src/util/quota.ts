import { isRateLimited, rateLimitWaitMs } from './rateLimit.js';
import { sleep } from './retry.js';

export type QuotaLane = 'live' | 'backfill';

export const BACKFILL_QUOTA_PAUSE_MS = 15_000;
export const BACKFILL_WAIT_LOG_MS = 30_000;
/** Successful fetches after a 429 before overlapping RPCs are allowed again. */
export const BACKFILL_RESTORE_SUCCESSES = 8;

export type QuotaWaitInfo = {
  reason: 'cooldown' | 'live' | 'pause';
  waitMs: number;
};

export class NodeQuota {
  private coolUntil = 0;
  private backfillPauseUntil = 0;
  private liveDepth = 0;
  private inUse = 0;
  private lastWaitNotify = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private successesToRestore = 0;

  constructor(
    private readonly backfillPauseExtraMs = BACKFILL_QUOTA_PAUSE_MS,
    maxConcurrent = 1,
  ) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  get liveBusy(): boolean {
    return this.liveDepth > 0;
  }

  /** True while a 429 has forced single in-flight RPC. */
  get restricted(): boolean {
    return this.successesToRestore > 0;
  }

  get concurrentLimit(): number {
    return this.restricted ? 1 : this.maxConcurrent;
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

  backfillBlock(): QuotaWaitInfo | null {
    const now = Date.now();
    const cool = this.coolUntil - now;
    if (cool > 0) {
      return { reason: 'cooldown', waitMs: cool };
    }
    const pause = this.backfillPauseUntil - now;
    if (pause > 0) {
      return { reason: 'pause', waitMs: pause };
    }
    if (this.liveDepth > 0) {
      return { reason: 'live', waitMs: 0 };
    }
    return null;
  }

  async waitReady(
    lane: QuotaLane,
    signal?: AbortSignal,
    onWait?: (info: QuotaWaitInfo) => void,
  ): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('aborted');
      }
      const now = Date.now();
      const cool = this.coolUntil - now;
      if (cool > 0) {
        this.notifyWait(onWait, { reason: 'cooldown', waitMs: cool });
        await sleep(cool, signal);
        continue;
      }
      if (lane === 'backfill') {
        const pause = this.backfillPauseUntil - Date.now();
        if (this.liveDepth > 0 || pause > 0) {
          this.notifyWait(onWait, {
            reason: this.liveDepth > 0 ? 'live' : 'pause',
            waitMs: Math.max(0, pause),
          });
          await sleep(Math.max(20, pause), signal);
          continue;
        }
      }
      return;
    }
  }

  async run<T>(
    lane: QuotaLane,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    onWait?: (info: QuotaWaitInfo) => void,
  ): Promise<T> {
    await this.waitReady(lane, signal, onWait);
    const release = await this.lock(signal);
    try {
      await this.waitReady(lane, signal, onWait);
      const result = await fn();
      if (this.successesToRestore > 0) {
        this.successesToRestore -= 1;
      }
      return result;
    } catch (error) {
      if (isRateLimited(error)) {
        const waitMs = rateLimitWaitMs(error);
        this.successesToRestore = BACKFILL_RESTORE_SUCCESSES;
        this.coolDown(waitMs, { pauseBackfillMs: waitMs + this.backfillPauseExtraMs });
      }
      throw error;
    } finally {
      release();
    }
  }

  private async lock(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('aborted');
      }
      if (this.inUse < this.concurrentLimit) {
        this.inUse += 1;
        return () => {
          this.inUse = Math.max(0, this.inUse - 1);
          const next = this.waiters.shift();
          next?.();
        };
      }
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
  }

  private notifyWait(onWait: ((info: QuotaWaitInfo) => void) | undefined, info: QuotaWaitInfo): void {
    if (onWait === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.lastWaitNotify < BACKFILL_WAIT_LOG_MS) {
      return;
    }
    this.lastWaitNotify = now;
    onWait(info);
  }
}

export async function withQuota<T>(
  quota: NodeQuota | undefined,
  lane: QuotaLane,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  onWait?: (info: QuotaWaitInfo) => void,
): Promise<T> {
  if (quota === undefined) {
    return fn();
  }
  return quota.run(lane, fn, signal, onWait);
}

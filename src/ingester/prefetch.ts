import { sleep } from '../util/retry.js';

export type PrefetchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface WalkPrefetchOptions<T> {
  start: number;
  step: 1 | -1;
  concurrency: number;
  inRange: (index: number) => boolean;
  /** Return the next index to visit when `index` should not be fetched. */
  jump?: (index: number) => number | null;
  /** Fired when the apply cursor skips a range (not when prefetch jumps). */
  onJump?: (from: number, to: number) => void;
  fetch: (index: number) => Promise<T>;
  visit: (index: number, outcome: PrefetchOutcome<T>) => Promise<void> | void;
  afterVisit?: () => Promise<void>;
  /** Delay between starting fetches so expanded ledgers do not burst the RPC quota. */
  launchDelayMs?: number;
  signal?: AbortSignal;
}

function jumpedPast(key: number, from: number, to: number, step: 1 | -1): boolean {
  return step > 0 ? key >= from && key < to : key <= from && key > to;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('aborted');
  }
}

/**
 * Fetch up to `concurrency` indexes at a time, then visit them in walk order.
 * SQLite apply stays single-writer; only RPC/decode is overlapped.
 */
export async function walkPrefetch<T>(options: WalkPrefetchOptions<T>): Promise<void> {
  const concurrency = Math.max(1, options.concurrency);
  const launchDelayMs = Math.max(0, options.launchDelayMs ?? 0);
  const results = new Map<number, Promise<PrefetchOutcome<T>>>();
  let inFlight = 0;
  let nextFetch = options.start;
  let nextApply = options.start;
  let lastLaunchAt = 0;

  const dropSkipped = (from: number, to: number): void => {
    for (const key of [...results.keys()]) {
      if (jumpedPast(key, from, to, options.step)) {
        results.delete(key);
      }
    }
  };

  const jumpCursor = (index: number, kind: 'fetch' | 'apply'): number => {
    if (options.jump === undefined) {
      return index;
    }
    for (;;) {
      if (!options.inRange(index)) {
        return index;
      }
      const jumped = options.jump(index);
      if (jumped === null || jumped === index) {
        return index;
      }
      if (options.step > 0 && jumped <= index) {
        return index;
      }
      if (options.step < 0 && jumped >= index) {
        return index;
      }
      dropSkipped(index, jumped);
      if (kind === 'apply') {
        options.onJump?.(index, jumped);
      }
      index = jumped;
    }
  };

  const launch = (index: number): void => {
    if (results.has(index)) {
      return;
    }
    inFlight += 1;
    lastLaunchAt = Date.now();
    results.set(
      index,
      options
        .fetch(index)
        .then(
          (value): PrefetchOutcome<T> => ({ ok: true, value }),
          (error: unknown): PrefetchOutcome<T> => ({ ok: false, error }),
        )
        .finally(() => {
          inFlight -= 1;
        }),
    );
  };

  const fillWindow = async (): Promise<void> => {
    while (inFlight < concurrency && options.inRange(nextFetch)) {
      if (launchDelayMs > 0 && lastLaunchAt > 0) {
        const wait = lastLaunchAt + launchDelayMs - Date.now();
        if (wait > 0) {
          const pendingApply = results.get(nextApply);
          if (pendingApply === undefined) {
            await sleep(wait, options.signal);
          } else {
            const raced = await Promise.race([
              sleep(wait, options.signal).then(() => 'delay' as const),
              pendingApply.then(() => 'ready' as const),
            ]);
            if (raced === 'ready') {
              return;
            }
          }
        }
      }
      const index = nextFetch;
      nextFetch += options.step;
      launch(index);
      nextFetch = jumpCursor(nextFetch, 'fetch');
    }
  };

  while (true) {
    throwIfAborted(options.signal);
    nextFetch = jumpCursor(nextFetch, 'fetch');
    nextApply = jumpCursor(nextApply, 'apply');

    await fillWindow();

    if (!options.inRange(nextApply)) {
      return;
    }

    if (!results.has(nextApply)) {
      launch(nextApply);
    }

    const pending = results.get(nextApply);
    if (pending === undefined) {
      return;
    }
    const outcome = await pending;
    results.delete(nextApply);
    throwIfAborted(options.signal);
    await options.visit(nextApply, outcome);
    if (options.afterVisit !== undefined) {
      await options.afterVisit();
    }
    nextApply += options.step;
  }
}

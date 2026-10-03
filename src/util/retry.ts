export interface RetryOptions {
  minMs?: number;
  maxMs?: number;
  factor?: number;
  attempts?: number;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const minMs = options.minMs ?? 1_000;
  const maxMs = options.maxMs ?? 60_000;
  const factor = options.factor ?? 2;
  const attempts = options.attempts ?? Number.POSITIVE_INFINITY;

  let delay = minMs;
  let tried = 0;
  let lastError: unknown;

  while (tried < attempts) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      tried += 1;
      if (tried >= attempts) {
        break;
      }
      await sleep(delay, options.signal);
      delay = Math.min(maxMs, delay * factor);
    }
  }

  throw lastError;
}

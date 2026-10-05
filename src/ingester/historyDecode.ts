import { decode } from '@transia/xrpl';

export const HISTORY_TX_TYPES = [
  'Payment',
  'OfferCreate',
  'OfferCancel',
  'URITokenMint',
  'URITokenBurn',
  'URITokenCreateSellOffer',
  'URITokenBuy',
  'URITokenCancelSellOffer',
] as const;

export type HistoryTxType = (typeof HISTORY_TX_TYPES)[number];

export const HISTORY_TX_TYPE_SQL = HISTORY_TX_TYPES.map((type) => `'${type}'`).join(', ');

export interface HistoryDecodeJob {
  transId: string;
  rawTxn: unknown;
  txnMeta: unknown;
}

function blobToHex(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith("X'") && trimmed.endsWith("'")) {
      return trimmed.slice(2, -1);
    }
    if (trimmed.startsWith('\\x')) {
      return trimmed.slice(2);
    }
    return trimmed;
  }
  throw new Error('history blob is not bytes or hex');
}

export function decodeHistoryTransaction(job: HistoryDecodeJob): unknown | null {
  try {
    const tx = decode(blobToHex(job.rawTxn));
    const meta = decode(blobToHex(job.txnMeta));
    if (typeof tx !== 'object' || tx === null) {
      return null;
    }
    return {
      ...tx,
      hash: job.transId,
      meta,
    };
  } catch {
    return null;
  }
}

export async function decodeHistoryTransactions(
  jobs: readonly HistoryDecodeJob[],
  workers: number,
  signal?: AbortSignal,
): Promise<Array<unknown | null>> {
  if (jobs.length === 0) {
    return [];
  }
  const stripes = Math.max(1, Math.min(workers, jobs.length));
  const out: Array<unknown | null> = new Array(jobs.length);
  const yieldEvery = 32;
  await Promise.all(
    Array.from({ length: stripes }, async (_, stripe) => {
      for (let index = stripe; index < jobs.length; index += stripes) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error('aborted');
        }
        if (index > stripe && (index - stripe) % yieldEvery === 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        const job = jobs[index];
        out[index] = job === undefined ? null : decodeHistoryTransaction(job);
      }
    }),
  );
  return out;
}

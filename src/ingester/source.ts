import { Client, rippleTimeToUnixTime, type LedgerStream } from '@transia/xrpl';

import { NodeQuota } from '../util/quota.js';

export interface ValidatedLedger {
  index: number;
  hash: string;
  closeTime: number;
}

export interface LedgerDataPageResult {
  state: unknown[];
  marker?: unknown;
}

export interface ClosedLedger {
  index: number;
  hash: string;
  closeTime: number;
  transactions: unknown[];
}

export interface LedgerSource {
  getValidatedLedger(): Promise<ValidatedLedger>;
  getLedgerDataPage(ledgerIndex: number, marker?: unknown): Promise<LedgerDataPageResult>;
  reconnect?(): Promise<void>;
}

export interface LedgerRange {
  from: number;
  to: number;
}

export function parseCompleteLedgers(raw: string | null | undefined): LedgerRange[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'empty') {
    return [];
  }
  const ranges: LedgerRange[] = [];
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (piece === '') {
      continue;
    }
    const dash = piece.indexOf('-');
    const fromRaw = dash === -1 ? piece : piece.slice(0, dash);
    const toRaw = dash === -1 ? piece : piece.slice(dash + 1);
    const from = Number.parseInt(fromRaw, 10);
    const to = Number.parseInt(toRaw, 10);
    if (Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from) {
      ranges.push({ from, to });
    }
  }
  return ranges;
}

export function completeRangeContaining(
  ranges: readonly LedgerRange[],
  index: number,
): LedgerRange | null {
  return ranges.find((range) => index >= range.from && index <= range.to) ?? null;
}

export interface LiveLedgerSource extends LedgerSource {
  getLedgerWithTransactions(ledgerIndex: number): Promise<ClosedLedger>;
  subscribeLedgers(): Promise<void>;
  onLedgerClosed(handler: (ledger: ValidatedLedger) => void): () => void;
  getCompleteLedgers?(): Promise<string | null>;
  quota?: NodeQuota;
}

export interface XahauSource extends LiveLedgerSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

function unixSecondsFromRipple(rippleTime: number): number {
  return Math.floor(rippleTimeToUnixTime(rippleTime) / 1000);
}

function asLedgerRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function isHttpUrl(url: string): boolean {
  const protocol = new URL(url).protocol;
  return protocol === 'http:' || protocol === 'https:';
}

export function isLedgerNotFound(error: unknown): boolean {
  const texts: string[] = [];
  if (error instanceof Error) {
    texts.push(error.message);
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown; data?: unknown };
    if (typeof record.name === 'string') {
      texts.push(record.name);
    }
    if (typeof record.data === 'object' && record.data !== null) {
      const data = record.data as { error?: unknown; error_message?: unknown };
      if (typeof data.error === 'string') {
        texts.push(data.error);
      }
      if (typeof data.error_message === 'string') {
        texts.push(data.error_message);
      }
    }
  }
  return texts.some((text) => /lgrNotFound|ledgerNotFound/i.test(text));
}

export function createJsonRpcSource(url: string): XahauSource {
  const requestLedger = async (ledgerIndex: number | 'validated'): Promise<ClosedLedger> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'ledger',
        params: [
          {
            ledger_index: ledgerIndex,
            transactions: true,
            expand: true,
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`JSON-RPC ${response.status} from ${url}`);
    }
    const body = (await response.json()) as {
      result?: {
        status?: string;
        error?: string;
        error_message?: string;
        ledger_index?: number;
        ledger_hash?: string;
        ledger?: Record<string, unknown>;
      };
      error?: string;
    };
    const result = body.result;
    if (!result || result.status === 'error' || result.error || body.error) {
      throw new Error(result?.error_message ?? result?.error ?? body.error ?? 'JSON-RPC ledger failed');
    }
    const ledger = asLedgerRecord(result.ledger);
    const index = Number(result.ledger_index ?? ledger.ledger_index ?? ledgerIndex);
    const hash = String(result.ledger_hash ?? ledger.ledger_hash ?? '');
    const closeTime = unixSecondsFromRipple(Number(ledger.close_time ?? 0));
    const transactions = Array.isArray(ledger.transactions) ? ledger.transactions : [];
    return { index, hash, closeTime, transactions };
  };

  return {
    quota: new NodeQuota(),
    connect: async () => undefined,
    disconnect: async () => undefined,
    reconnect: async () => undefined,
    getValidatedLedger: async () => {
      const ledger = await requestLedger('validated');
      return { index: ledger.index, hash: ledger.hash, closeTime: ledger.closeTime };
    },
    getLedgerDataPage: async () => {
      throw new Error('JSON-RPC backfill source does not page ledger_data');
    },
    getLedgerWithTransactions: async (ledgerIndex) => requestLedger(ledgerIndex),
    getCompleteLedgers: async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'server_info', params: [{}] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`JSON-RPC ${response.status} from ${url}`);
      }
      const body = (await response.json()) as {
        result?: { info?: { complete_ledgers?: unknown } };
      };
      const raw = body.result?.info?.complete_ledgers;
      return typeof raw === 'string' ? raw : null;
    },
    subscribeLedgers: async () => {
      throw new Error('JSON-RPC backfill source does not subscribe');
    },
    onLedgerClosed: () => () => undefined,
  };
}

export function createBackfillSource(url: string): XahauSource {
  if (isHttpUrl(url)) {
    return createJsonRpcSource(url);
  }
  return createXahauSource(url);
}

export function createXahauSource(url: string): XahauSource {
  const client = new Client(url);
  const quota = new NodeQuota();
  const listeners = new Set<(ledger: ValidatedLedger) => void>();

  const onClosed = (ledger: LedgerStream): void => {
    const closed: ValidatedLedger = {
      index: ledger.ledger_index,
      hash: ledger.ledger_hash,
      closeTime: unixSecondsFromRipple(ledger.ledger_time),
    };
    for (const handler of listeners) {
      handler(closed);
    }
  };

  return {
    quota,
    connect: async () => {
      await client.connect();
    },
    disconnect: async () => {
      client.off('ledgerClosed', onClosed);
      listeners.clear();
      await client.disconnect();
    },
    reconnect: async () => {
      try {
        await client.disconnect();
      } catch {
        // already closed
      }
      await client.connect();
    },
    getValidatedLedger: async () => {
      const response = await client.request({
        command: 'ledger',
        ledger_index: 'validated',
      });
      const ledger = response.result.ledger as {
        ledger_index?: number | string;
        ledger_hash?: string;
        close_time?: number;
      };
      const index = Number(response.result.ledger_index ?? ledger.ledger_index);
      const hash = String(ledger.ledger_hash ?? '');
      const closeTime = unixSecondsFromRipple(Number(ledger.close_time ?? 0));
      return { index, hash, closeTime };
    },
    getLedgerDataPage: async (ledgerIndex, marker) => {
      const request: Record<string, unknown> = {
        command: 'ledger_data',
        ledger_index: ledgerIndex,
        binary: false,
        limit: 1024,
      };
      if (marker !== undefined) {
        request.marker = marker;
      }
      const response = (await client.request(
        request as unknown as Parameters<Client['request']>[0],
      )) as { result: { state?: unknown[]; marker?: unknown } };
      const result = response.result;
      const page: LedgerDataPageResult = {
        state: Array.isArray(result.state) ? result.state : [],
      };
      if (result.marker !== undefined) {
        page.marker = result.marker;
      }
      return page;
    },
    getLedgerWithTransactions: async (ledgerIndex) => {
      const response = (await client.request({
        command: 'ledger',
        ledger_index: ledgerIndex,
        transactions: true,
        expand: true,
      } as unknown as Parameters<Client['request']>[0])) as {
        result: {
          ledger_index?: number;
          ledger_hash?: string;
          ledger?: Record<string, unknown>;
        };
      };
      const ledger = asLedgerRecord(response.result.ledger);
      const index = Number(response.result.ledger_index ?? ledger.ledger_index ?? ledgerIndex);
      const hash = String(response.result.ledger_hash ?? ledger.ledger_hash ?? '');
      const closeTime = unixSecondsFromRipple(Number(ledger.close_time ?? 0));
      const transactions = Array.isArray(ledger.transactions) ? ledger.transactions : [];
      return { index, hash, closeTime, transactions };
    },
    getCompleteLedgers: async () => {
      const response = await client.request({ command: 'server_info' });
      const info = response.result.info as { complete_ledgers?: unknown };
      return typeof info.complete_ledgers === 'string' ? info.complete_ledgers : null;
    },
    subscribeLedgers: async () => {
      client.off('ledgerClosed', onClosed);
      client.on('ledgerClosed', onClosed);
      await client.request({
        command: 'subscribe',
        streams: ['ledger'],
      });
    },
    onLedgerClosed: (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

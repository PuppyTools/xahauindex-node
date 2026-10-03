import { Client, rippleTimeToUnixTime } from '@transia/xrpl';

export interface ValidatedLedger {
  index: number;
  hash: string;
  closeTime: number;
}

export interface LedgerDataPageResult {
  state: unknown[];
  marker?: unknown;
}

export interface LedgerSource {
  getValidatedLedger(): Promise<ValidatedLedger>;
  getLedgerDataPage(ledgerIndex: number, marker?: unknown): Promise<LedgerDataPageResult>;
}

interface ConnectableSource extends LedgerSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

function unixSecondsFromRipple(rippleTime: number): number {
  return Math.floor(rippleTimeToUnixTime(rippleTime) / 1000);
}

export function createXahauSource(url: string): ConnectableSource {
  const client = new Client(url);
  return {
    connect: async () => {
      await client.connect();
    },
    disconnect: async () => {
      await client.disconnect();
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
        limit: 200,
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
  };
}

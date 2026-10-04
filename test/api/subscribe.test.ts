import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createHub } from '../../src/api/hub.js';
import { buildApi } from '../../src/api/index.js';
import { publishLedgerEvents } from '../../src/api/publish.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { silentLog, testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

const dbs: SqliteDatabase[] = [];

function memoryDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

function waitMessage(socket: { once: (event: string, fn: (data: unknown) => void) => void }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for websocket message'));
    }, 1_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
  });
}

describe('WS /v1/subscribe', () => {
  it('receives a tokens event after a fixture ledger', async () => {
    const db = memoryDb();
    const hub = createHub();
    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 51 }),
      hub,
    });
    await app.ready();
    const socket = await app.injectWS('/v1/subscribe');
    socket.send(JSON.stringify({ command: 'subscribe', streams: ['tokens'] }));
    const ack = (await waitMessage(socket)) as { type: string; streams: string[] };
    assert.equal(ack.type, 'subscribed');
    assert.deepEqual(ack.streams, ['tokens']);

    const result = applyClosedLedger(
      db,
      {
        index: 51,
        hash: '1'.repeat(64),
        closeTime: 1_700_000_051,
        transactions: [
          {
            hash: '2'.repeat(64),
            TransactionType: 'TrustSet',
            Account: HOLDER,
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  CreatedNode: {
                    LedgerEntryType: 'RippleState',
                    LedgerIndex: 'c'.repeat(64),
                    NewFields: {
                      Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-10' },
                      LowLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
                      HighLimit: { currency: 'USD', issuer: HOLDER, value: '50' },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      silentLog,
    );
    publishLedgerEvents(hub, db, result);
    const event = (await waitMessage(socket)) as {
      stream: string;
      event: string;
      data: { currency: string; issuer: string };
      ledger_index: number;
    };
    assert.equal(event.stream, 'tokens');
    assert.equal(event.event, 'update');
    assert.equal(event.data.currency, 'USD');
    assert.equal(event.data.issuer, ISSUER);
    assert.equal(event.ledger_index, 51);
    socket.close();
    await app.close();
  });

  it('rejects a second subscribe socket from the same IP', async () => {
    const db = memoryDb();
    const app = await buildApi({
      db,
      config: testConfig({ apiWsMaxPerIp: 1 }),
      runtime: testRuntime(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const url = `ws://127.0.0.1:${address.port}/v1/subscribe`;

    const first = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      first.addEventListener('open', () => resolve(), { once: true });
      first.addEventListener('error', () => reject(new Error('first websocket failed')), { once: true });
    });

    const second = new WebSocket(url);
    const limited = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), 1_000);
      second.addEventListener(
        'message',
        (event) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(event.data)));
        },
        { once: true },
      );
      second.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('second websocket failed'));
      }, { once: true });
    });
    assert.deepEqual(limited, {
      error: { code: 'RATE_LIMITED', message: 'Too many websocket connections' },
    });
    first.close();
    second.close();
    await app.close();
  });
});

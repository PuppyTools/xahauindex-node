import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isConnectionError, isLedgerNotFound } from '../../src/ingester/source.js';

describe('isConnectionError', () => {
  it('matches xrpl NotConnectedError and fetch/TCP disconnects', () => {
    const notConnected = new Error('{"command":"ledger","ledger_index":26524872}');
    notConnected.name = 'NotConnectedError';
    assert.equal(isConnectionError(notConnected), true);

    const fetchFailed = new Error('fetch failed');
    fetchFailed.name = 'TypeError';
    (fetchFailed as Error & { cause?: Error }).cause = Object.assign(new Error('connect EHOSTUNREACH 10.0.0.1:443'), {
      name: 'Error',
    });
    assert.equal(isConnectionError(fetchFailed), true);

    assert.equal(isConnectionError(new Error('lgrNotFound')), false);
    assert.equal(isLedgerNotFound(new Error('lgrNotFound')), true);
  });
});

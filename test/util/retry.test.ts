import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { retry } from '../../src/util/retry.js';

describe('retry', () => {
  it('returns on success after failures', async () => {
    let attempts = 0;
    const value = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('not yet');
        }
        return 7;
      },
      { minMs: 1, maxMs: 2, attempts: 5 },
    );
    assert.equal(value, 7);
    assert.equal(attempts, 3);
  });

  it('throws after the last attempt', async () => {
    await assert.rejects(
      () =>
        retry(
          async () => {
            throw new Error('nope');
          },
          { minMs: 1, maxMs: 1, attempts: 2 },
        ),
      /nope/,
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRateLimited, rateLimitWaitMs } from '../../src/util/rateLimit.js';

function rippledRateLimit(message: string): Error {
  const error = new Error(message);
  error.name = 'RippledError';
  (error as Error & { data: Record<string, unknown> }).data = {
    error: 'tooBusy',
    error_code: 9,
    error_message: message,
  };
  return error;
}

describe('rate limit helpers', () => {
  it('detects tooBusy and parses the hinted wait', () => {
    const error = rippledRateLimit(
      'rate limit: units quota (50000 per 10s) exhausted, retry in ~8919ms',
    );
    assert.equal(isRateLimited(error), true);
    assert.equal(rateLimitWaitMs(error), 9169);
    assert.equal(isRateLimited(new Error('lgrNotFound')), false);
  });
});

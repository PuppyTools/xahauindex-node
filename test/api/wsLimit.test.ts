import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWsConnectionTracker } from '../../src/api/wsLimit.js';

describe('websocket connection tracker', () => {
  it('caps concurrent sockets per IP', () => {
    const tracker = createWsConnectionTracker();
    assert.equal(tracker.tryAcquire('203.0.113.1', 1), true);
    assert.equal(tracker.tryAcquire('203.0.113.1', 1), false);
    assert.equal(tracker.tryAcquire('203.0.113.2', 1), true);
    tracker.release('203.0.113.1');
    assert.equal(tracker.count('203.0.113.1'), 0);
    assert.equal(tracker.tryAcquire('203.0.113.1', 1), true);
  });
});

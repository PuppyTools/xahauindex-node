import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { walkPrefetch } from '../../src/ingester/prefetch.js';
import { sleep } from '../../src/util/retry.js';

describe('walkPrefetch', () => {
  it('visits indexes in walk order while overlapping fetches', async () => {
    const started: number[] = [];
    const visited: number[] = [];
    let inflight = 0;
    let max = 0;
    await walkPrefetch({
      start: 10,
      step: -1,
      concurrency: 4,
      inRange: (index) => index >= 7,
      fetch: async (index) => {
        started.push(index);
        inflight += 1;
        max = Math.max(max, inflight);
        await sleep(index === 10 ? 40 : 5);
        inflight -= 1;
        return index;
      },
      visit: (index, outcome) => {
        assert.equal(outcome.ok, true);
        visited.push(index);
      },
    });
    assert.deepEqual(started.slice(0, 4), [10, 9, 8, 7]);
    assert.deepEqual(visited, [10, 9, 8, 7]);
    assert.equal(max, 4);
  });

  it('staggers fetch starts by launchDelayMs', async () => {
    const startedAt: number[] = [];
    const origin = Date.now();
    await walkPrefetch({
      start: 3,
      step: -1,
      concurrency: 3,
      launchDelayMs: 40,
      inRange: (index) => index >= 1,
      fetch: async (index) => {
        startedAt.push(Date.now() - origin);
        await sleep(80);
        return index;
      },
      visit: () => undefined,
    });
    assert.equal(startedAt.length, 3);
    assert.ok(startedAt[1]! - startedAt[0]! >= 25);
    assert.ok(startedAt[2]! - startedAt[1]! >= 25);
  });

  it('skips a jump range for both fetch and apply cursors', async () => {
    const fetched: number[] = [];
    const visited: number[] = [];
    const jumps: Array<[number, number]> = [];
    await walkPrefetch({
      start: 12,
      step: -1,
      concurrency: 4,
      inRange: (index) => index >= 8,
      jump: (index) => (index >= 9 && index <= 11 ? 8 : null),
      onJump: (from, to) => {
        jumps.push([from, to]);
      },
      fetch: async (index) => {
        fetched.push(index);
        return index;
      },
      visit: (index) => {
        visited.push(index);
      },
    });
    assert.deepEqual(fetched, [12, 8]);
    assert.deepEqual(visited, [12, 8]);
    assert.deepEqual(jumps, [[11, 8]]);
  });

  it('walks forward and reports fetch errors in order', async () => {
    const visited: Array<{ index: number; ok: boolean }> = [];
    await walkPrefetch({
      start: 2,
      step: 1,
      concurrency: 3,
      inRange: (index) => index <= 4,
      fetch: async (index) => {
        if (index === 3) {
          throw new Error('missing');
        }
        await sleep(5);
        return index;
      },
      visit: (index, outcome) => {
        visited.push({ index, ok: outcome.ok });
      },
    });
    assert.deepEqual(visited, [
      { index: 2, ok: true },
      { index: 3, ok: false },
      { index: 4, ok: true },
    ]);
  });
});

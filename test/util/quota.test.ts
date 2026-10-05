import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKFILL_RESTORE_SUCCESSES, NodeQuota } from '../../src/util/quota.js';
import { sleep } from '../../src/util/retry.js';

describe('NodeQuota', () => {
  it('reports why backfill is blocked', () => {
    const quota = new NodeQuota(1);
    assert.equal(quota.backfillBlock(), null);
    quota.beginLive();
    assert.equal(quota.backfillBlock()?.reason, 'live');
    quota.endLive();
    quota.coolDown(50, { pauseBackfillMs: 80 });
    assert.equal(quota.backfillBlock()?.reason, 'cooldown');
  });

  it('holds backfill while live is catching up', async () => {
    const quota = new NodeQuota(1);
    const order: string[] = [];
    quota.beginLive();
    const backfill = quota.run('backfill', async () => {
      order.push('backfill');
    });
    await sleep(40);
    assert.deepEqual(order, []);
    quota.endLive();
    await backfill;
    assert.deepEqual(order, ['backfill']);
  });

  it('serializes fetches and cools down after tooBusy', async () => {
    const quota = new NodeQuota(1);
    await assert.rejects(
      () =>
        quota.run('live', async () => {
          throw new Error('rate limit: units quota (50000 per 10s) exhausted, retry in ~5ms');
        }),
      /rate limit/,
    );
    const started = Date.now();
    await quota.run('live', async () => undefined);
    assert.ok(Date.now() - started >= 5);
  });

  it('allows up to maxConcurrent overlapping runs', async () => {
    const quota = new NodeQuota(1, 3);
    let inflight = 0;
    let max = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        quota.run('backfill', async () => {
          inflight += 1;
          max = Math.max(max, inflight);
          await sleep(40);
          inflight -= 1;
        }),
      ),
    );
    assert.equal(max, 3);
  });

  it('drops overlapping fetches after a 429 until successes recover', async () => {
    const quota = new NodeQuota(1, 3);
    await assert.rejects(
      () =>
        quota.run('backfill', async () => {
          throw new Error('rate limit: units quota (50000 per 10s) exhausted, retry in ~5ms');
        }),
      /rate limit/,
    );
    assert.equal(quota.restricted, true);
    assert.equal(quota.concurrentLimit, 1);

    let inflight = 0;
    let max = 0;
    for (let i = 0; i < BACKFILL_RESTORE_SUCCESSES; i += 1) {
      await quota.run('backfill', async () => {
        inflight += 1;
        max = Math.max(max, inflight);
        await sleep(5);
        inflight -= 1;
      });
    }
    assert.equal(max, 1);
    assert.equal(quota.restricted, false);
    assert.equal(quota.concurrentLimit, 3);

    inflight = 0;
    max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        quota.run('backfill', async () => {
          inflight += 1;
          max = Math.max(max, inflight);
          await sleep(30);
          inflight -= 1;
        }),
      ),
    );
    assert.equal(max, 3);
  });
});

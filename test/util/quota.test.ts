import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NodeQuota } from '../../src/util/quota.js';
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
});

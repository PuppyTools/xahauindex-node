import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { ZlibCatalogueInflate, zlibRandomAccessAvailable } from '../../src/ingester/zlibInflate.js';

describe('ZlibCatalogueInflate', () => {
  it('seeks to a zran access point and continues the payload', async () => {
    if (!zlibRandomAccessAvailable()) {
      return;
    }
    const payload = randomBytes(400_000);
    const compressed = deflateSync(payload, { level: 6 });
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-zran-'));
    const path = join(dir, 'payload.z');
    writeFileSync(path, compressed);

    const first = await ZlibCatalogueInflate.open(path, 0);
    const prefix = await first.read(80_000);
    const { extra, point } = await first.snapshot();
    first.close();
    const produced = prefix.length + extra.length;

    const resumed = await ZlibCatalogueInflate.open(path, 0, point);
    const rest: Buffer[] = [extra];
    for (;;) {
      const chunk = await resumed.read(65_536);
      if (chunk.length === 0) {
        break;
      }
      rest.push(chunk);
    }
    resumed.close();
    const got = Buffer.concat([prefix, ...rest]);
    assert.equal(produced > 80_000, true);
    assert.equal(got.length, payload.length);
    assert.ok(got.equals(payload));
  });

  it('keeps unused compressed bytes when refilling the input buffer', async () => {
    if (!zlibRandomAccessAvailable()) {
      return;
    }
    const payload = randomBytes(300_000);
    const compressed = deflateSync(payload, { level: 6 });
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-zleftover-'));
    const path = join(dir, 'payload.z');
    writeFileSync(path, compressed);

    const inflate = await ZlibCatalogueInflate.open(path, 0);
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = await inflate.read(17);
      if (chunk.length === 0) {
        break;
      }
      chunks.push(chunk);
    }
    inflate.close();
    const got = Buffer.concat(chunks);
    assert.equal(got.length, payload.length);
    assert.ok(got.equals(payload));
  });

  it('keeps unused compressed bytes across snapshot refills', async () => {
    if (!zlibRandomAccessAvailable()) {
      return;
    }
    const payload = randomBytes(400_000);
    const compressed = deflateSync(payload, { level: 6 });
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-zsnap-'));
    const path = join(dir, 'payload.z');
    writeFileSync(path, compressed);

    const inflate = await ZlibCatalogueInflate.open(path, 0);
    const chunks: Buffer[] = [];
    let reads = 0;
    for (;;) {
      const chunk = await inflate.read(1_000);
      if (chunk.length === 0) {
        break;
      }
      chunks.push(chunk);
      reads += 1;
      if (reads % 8 === 0) {
        const { extra } = await inflate.snapshot();
        if (extra.length > 0) {
          chunks.push(extra);
        }
      }
    }
    inflate.close();
    const got = Buffer.concat(chunks);
    assert.equal(got.length, payload.length);
    assert.ok(got.equals(payload));
  });
});

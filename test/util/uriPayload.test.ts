import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyUri,
  decodeOnchainUriMetadata,
  resolveUriTokenMetadata,
} from '../../src/util/uriPayload.js';

const LEASE_URI = 'ZXZybGVhc2VMVFYAAQAACAFnfryy9275fVMVSdiyfVQDjX6kxoAAMPnVSwAAAAAAAAAAAAAAAAAAAAAA';
const LEASE_RAW = Buffer.from(LEASE_URI, 'utf8').toString('hex');

describe('URI payload', () => {
  it('classifies URLs versus on-chain blobs', () => {
    assert.equal(classifyUri('https://example.com/meta.json'), 'https');
    assert.equal(classifyUri('ipfs://bafyhash/meta.json'), 'ipfs');
    assert.equal(classifyUri('https://cdn.example/a.webp'), 'image');
    assert.equal(classifyUri(LEASE_URI), 'onchain');
    assert.equal(classifyUri(''), 'empty');
  });

  it('decodes an Evernode evrlease URI into viewable fields', () => {
    const meta = decodeOnchainUriMetadata(LEASE_URI, LEASE_RAW);
    assert.ok(meta);
    assert.equal(meta.source, 'onchain');
    assert.equal(meta.format, 'evrlease');
    assert.equal(meta.name, 'Evernode lease #0');
    assert.equal(meta.version, 'LTV1');
    assert.equal(meta.lease_index, 0);
    assert.equal(typeof meta.lease_amount, 'string');
    assert.ok(meta.lease_amount && meta.lease_amount.length > 0);
    assert.equal(meta.half_tos, '0801677ebcb2f76ef97d531549d8b27d');
    assert.equal(meta.identifier, 821679435);
    assert.equal(meta.outbound_ip, null);
  });

  it('prefers fetched HTTPS JSON over on-chain decode', () => {
    const fetched = { name: 'Art', image: 'https://cdn.example/a.png' };
    assert.deepEqual(resolveUriTokenMetadata(LEASE_URI, LEASE_RAW, fetched), fetched);
    const decoded = resolveUriTokenMetadata(LEASE_URI, LEASE_RAW, null);
    assert.ok(decoded && typeof decoded === 'object');
    assert.equal((decoded as { format: string }).format, 'evrlease');
  });

  it('exposes printable on-chain text that is not a URL', () => {
    const text = 'hook-id:demo';
    const meta = decodeOnchainUriMetadata(text, Buffer.from(text).toString('hex'));
    assert.deepEqual(meta, {
      source: 'onchain',
      format: 'text',
      encoding: 'utf8',
      text,
      hex: Buffer.from(text).toString('hex'),
    });
  });
});

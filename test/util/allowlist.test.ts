import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ipInAllowlist, parseIpAllowlist } from '../../src/util/allowlist.js';

describe('IP allowlist', () => {
  it('parses addresses and CIDRs', () => {
    assert.deepEqual(parseIpAllowlist('127.0.0.1, 10.0.0.0/8,::1'), [
      '127.0.0.1',
      '10.0.0.0/8',
      '::1',
    ]);
  });

  it('matches IPs and subnets', () => {
    const entries = parseIpAllowlist('127.0.0.1,10.0.0.0/8,2001:db8::/32');
    assert.equal(ipInAllowlist(entries, '127.0.0.1'), true);
    assert.equal(ipInAllowlist(entries, '10.9.8.7'), true);
    assert.equal(ipInAllowlist(entries, '11.0.0.1'), false);
    assert.equal(ipInAllowlist(entries, '2001:db8::1'), true);
    assert.equal(ipInAllowlist(entries, '2001:db9::1'), false);
    assert.equal(ipInAllowlist(entries, '::ffff:127.0.0.1'), true);
  });

  it('rejects junk', () => {
    assert.throws(() => parseIpAllowlist('example.com'), /not an IP or CIDR/);
    assert.throws(() => parseIpAllowlist('10.0.0.0/99'), /prefix must be 0-32/);
  });
});

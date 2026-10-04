import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertSafeTomlHost,
  isExpectedTomlFailure,
  isFetchableTomlDomain,
  isAccountListed,
  parseXrpLedgerToml,
  pickTomlProfile,
} from '../../src/util/domain.js';

const SAMPLE = `
# comment
[METADATA]
name = "Example"
desc = "A test issuer"
icon = "https://example.com/icon.png"

[[ACCOUNTS]]
address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
name = "Treasury"
`;

describe('xrp-ledger.toml', () => {
  it('parses accounts and metadata', () => {
    const toml = parseXrpLedgerToml(SAMPLE);
    assert.equal(toml.metadata.name, 'Example');
    assert.equal(isAccountListed(toml, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'), true);
    assert.equal(isAccountListed(toml, 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'), false);
    const profile = pickTomlProfile(toml, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
    assert.equal(profile.name, 'Treasury');
    assert.equal(profile.icon, 'https://example.com/icon.png');
  });

  it('rejects localhost and private hosts', () => {
    assert.throws(() => assertSafeTomlHost('localhost'));
    assert.throws(() => assertSafeTomlHost('127.0.0.1'));
    assert.throws(() => assertSafeTomlHost('10.0.0.2'));
    assert.doesNotThrow(() => assertSafeTomlHost('example.com'));
  });

  it('only fetches hostname-shaped domains', () => {
    assert.equal(isFetchableTomlDomain('evernode46.cosecant.info'), true);
    assert.equal(isFetchableTomlDomain('https://example.com/path'), true);
    assert.equal(
      isFetchableTomlDomain(
        'ED7573749189112BED42DED36ECFE7BFF43C2D50A6A3F080EF874BE3D5CCDC2B004D59584A000000000000',
      ),
      false,
    );
    assert.equal(isFetchableTomlDomain('not a host'), false);
    assert.equal(isExpectedTomlFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })), true);
    assert.equal(isExpectedTomlFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
    assert.equal(isExpectedTomlFailure(new Error('disk full')), false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertSafeTomlHost,
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
});

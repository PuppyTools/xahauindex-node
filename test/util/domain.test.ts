import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertSafeTomlHost,
  fetchPublicHttpsText,
  isExpectedTomlFailure,
  isFetchableTomlDomain,
  isAccountListed,
  parseXrpLedgerToml,
  pickTomlLinks,
  pickTomlProfile,
  TOML_USER_AGENT,
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

  it('treats ISSUERS and TOKENS rows as domain verification', () => {
    const toml = parseXrpLedgerToml(`
[[ISSUERS]]
address = "rXmagwMmnFtVet3uL26Q2iwk287SRvVMJ"
name = "Magnetic"

[[TOKENS]]
issuer = "rXmagwMmnFtVet3uL26Q2iwk287SRvVMJ"
name = "Magnetic"
icon = "https://xmagnetic.org/mag.png"

[[TOKENS.WEBLINKS]]
url = "https://xmagnetic.org"
type = "website"
title = "Official Website"

[[TOKENS.WEBLINKS]]
url = "https://twitter.com/MagneticXRPL"
type = "socialmedia"
`);
    assert.equal(isAccountListed(toml, 'rXmagwMmnFtVet3uL26Q2iwk287SRvVMJ'), true);
    assert.equal(toml.tokens.length, 1);
    const profile = pickTomlProfile(toml, 'rXmagwMmnFtVet3uL26Q2iwk287SRvVMJ');
    assert.equal(profile.name, 'Magnetic');
    assert.equal(profile.icon, 'https://xmagnetic.org/mag.png');
    const links = pickTomlLinks(toml);
    assert.deepEqual(links, [
      { url: 'https://xmagnetic.org', type: 'website', title: 'Official Website' },
      { url: 'https://twitter.com/MagneticXRPL', type: 'social', title: null },
    ]);
  });

  it('collects WEBLINKS, TOKENS.URLS, and ORGANIZATION socials', () => {
    const toml = parseXrpLedgerToml(`
[ORGANIZATION]
website="https://transia.co"
twitter="@angell_denis"

[[WEBLINKS]]
url = "https://dex.xmerch.app"
type = "website"
title = "xMerch"

[[TOKENS.URLS]]
url = "https://x.com/xMerch_"
type = "social"
title = "Twitter / X"
`);
    assert.deepEqual(pickTomlLinks(toml), [
      { url: 'https://dex.xmerch.app', type: 'website', title: 'xMerch' },
      { url: 'https://x.com/xMerch_', type: 'social', title: 'Twitter / X' },
      { url: 'https://transia.co', type: 'website', title: 'Website' },
      { url: 'https://x.com/angell_denis', type: 'social', title: 'Twitter' },
    ]);
  });

  it('sends a product User-Agent and follows one safe redirect', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('user-agent'), TOML_USER_AGENT);
      if (url.endsWith('/from')) {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://example.com/.well-known/xrp-ledger.toml' },
        });
      }
      return new Response('[METADATA]\nname = "Redirected"\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    };
    const fetched = await fetchPublicHttpsText('https://example.com/from', { fetchImpl });
    assert.equal(fetched.text.includes('Redirected'), true);
    assert.deepEqual(calls, [
      'https://example.com/from',
      'https://example.com/.well-known/xrp-ledger.toml',
    ]);
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

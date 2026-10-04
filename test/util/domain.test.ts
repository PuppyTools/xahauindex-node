import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertSafeTomlHost,
  fetchPublicHttpsText,
  fetchXahauToml,
  isExpectedTomlFailure,
  isFetchableTomlDomain,
  isAccountListed,
  isTomlDocument,
  parseXahauToml,
  pickTomlLinks,
  pickTomlProfile,
  TOML_USER_AGENT,
  XAHAU_TOML_PATH,
} from '../../src/util/domain.js';

const XAHAU_SAMPLE = `
[METADATA]
modified = 2025-08-04T14:24:34.123Z

[ORGANIZATION]
name = "A Company B.V."
website = "https://example.com"
social_1 = "https://www.linkedin.com/company/incfintech"
x = "@IncFinTech"

[[PRINCIPALS]]
name = "A. Person"
social_1 = "https://x.com/IncFinTech"

[[ACCOUNTS]]
address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
network = "21337"
desc = "This wallet is used for client deposits."

[[CURRENCIES]]
code = "USD"
issuer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
symbol = "$"
network = "21337"
`;

describe('xahau.toml', () => {
  it('parses the Xahau identity sections and verifies [[ACCOUNTS]] / [[CURRENCIES]]', () => {
    const toml = parseXahauToml(XAHAU_SAMPLE);
    assert.equal(toml.organization.name, 'A Company B.V.');
    assert.equal(isAccountListed(toml, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'), true);
    assert.equal(isAccountListed(toml, 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'), false);
    const profile = pickTomlProfile(toml, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
    assert.equal(profile.name, 'A Company B.V.');
    assert.equal(profile.description, 'This wallet is used for client deposits.');
    const links = pickTomlLinks(toml);
    assert.deepEqual(links, [
      { url: 'https://example.com', type: 'website', title: 'Website' },
      { url: 'https://www.linkedin.com/company/incfintech', type: 'social', title: null },
      { url: 'https://x.com/IncFinTech', type: 'social', title: 'Twitter' },
    ]);
  });

  it('still reads custom ISSUERS / TOKENS / WEBLINKS when a xahau.toml includes them', () => {
    const toml = parseXahauToml(`
[[ISSUERS]]
address = "rwUAi9ErV3wqgPdPj5qJdhBegJ3SPEvG9Y"
name = "Xah Reinvest Fund #1"

[[TOKENS]]
issuer = "rwUAi9ErV3wqgPdPj5qJdhBegJ3SPEvG9Y"
name = "Fund #1 LPT"
icon = "https://xahinvest.com/icon.png"

[[WEBLINKS]]
url = "https://xahinvest.com"
type = "website"
title = "Official Website"
`);
    assert.equal(isAccountListed(toml, 'rwUAi9ErV3wqgPdPj5qJdhBegJ3SPEvG9Y'), true);
    const profile = pickTomlProfile(toml, 'rwUAi9ErV3wqgPdPj5qJdhBegJ3SPEvG9Y');
    assert.equal(profile.name, 'Xah Reinvest Fund #1');
    assert.equal(profile.icon, 'https://xahinvest.com/icon.png');
    assert.deepEqual(pickTomlLinks(toml), [
      { url: 'https://xahinvest.com', type: 'website', title: 'Official Website' },
    ]);
  });

  it('fetches only /.well-known/xahau.toml and rejects HTML stand-ins', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('user-agent'), TOML_USER_AGENT);
      assert.match(headers.get('accept') ?? '', /application\/toml/);
      assert.equal(url.includes('xrp-ledger.toml'), false);
      return new Response('[ORGANIZATION]\nname = "Evernode Ltd"\n', {
        status: 200,
        headers: { 'content-type': 'application/toml' },
      });
    };
    const text = await fetchXahauToml('evernode.org', fetchImpl);
    assert.match(text, /Evernode Ltd/);
    assert.deepEqual(calls, [`https://evernode.org${XAHAU_TOML_PATH}`]);

    const htmlFetch: typeof fetch = async () =>
      new Response('<!doctype html><html lang="en">', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    await assert.rejects(fetchXahauToml('example.com', htmlFetch), /TOML HTTP 404/);
    assert.equal(isTomlDocument('<!doctype html><html>', 'text/html'), false);
    assert.equal(isTomlDocument('[ORGANIZATION]\nname = "Ok"\n', 'application/toml'), true);
  });

  it('follows one safe HTTPS redirect', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/from')) {
        return new Response(null, {
          status: 301,
          headers: { location: `https://example.com${XAHAU_TOML_PATH}` },
        });
      }
      return new Response('[ORGANIZATION]\nname = "Redirected"\n', {
        status: 200,
        headers: { 'content-type': 'application/toml' },
      });
    };
    const fetched = await fetchPublicHttpsText('https://example.com/from', { fetchImpl });
    assert.equal(fetched.text.includes('Redirected'), true);
    assert.deepEqual(calls, ['https://example.com/from', `https://example.com${XAHAU_TOML_PATH}`]);
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

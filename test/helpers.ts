import type { Config } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';
import type { IssuerRow, TokenRow } from '../src/types/db.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    xahaudUrl: 'wss://xahau.network',
    dbPath: ':memory:',
    apiPort: 3000,
    apiHost: '127.0.0.1',
    logLevel: 'error',
    backfillFromLedger: null,
    backfillLookback: null,
    ...overrides,
  };
}

export function testRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    startedAt: Date.now(),
    networkLedgerIndex: null,
    ...overrides,
  };
}

export const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function sampleIssuer(account = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'): IssuerRow {
  return {
    account,
    domain: 'example.com',
    domain_verified: 0,
    email_hash: null,
    transfer_rate: null,
    flags: null,
    blackholed: 0,
    toml_name: null,
    toml_description: null,
    toml_icon_url: null,
    toml_raw: null,
    toml_checked_ledger: null,
    has_hooks: 0,
    first_ledger: 1,
    last_updated: 1,
  };
}

export function sampleToken(
  issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  currency = 'USD',
): TokenRow {
  return {
    id: `${currency}:${issuer}`,
    currency,
    currency_hex: null,
    issuer,
    name: 'USD',
    description: null,
    icon_url: null,
    website_url: null,
    supply: '1000',
    holder_count: 1,
    trust_count: 2,
    domain_verified: 0,
    blackholed: 0,
    first_ledger: 1,
    last_updated: 1,
  };
}

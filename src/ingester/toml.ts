import type { SqliteDatabase } from '../db/client.js';
import { getLatestLedgerIndex } from '../db/queries/indexer.js';
import {
  getIssuer,
  listIssuersDueForToml,
  updateIssuerToml,
} from '../db/queries/issuers.js';
import { syncTokenIssuerFlags } from '../db/queries/tokens.js';
import type { IssuerRow } from '../types/db.js';
import {
  fetchXrpLedgerToml,
  isAccountListed,
  parseXrpLedgerToml,
  pickTomlProfile,
} from '../util/domain.js';
import { sleep } from '../util/retry.js';
import type { LiveLogger } from './live.js';

export const TOML_REVERIFY_LEDGERS = 1000;

export type TomlLoader = (domain: string) => Promise<string>;

export interface TomlVerifyResult {
  account: string;
  verified: boolean;
  error?: string;
}

function defaultLoader(domain: string): Promise<string> {
  return fetchXrpLedgerToml(domain);
}

export async function verifyIssuerToml(options: {
  db: SqliteDatabase;
  account: string;
  ledger: number;
  loader?: TomlLoader;
  log: Pick<LiveLogger, 'warn' | 'info'>;
}): Promise<TomlVerifyResult> {
  const issuer = getIssuer(options.db, options.account);
  if (!issuer || issuer.domain === null || issuer.domain === '') {
    return { account: options.account, verified: false, error: 'no domain' };
  }
  const loader = options.loader ?? defaultLoader;
  try {
    const raw = await loader(issuer.domain);
    const toml = parseXrpLedgerToml(raw);
    const verified = isAccountListed(toml, issuer.account);
    const profile = pickTomlProfile(toml, issuer.account);
    updateIssuerToml(options.db, {
      account: issuer.account,
      domain_verified: verified ? 1 : 0,
      toml_name: profile.name ?? null,
      toml_description: profile.description ?? null,
      toml_icon_url: profile.icon ?? null,
      toml_raw: raw,
      toml_checked_ledger: options.ledger,
    });
    syncTokenIssuerFlags(options.db, issuer.account);
    if (!verified) {
      options.log.warn({ account: issuer.account, domain: issuer.domain }, 'TOML did not list issuer');
    } else {
      options.log.info({ account: issuer.account, domain: issuer.domain }, 'TOML verified issuer');
    }
    return { account: issuer.account, verified };
  } catch (error) {
    updateIssuerToml(options.db, {
      account: issuer.account,
      domain_verified: 0,
      toml_name: issuer.toml_name,
      toml_description: issuer.toml_description,
      toml_icon_url: issuer.toml_icon_url,
      toml_raw: issuer.toml_raw,
      toml_checked_ledger: options.ledger,
    });
    syncTokenIssuerFlags(options.db, issuer.account);
    const message = error instanceof Error ? error.message : String(error);
    options.log.warn(
      { err: error, account: issuer.account, domain: issuer.domain },
      'TOML verification failed',
    );
    return { account: issuer.account, verified: false, error: message };
  }
}

export async function runTomlPass(options: {
  db: SqliteDatabase;
  ledger: number;
  loader?: TomlLoader;
  log: Pick<LiveLogger, 'warn' | 'info'>;
  interval?: number;
  signal?: AbortSignal;
}): Promise<TomlVerifyResult[]> {
  const due = listIssuersDueForToml(options.db, options.ledger, options.interval ?? TOML_REVERIFY_LEDGERS);
  const results: TomlVerifyResult[] = [];
  for (const issuer of due) {
    if (options.signal?.aborted) {
      break;
    }
    results.push(
      await verifyIssuerToml({
        db: options.db,
        account: issuer.account,
        ledger: options.ledger,
        log: options.log,
        ...(options.loader === undefined ? {} : { loader: options.loader }),
      }),
    );
  }
  return results;
}

export async function runTomlWorker(options: {
  db: SqliteDatabase;
  log: LiveLogger;
  loader?: TomlLoader;
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<void> {
  const pollMs = options.pollMs ?? 2_000;
  while (options.signal === undefined || !options.signal.aborted) {
    try {
      await runTomlPass({
        db: options.db,
        ledger: getLatestLedgerIndex(options.db),
        log: options.log,
        ...(options.loader === undefined ? {} : { loader: options.loader }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      options.log.warn({ err: error }, 'toml pass failed');
    }
    if (options.signal?.aborted) {
      return;
    }
    if (options.signal === undefined) {
      await sleep(pollMs);
      continue;
    }
    try {
      await sleep(pollMs, options.signal);
    } catch {
      return;
    }
  }
}

export function issuerNeedsToml(issuer: IssuerRow, ledger: number, interval = TOML_REVERIFY_LEDGERS): boolean {
  if (issuer.domain === null || issuer.domain === '') {
    return false;
  }
  if (issuer.toml_checked_ledger === null) {
    return true;
  }
  return ledger - issuer.toml_checked_ledger >= interval;
}

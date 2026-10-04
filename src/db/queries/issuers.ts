import type { IssuerRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function ensureIssuer(db: SqliteDatabase, account: string, ledger: number): void {
  db.prepare(
    `
    INSERT INTO issuers (
      account, domain_verified, blackholed, has_hooks, first_ledger, last_updated
    ) VALUES (?, 0, 0, 0, ?, ?)
    ON CONFLICT(account) DO NOTHING
    `,
  ).run(account, ledger, ledger);
}

export function updateIssuerOnChain(
  db: SqliteDatabase,
  row: Pick<
    IssuerRow,
    | 'account'
    | 'domain'
    | 'email_hash'
    | 'transfer_rate'
    | 'flags'
    | 'blackholed'
    | 'has_hooks'
    | 'last_updated'
  >,
): void {
  db.prepare(
    `
    UPDATE issuers SET
      domain = @domain,
      email_hash = @email_hash,
      transfer_rate = @transfer_rate,
      flags = @flags,
      blackholed = @blackholed,
      has_hooks = @has_hooks,
      last_updated = @last_updated
    WHERE account = @account
    `,
  ).run(row);
}

export function getIssuer(db: SqliteDatabase, account: string): IssuerRow | undefined {
  return db.prepare('SELECT * FROM issuers WHERE account = ?').get(account) as IssuerRow | undefined;
}

export function upsertIssuer(db: SqliteDatabase, row: IssuerRow): void {
  db.prepare(
    `
    INSERT INTO issuers (
      account, domain, domain_verified, email_hash, transfer_rate, flags,
      blackholed, toml_name, toml_description, toml_icon_url, toml_links, toml_raw,
      toml_checked_ledger, has_hooks, first_ledger, last_updated
    ) VALUES (
      @account, @domain, @domain_verified, @email_hash, @transfer_rate, @flags,
      @blackholed, @toml_name, @toml_description, @toml_icon_url, @toml_links, @toml_raw,
      @toml_checked_ledger, @has_hooks, @first_ledger, @last_updated
    )
    ON CONFLICT(account) DO UPDATE SET
      domain = excluded.domain,
      domain_verified = excluded.domain_verified,
      email_hash = excluded.email_hash,
      transfer_rate = excluded.transfer_rate,
      flags = excluded.flags,
      blackholed = excluded.blackholed,
      toml_name = excluded.toml_name,
      toml_description = excluded.toml_description,
      toml_icon_url = excluded.toml_icon_url,
      toml_links = excluded.toml_links,
      toml_raw = excluded.toml_raw,
      toml_checked_ledger = excluded.toml_checked_ledger,
      has_hooks = excluded.has_hooks,
      last_updated = excluded.last_updated
    `,
  ).run(row);
}

export function updateIssuerToml(
  db: SqliteDatabase,
  row: Pick<
    IssuerRow,
    | 'account'
    | 'domain_verified'
    | 'toml_name'
    | 'toml_description'
    | 'toml_icon_url'
    | 'toml_links'
    | 'toml_raw'
    | 'toml_checked_ledger'
  >,
): void {
  db.prepare(
    `
    UPDATE issuers SET
      domain_verified = @domain_verified,
      toml_name = @toml_name,
      toml_description = @toml_description,
      toml_icon_url = @toml_icon_url,
      toml_links = @toml_links,
      toml_raw = @toml_raw,
      toml_checked_ledger = @toml_checked_ledger
    WHERE account = @account
    `,
  ).run(row);
}

export function invalidateIssuerToml(db: SqliteDatabase, account: string): void {
  db.prepare(
    `
    UPDATE issuers SET
      domain_verified = 0,
      toml_name = NULL,
      toml_description = NULL,
      toml_icon_url = NULL,
      toml_links = NULL,
      toml_raw = NULL,
      toml_checked_ledger = NULL
    WHERE account = ?
    `,
  ).run(account);
  db.prepare('UPDATE tokens SET toml_links = NULL WHERE issuer = ?').run(account);
}

export function listIssuersDueForToml(
  db: SqliteDatabase,
  ledger: number,
  interval = 1000,
): IssuerRow[] {
  return db
    .prepare(
      `
      SELECT issuers.* FROM issuers
      WHERE domain IS NOT NULL AND domain != ''
        AND (toml_checked_ledger IS NULL OR (? - toml_checked_ledger) >= ?)
      ORDER BY
        CASE WHEN EXISTS (SELECT 1 FROM tokens WHERE tokens.issuer = issuers.account) THEN 0 ELSE 1 END,
        account ASC
      `,
    )
    .all(ledger, interval) as IssuerRow[];
}

export function listIssuers(
  db: SqliteDatabase,
  opts: { page: number; perPage: number; domainVerified?: 0 | 1; hasHooks?: 0 | 1 },
): IssuerRow[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {
    limit: opts.perPage,
    offset: (opts.page - 1) * opts.perPage,
  };
  if (opts.domainVerified !== undefined) {
    where.push('domain_verified = @domain_verified');
    params.domain_verified = opts.domainVerified;
  }
  if (opts.hasHooks !== undefined) {
    where.push('has_hooks = @has_hooks');
    params.has_hooks = opts.hasHooks;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `
      SELECT * FROM issuers
      ${clause}
      ORDER BY first_ledger ASC
      LIMIT @limit OFFSET @offset
      `,
    )
    .all(params) as IssuerRow[];
}

import type { IssuerRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function getIssuer(db: SqliteDatabase, account: string): IssuerRow | undefined {
  return db.prepare('SELECT * FROM issuers WHERE account = ?').get(account) as IssuerRow | undefined;
}

export function upsertIssuer(db: SqliteDatabase, row: IssuerRow): void {
  db.prepare(
    `
    INSERT INTO issuers (
      account, domain, domain_verified, email_hash, transfer_rate, flags,
      blackholed, toml_name, toml_description, toml_icon_url, toml_raw,
      has_hooks, first_ledger, last_updated
    ) VALUES (
      @account, @domain, @domain_verified, @email_hash, @transfer_rate, @flags,
      @blackholed, @toml_name, @toml_description, @toml_icon_url, @toml_raw,
      @has_hooks, @first_ledger, @last_updated
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
      toml_raw = excluded.toml_raw,
      has_hooks = excluded.has_hooks,
      last_updated = excluded.last_updated
    `,
  ).run(row);
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

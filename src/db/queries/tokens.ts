import type { TokenListFilter, TokenRow, TrustLineRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function tokenId(currency: string, issuer: string): string {
  return `${currency}:${issuer}`;
}

export function getToken(db: SqliteDatabase, id: string): TokenRow | undefined {
  return db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as TokenRow | undefined;
}

export function getTokenByCurrencyIssuer(
  db: SqliteDatabase,
  currency: string,
  issuer: string,
): TokenRow | undefined {
  return getToken(db, tokenId(currency, issuer));
}

export function upsertToken(db: SqliteDatabase, row: TokenRow): void {
  db.prepare(
    `
    INSERT INTO tokens (
      id, currency, currency_hex, issuer, name, description, icon_url, website_url,
      supply, holder_count, trust_count, domain_verified, blackholed, first_ledger, last_updated
    ) VALUES (
      @id, @currency, @currency_hex, @issuer, @name, @description, @icon_url, @website_url,
      @supply, @holder_count, @trust_count, @domain_verified, @blackholed, @first_ledger, @last_updated
    )
    ON CONFLICT(id) DO UPDATE SET
      currency = excluded.currency,
      currency_hex = excluded.currency_hex,
      name = excluded.name,
      description = excluded.description,
      icon_url = excluded.icon_url,
      website_url = excluded.website_url,
      supply = excluded.supply,
      holder_count = excluded.holder_count,
      trust_count = excluded.trust_count,
      domain_verified = excluded.domain_verified,
      blackholed = excluded.blackholed,
      last_updated = excluded.last_updated
    `,
  ).run(row);
}

export function listTokens(db: SqliteDatabase, filter: TokenListFilter): TokenRow[] {
  const { clause, params } = tokenFilterSql(filter);
  const sortColumn =
    filter.sort === 'trust_count'
      ? 'trust_count'
      : filter.sort === 'first_ledger'
        ? 'first_ledger'
        : 'holder_count';
  return db
    .prepare(
      `
      SELECT * FROM tokens
      ${clause}
      ORDER BY ${sortColumn} DESC
      LIMIT @limit OFFSET @offset
      `,
    )
    .all(params) as TokenRow[];
}

export function countTokens(db: SqliteDatabase, filter: TokenListFilter): number {
  const { clause, params } = tokenFilterSql(filter);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tokens ${clause}`).get(params) as { n: number };
  return row.n;
}

export function upsertTrustLine(db: SqliteDatabase, row: TrustLineRow): void {
  db.prepare(
    `
    INSERT INTO trust_lines (
      id, account, currency, issuer, balance, limit_peer, quality_in, quality_out,
      flags, first_ledger, last_updated
    ) VALUES (
      @id, @account, @currency, @issuer, @balance, @limit_peer, @quality_in, @quality_out,
      @flags, @first_ledger, @last_updated
    )
    ON CONFLICT(id) DO UPDATE SET
      balance = excluded.balance,
      limit_peer = excluded.limit_peer,
      quality_in = excluded.quality_in,
      quality_out = excluded.quality_out,
      flags = excluded.flags,
      last_updated = excluded.last_updated
    `,
  ).run(row);
}

export function listHolders(
  db: SqliteDatabase,
  currency: string,
  issuer: string,
  opts: { page: number; perPage: number; nonzero: boolean },
): TrustLineRow[] {
  const where = opts.nonzero
    ? 'currency = @currency AND issuer = @issuer AND balance != @zero'
    : 'currency = @currency AND issuer = @issuer';
  return db
    .prepare(
      `
      SELECT * FROM trust_lines
      WHERE ${where}
      ORDER BY account ASC
      LIMIT @limit OFFSET @offset
      `,
    )
    .all({
      currency,
      issuer,
      zero: '0',
      limit: opts.perPage,
      offset: (opts.page - 1) * opts.perPage,
    }) as TrustLineRow[];
}

function tokenFilterSql(filter: TokenListFilter): {
  clause: string;
  params: Record<string, string | number>;
} {
  const where: string[] = [];
  const params: Record<string, string | number> = {
    limit: filter.perPage,
    offset: (filter.page - 1) * filter.perPage,
  };
  if (filter.issuer !== undefined) {
    where.push('issuer = @issuer');
    params.issuer = filter.issuer;
  }
  if (filter.currency !== undefined) {
    where.push('currency = @currency');
    params.currency = filter.currency;
  }
  if (filter.domainVerified !== undefined) {
    where.push('domain_verified = @domain_verified');
    params.domain_verified = filter.domainVerified;
  }
  if (filter.q !== undefined && filter.q !== '') {
    where.push('(name LIKE @q OR currency LIKE @q)');
    params.q = `%${filter.q}%`;
  }
  return {
    clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

import type { TokenListFilter, TokenRow, TrustLineRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

import { addDecimal, isZeroDecimal } from '../../util/xahau.js';

export function tokenId(currency: string, issuer: string): string {
  return `${currency}:${issuer}`;
}

export function ensureToken(
  db: SqliteDatabase,
  row: Pick<TokenRow, 'id' | 'currency' | 'currency_hex' | 'issuer' | 'first_ledger' | 'last_updated'>,
): void {
  db.prepare(
    `
    INSERT INTO tokens (
      id, currency, currency_hex, issuer, holder_count, trust_count,
      domain_verified, blackholed, first_ledger, last_updated
    ) VALUES (
      @id, @currency, @currency_hex, @issuer, 0, 0, 0, 0, @first_ledger, @last_updated
    )
    ON CONFLICT(id) DO NOTHING
    `,
  ).run(row);
}

export function updateTokenDisplay(
  db: SqliteDatabase,
  id: string,
  fields: { name?: string; description?: string; icon_url?: string; website_url?: string },
): void {
  const current = getToken(db, id);
  if (!current) {
    return;
  }
  db.prepare(
    `
    UPDATE tokens SET
      name = @name,
      description = @description,
      icon_url = @icon_url,
      website_url = @website_url
    WHERE id = @id
    `,
  ).run({
    id,
    name: fields.name ?? current.name,
    description: fields.description ?? current.description,
    icon_url: fields.icon_url ?? current.icon_url,
    website_url: fields.website_url ?? current.website_url,
  });
}

export function syncTokenIssuerFlags(db: SqliteDatabase, issuer?: string): void {
  if (issuer === undefined) {
    db.exec(`
      UPDATE tokens SET
        domain_verified = COALESCE((SELECT domain_verified FROM issuers WHERE issuers.account = tokens.issuer), 0),
        blackholed = COALESCE((SELECT blackholed FROM issuers WHERE issuers.account = tokens.issuer), 0)
    `);
    return;
  }
  db.prepare(
    `
    UPDATE tokens SET
      domain_verified = COALESCE((SELECT domain_verified FROM issuers WHERE issuers.account = tokens.issuer), 0),
      blackholed = COALESCE((SELECT blackholed FROM issuers WHERE issuers.account = tokens.issuer), 0)
    WHERE issuer = ?
    `,
  ).run(issuer);
}

export function splitTokenId(id: string): { currency: string; issuer: string } {
  const sep = id.indexOf(':');
  if (sep <= 0 || sep === id.length - 1) {
    return { currency: id, issuer: '' };
  }
  return { currency: id.slice(0, sep), issuer: id.slice(sep + 1) };
}

function aggregateLines(
  lines: Array<{ currency: string; issuer: string; account: string; balance: string }>,
): Map<string, { holders: number; trusts: number; supply: string }> {
  const aggregates = new Map<string, { holders: number; trusts: number; supply: string }>();
  for (const line of lines) {
    const id = tokenId(line.currency, line.issuer);
    const current = aggregates.get(id) ?? { holders: 0, trusts: 0, supply: '0' };
    current.trusts += 1;
    if (line.account !== line.issuer && !isZeroDecimal(line.balance)) {
      current.holders += 1;
      current.supply = addDecimal(current.supply, line.balance);
    }
    aggregates.set(id, current);
  }
  return aggregates;
}

export function recomputeTokenAggregates(
  db: SqliteDatabase,
  tokenIds?: Iterable<string>,
  ledger?: number,
): void {
  const scoped = tokenIds === undefined ? undefined : [...new Set(tokenIds)];
  if (scoped !== undefined && scoped.length === 0) {
    return;
  }

  const update = db.prepare(
    `
    UPDATE tokens SET
      holder_count = @holder_count,
      trust_count = @trust_count,
      supply = @supply
      ${ledger === undefined ? '' : ', last_updated = @last_updated'}
    WHERE id = @id
    `,
  );

  if (scoped === undefined) {
    const lines = db
      .prepare('SELECT currency, issuer, account, balance FROM trust_lines')
      .all() as Array<{ currency: string; issuer: string; account: string; balance: string }>;
    for (const [id, agg] of aggregateLines(lines)) {
      update.run({
        id,
        holder_count: agg.holders,
        trust_count: agg.trusts,
        supply: agg.supply,
        ...(ledger === undefined ? {} : { last_updated: ledger }),
      });
    }
    return;
  }

  const select = db.prepare(
    'SELECT currency, issuer, account, balance FROM trust_lines WHERE currency = ? AND issuer = ?',
  );
  for (const id of scoped) {
    const { currency, issuer } = splitTokenId(id);
    const lines = select.all(currency, issuer) as Array<{
      currency: string;
      issuer: string;
      account: string;
      balance: string;
    }>;
    const agg = aggregateLines(lines).get(id) ?? { holders: 0, trusts: 0, supply: '0' };
    update.run({
      id,
      holder_count: agg.holders,
      trust_count: agg.trusts,
      supply: agg.supply,
      ...(ledger === undefined ? {} : { last_updated: ledger }),
    });
  }
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

export function getTrustLine(db: SqliteDatabase, id: string): TrustLineRow | undefined {
  return db.prepare('SELECT * FROM trust_lines WHERE id = ?').get(id) as TrustLineRow | undefined;
}

export function deleteTrustLine(db: SqliteDatabase, id: string): void {
  db.prepare('DELETE FROM trust_lines WHERE id = ?').run(id);
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

export function countHolders(
  db: SqliteDatabase,
  currency: string,
  issuer: string,
  nonzero: boolean,
): number {
  const where = nonzero
    ? 'currency = @currency AND issuer = @issuer AND balance != @zero'
    : 'currency = @currency AND issuer = @issuer';
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM trust_lines WHERE ${where}`)
    .get({ currency, issuer, zero: '0' }) as { n: number };
  return row.n;
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

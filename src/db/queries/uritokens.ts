import type { UriTokenRow, UriTokenTransferRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function countUriTokens(
  db: SqliteDatabase,
  opts: { issuer?: string; owner?: string; burned?: 0 | 1; forSale?: boolean },
): number {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (opts.issuer !== undefined) {
    where.push('issuer = @issuer');
    params.issuer = opts.issuer;
  }
  if (opts.owner !== undefined) {
    where.push('owner = @owner');
    params.owner = opts.owner;
  }
  if (opts.burned !== undefined) {
    where.push('burned = @burned');
    params.burned = opts.burned;
  }
  if (opts.forSale === true) {
    where.push('sell_offer IS NOT NULL');
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) AS n FROM uri_tokens ${clause}`).get(params) as { n: number };
  return row.n;
}

export function getUriToken(db: SqliteDatabase, id: string): UriTokenRow | undefined {
  return db.prepare('SELECT * FROM uri_tokens WHERE id = ?').get(id) as UriTokenRow | undefined;
}

export function upsertUriToken(db: SqliteDatabase, row: UriTokenRow): void {
  db.prepare(
    `
    INSERT INTO uri_tokens (
      id, uri, uri_raw, digest, issuer, owner, flags, sell_offer, destination,
      burned, burn_ledger, mint_ledger, last_updated, icon_url, uri_meta_checked_ledger
    ) VALUES (
      @id, @uri, @uri_raw, @digest, @issuer, @owner, @flags, @sell_offer, @destination,
      @burned, @burn_ledger, @mint_ledger, @last_updated, @icon_url, @uri_meta_checked_ledger
    )
    ON CONFLICT(id) DO UPDATE SET
      uri = excluded.uri,
      uri_raw = excluded.uri_raw,
      digest = excluded.digest,
      owner = excluded.owner,
      flags = excluded.flags,
      sell_offer = excluded.sell_offer,
      destination = excluded.destination,
      burned = excluded.burned,
      burn_ledger = excluded.burn_ledger,
      last_updated = excluded.last_updated,
      icon_url = COALESCE(excluded.icon_url, uri_tokens.icon_url),
      uri_meta_checked_ledger = COALESCE(excluded.uri_meta_checked_ledger, uri_tokens.uri_meta_checked_ledger)
    `,
  ).run(row);
}

export function updateUriTokenIcon(db: SqliteDatabase, id: string, iconUrl: string | null): void {
  db.prepare('UPDATE uri_tokens SET icon_url = @icon_url WHERE id = @id').run({
    id,
    icon_url: iconUrl,
  });
}

export function markUriTokenMetaChecked(db: SqliteDatabase, id: string, ledger: number): void {
  db.prepare('UPDATE uri_tokens SET uri_meta_checked_ledger = @ledger WHERE id = @id').run({
    id,
    ledger,
  });
}

export function listUriTokensDueForMeta(
  db: SqliteDatabase,
  ledger: number,
  interval = 1000,
  limit = 25,
): UriTokenRow[] {
  return db
    .prepare(
      `
      SELECT * FROM uri_tokens
      WHERE uri IS NOT NULL
        AND uri != ''
        AND (icon_url IS NULL OR icon_url = '')
        AND (uri_meta_checked_ledger IS NULL OR @ledger - uri_meta_checked_ledger >= @interval)
      ORDER BY mint_ledger DESC
      LIMIT @limit
      `,
    )
    .all({ ledger, interval, limit }) as UriTokenRow[];
}

export function markUriTokenBurned(db: SqliteDatabase, id: string, ledger: number): void {
  db.prepare(
    `
    UPDATE uri_tokens SET
      burned = 1,
      burn_ledger = @ledger,
      sell_offer = NULL,
      destination = NULL,
      last_updated = @ledger
    WHERE id = @id
    `,
  ).run({ id, ledger });
}

export function insertUriTokenTransfer(
  db: SqliteDatabase,
  row: Omit<UriTokenTransferRow, 'id'>,
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO uri_token_transfers (
      uri_token_id, from_account, to_account, price, ledger_index, tx_hash
    ) VALUES (
      @uri_token_id, @from_account, @to_account, @price, @ledger_index, @tx_hash
    )
    `,
  ).run(row);
}

export function listUriTokenTransfers(db: SqliteDatabase, uriTokenId: string): UriTokenTransferRow[] {
  return db
    .prepare(
      `
      SELECT * FROM uri_token_transfers
      WHERE uri_token_id = ?
      ORDER BY ledger_index ASC, id ASC
      `,
    )
    .all(uriTokenId) as UriTokenTransferRow[];
}

export function listUriTokens(
  db: SqliteDatabase,
  opts: {
    page: number;
    perPage: number;
    issuer?: string;
    owner?: string;
    burned?: 0 | 1;
    forSale?: boolean;
    sort?: 'mint_ledger' | 'last_updated';
  },
): UriTokenRow[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {
    limit: opts.perPage,
    offset: (opts.page - 1) * opts.perPage,
  };
  if (opts.issuer !== undefined) {
    where.push('issuer = @issuer');
    params.issuer = opts.issuer;
  }
  if (opts.owner !== undefined) {
    where.push('owner = @owner');
    params.owner = opts.owner;
  }
  if (opts.burned !== undefined) {
    where.push('burned = @burned');
    params.burned = opts.burned;
  }
  if (opts.forSale === true) {
    where.push('sell_offer IS NOT NULL');
  }
  const sort = opts.sort === 'last_updated' ? 'last_updated' : 'mint_ledger';
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `
      SELECT * FROM uri_tokens
      ${clause}
      ORDER BY ${sort} DESC
      LIMIT @limit OFFSET @offset
      `,
    )
    .all(params) as UriTokenRow[];
}

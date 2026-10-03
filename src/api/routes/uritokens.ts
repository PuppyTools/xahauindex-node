import type { FastifyPluginAsync } from 'fastify';

import { getLatestLedgerIndex } from '../../db/queries/indexer.js';
import { listRemarksByUriToken, remarksToMap } from '../../db/queries/remarks.js';
import {
  countUriTokens,
  getUriToken,
  listUriTokenTransfers,
  listUriTokens,
} from '../../db/queries/uritokens.js';
import { notFound } from '../errors.js';
import { uriTokenFromRow } from '../mappers.js';
import { asQuery, parseBoolQuery, parsePage, parsePerPage } from '../query.js';

export const uriTokenRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/uritokens', async (request) => {
    const query = asQuery(request.query);
    const burned = parseBoolQuery(query.burned);
    const forSale = parseBoolQuery(query.for_sale);
    const sort =
      query.sort === 'last_updated' || query.sort === 'mint_ledger' ? query.sort : undefined;
    const opts: Parameters<typeof listUriTokens>[1] = {
      page: parsePage(query.page),
      perPage: parsePerPage(query.per_page),
      burned: (burned ?? false) ? 1 : 0,
    };
    if (query.issuer !== undefined) {
      opts.issuer = query.issuer;
    }
    if (query.owner !== undefined) {
      opts.owner = query.owner;
    }
    if (forSale !== undefined) {
      opts.forSale = forSale;
    }
    if (sort !== undefined) {
      opts.sort = sort;
    }
    const rows = listUriTokens(app.db, opts);
    return {
      data: rows.map((row) => uriTokenFromRow(row)),
      meta: {
        count: countUriTokens(app.db, opts),
        page: opts.page,
        per_page: opts.perPage,
        ledger_index: getLatestLedgerIndex(app.db),
      },
    };
  });

  app.get('/v1/uritokens/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = getUriToken(app.db, id.toUpperCase()) ?? getUriToken(app.db, id);
    if (!row) {
      throw notFound(`URIToken ${id} not found`);
    }
    const transfers = listUriTokenTransfers(app.db, row.id);
    return {
      data: {
        ...uriTokenFromRow(row, {
          remarks: remarksToMap(listRemarksByUriToken(app.db, row.id)),
          transferCount: transfers.length,
        }),
        transfers,
      },
      meta: { ledger_index: getLatestLedgerIndex(app.db) },
    };
  });
};

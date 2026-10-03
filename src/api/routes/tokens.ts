import type { FastifyPluginAsync } from 'fastify';

import { getLatestLedgerIndex } from '../../db/queries/indexer.js';
import { listRemarksByTokenId, remarksToMap } from '../../db/queries/remarks.js';
import { getIssuer } from '../../db/queries/issuers.js';
import { pairPriceSummary } from '../../db/queries/dex.js';
import {
  countHolders,
  countTokens,
  getTokenByCurrencyIssuer,
  listHolders,
  listTokens,
} from '../../db/queries/tokens.js';
import type { TokenListFilter } from '../../types/db.js';
import { isValidAccount } from '../../util/xahau.js';
import { notFound } from '../errors.js';
import { issuerFromRow, tokenFromRow, trustLineFromRow } from '../mappers.js';
import { tokenXahPair } from '../pair.js';
import { asQuery, parseBoolQuery, parsePage, parsePerPage } from '../query.js';

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tokens', async (request) => {
    const query = asQuery(request.query);
    const filter: TokenListFilter = {
      page: parsePage(query.page),
      perPage: parsePerPage(query.per_page),
    };
    if (query.issuer !== undefined) {
      filter.issuer = query.issuer;
    }
    if (query.currency !== undefined) {
      filter.currency = query.currency;
    }
    const verified = parseBoolQuery(query.domain_verified);
    if (verified !== undefined) {
      filter.domainVerified = verified ? 1 : 0;
    }
    if (query.q !== undefined) {
      filter.q = query.q;
    }
    if (query.sort === 'trust_count' || query.sort === 'first_ledger' || query.sort === 'holder_count') {
      filter.sort = query.sort;
    }
    const rows = listTokens(app.db, filter);
    return {
      data: rows.map((row) => tokenFromRow(row)),
      meta: {
        count: countTokens(app.db, filter),
        page: filter.page,
        per_page: filter.perPage,
        ledger_index: getLatestLedgerIndex(app.db),
      },
    };
  });

  app.get('/v1/tokens/:currency/:issuer', async (request) => {
    const params = request.params as { currency: string; issuer: string };
    if (!isValidAccount(params.issuer)) {
      throw notFound(`Token ${params.currency}/${params.issuer} not found`);
    }
    const row = getTokenByCurrencyIssuer(app.db, params.currency, params.issuer);
    if (!row) {
      throw notFound(`Token ${params.currency}/${params.issuer} not found`);
    }
    const issuer = getIssuer(app.db, row.issuer);
    const price = pairPriceSummary(app.db, tokenXahPair(row.currency, row.issuer));
    return {
      data: {
        ...tokenFromRow(row, remarksToMap(listRemarksByTokenId(app.db, row.id))),
        ...(issuer === undefined ? {} : { issuer_profile: issuerFromRow(issuer) }),
        price,
      },
      meta: { ledger_index: getLatestLedgerIndex(app.db) },
    };
  });

  app.get('/v1/tokens/:currency/:issuer/holders', async (request) => {
    const params = request.params as { currency: string; issuer: string };
    if (!isValidAccount(params.issuer)) {
      throw notFound(`Token ${params.currency}/${params.issuer} not found`);
    }
    const row = getTokenByCurrencyIssuer(app.db, params.currency, params.issuer);
    if (!row) {
      throw notFound(`Token ${params.currency}/${params.issuer} not found`);
    }
    const query = asQuery(request.query);
    const nonzero = parseBoolQuery(query.nonzero) ?? true;
    const page = parsePage(query.page);
    const perPage = parsePerPage(query.per_page);
    const holders = listHolders(app.db, row.currency, row.issuer, { page, perPage, nonzero });
    return {
      data: holders.map((holder) => trustLineFromRow(holder)),
      meta: {
        count: countHolders(app.db, row.currency, row.issuer, nonzero),
        page,
        per_page: perPage,
        ledger_index: getLatestLedgerIndex(app.db),
      },
    };
  });
};

import type { FastifyPluginAsync } from 'fastify';

import { getLatestLedgerIndex } from '../../db/queries/indexer.js';
import { getIssuer, listIssuers } from '../../db/queries/issuers.js';
import { listRemarksByAccount, remarksToMap } from '../../db/queries/remarks.js';
import { listTokens } from '../../db/queries/tokens.js';
import { getHookAccount } from '../../db/queries/hooks.js';
import { isValidAccount } from '../../util/xahau.js';
import { notFound } from '../errors.js';
import { hookStateFromRow, issuerFromRow, tokenFromRow } from '../mappers.js';
import { asQuery, parseBoolQuery, parsePage, parsePerPage } from '../query.js';

export const issuerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/issuers', async (request) => {
    const query = asQuery(request.query);
    const domainVerified = parseBoolQuery(query.domain_verified);
    const hasHooks = parseBoolQuery(query.has_hooks);
    const page = parsePage(query.page);
    const perPage = parsePerPage(query.per_page);
    const rows = listIssuers(app.db, {
      page,
      perPage,
      ...(domainVerified === undefined ? {} : { domainVerified: domainVerified ? 1 : 0 }),
      ...(hasHooks === undefined ? {} : { hasHooks: hasHooks ? 1 : 0 }),
    });
    return {
      data: rows.map((row) => issuerFromRow(row)),
      meta: {
        page,
        per_page: perPage,
        ledger_index: getLatestLedgerIndex(app.db),
      },
    };
  });

  app.get('/v1/issuers/:account', async (request) => {
    const { account } = request.params as { account: string };
    if (!isValidAccount(account)) {
      throw notFound(`Issuer ${account} not found`);
    }
    const row = getIssuer(app.db, account);
    if (!row) {
      throw notFound(`Issuer ${account} not found`);
    }
    const tokens = listTokens(app.db, { issuer: account, page: 1, perPage: 100 });
    const hooks = getHookAccount(app.db, account);
    return {
      data: {
        ...issuerFromRow(row, {
          tokenCount: tokens.length,
          remarks: remarksToMap(listRemarksByAccount(app.db, account)),
        }),
        tokens: tokens.map((token) => tokenFromRow(token)),
        hooks: hooks === undefined ? null : hookStateFromRow(hooks),
      },
      meta: { ledger_index: getLatestLedgerIndex(app.db) },
    };
  });
};

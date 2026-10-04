import type { FastifyPluginAsync } from 'fastify';

import { getHookAccount, listHookAccounts } from '../../db/queries/hooks.js';
import { getLatestLedgerIndex } from '../../db/queries/indexer.js';
import { isValidAccount } from '../../util/xahau.js';
import { notFound } from '../errors.js';
import { hookStateFromRow } from '../mappers.js';
import { asQuery, parsePage, parsePerPage } from '../query.js';

export const hookRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/hooks', async (request) => {
    const query = asQuery(request.query);
    const page = parsePage(query.page);
    const perPage = parsePerPage(query.per_page);
    const rows = listHookAccounts(app.db, {
      page,
      perPage,
      ...(query.hook_hash === undefined ? {} : { hookHash: query.hook_hash }),
    });
    return {
      data: rows.map((row) => hookStateFromRow(row)),
      meta: {
        page,
        per_page: perPage,
        ledger_index: getLatestLedgerIndex(app.db),
      },
    };
  });

  app.get('/v1/hooks/:account', async (request) => {
    const { account } = request.params as { account: string };
    if (!isValidAccount(account)) {
      throw notFound(`Account ${account} has no indexed Hooks`);
    }
    const row = getHookAccount(app.db, account);
    if (!row) {
      throw notFound(`Account ${account} has no indexed Hooks`);
    }
    return {
      data: hookStateFromRow(row),
      meta: { ledger_index: getLatestLedgerIndex(app.db) },
    };
  });
};

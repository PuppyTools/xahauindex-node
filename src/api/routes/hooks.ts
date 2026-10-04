import type { FastifyPluginAsync } from 'fastify';

import {
  getHookAccount,
  getHookDefinition,
  listHookAccounts,
  listHookDefinitions,
} from '../../db/queries/hooks.js';
import { getLatestLedgerIndex } from '../../db/queries/indexer.js';
import { isValidAccount } from '../../util/xahau.js';
import { notFound } from '../errors.js';
import { hookDefinitionFromRow, hookStateFromDb } from '../mappers.js';
import { asQuery, parsePage, parsePerPage } from '../query.js';

const HOOK_HASH = /^[0-9A-Fa-f]{64}$/;

export const hookRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/hooks/definitions', async (request) => {
    const query = asQuery(request.query);
    const page = parsePage(query.page);
    const perPage = parsePerPage(query.per_page);
    const rows = listHookDefinitions(app.db, { page, perPage });
    return {
      data: rows.map((row) => hookDefinitionFromRow(row)),
      meta: {
        page,
        per_page: perPage,
        ledger_index: getLatestLedgerIndex(app.db),
      },
    };
  });

  app.get('/v1/hooks/definitions/:hook_hash', async (request) => {
    const { hook_hash: hookHash } = request.params as { hook_hash: string };
    if (!HOOK_HASH.test(hookHash)) {
      throw notFound(`Hook definition ${hookHash} not found`);
    }
    const row = getHookDefinition(app.db, hookHash.toUpperCase());
    if (!row) {
      throw notFound(`Hook definition ${hookHash} not found`);
    }
    return {
      data: hookDefinitionFromRow(row),
      meta: { ledger_index: getLatestLedgerIndex(app.db) },
    };
  });

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
      data: rows.map((row) => hookStateFromDb(app.db, row)),
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
      data: hookStateFromDb(app.db, row),
      meta: { ledger_index: getLatestLedgerIndex(app.db) },
    };
  });
};

import type { FastifyPluginAsync } from 'fastify';

import { readStatus } from '../../db/queries/status.js';
import { StatusResponseSchema } from '../schemas/status.js';

export const statusRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/status',
    {
      schema: {
        response: {
          200: StatusResponseSchema,
        },
      },
    },
    async () => {
      const data = readStatus(app.db, app.startedAt, app.networkLedgerIndex);
      return {
        data,
        meta: {
          ledger_index: data.ledger_index,
          ...(data.history_start_ledger === null
            ? {}
            : { history_start_ledger: data.history_start_ledger }),
        },
      };
    },
  );
};

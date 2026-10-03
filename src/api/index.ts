import cors from '@fastify/cors';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { LogLevel } from '../config.js';
import type { AppContext } from './context.js';
import { ApiError } from './errors.js';
import { statusRoutes } from './routes/status.js';

export type AppInstance = FastifyInstance<
  import('http').Server,
  import('http').IncomingMessage,
  import('http').ServerResponse,
  import('fastify').FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export async function buildApi(
  context: AppContext,
  logLevel?: LogLevel,
): Promise<AppInstance> {
  const app = Fastify({
    logger: logLevel === undefined ? false : { level: logLevel },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('db', context.db);
  app.decorate('config', context.config);
  app.decorate('startedAt', context.startedAt);
  app.decorate('networkLedgerIndex', context.networkLedgerIndex);

  await app.register(cors, { origin: true });
  await app.register(statusRoutes);

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route ${request.method} ${request.url}`,
      },
    });
  });

  app.setErrorHandler((error: FastifyError | ApiError, _request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    const statusCode = error.statusCode ?? 500;
    const code = statusCode === 400 ? 'BAD_REQUEST' : 'INTERNAL';
    app.log.error({ err: error }, error.message);
    reply.status(statusCode).send({
      error: {
        code,
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    });
  });

  return app;
}

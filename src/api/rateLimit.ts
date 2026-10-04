import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

import { resolveWsMaxPerIp, type Config } from '../config.js';
import { createIpAllowlist } from '../util/allowlist.js';
import { rateLimited } from './errors.js';

export async function registerApiRateLimit(app: FastifyInstance, config: Config): Promise<void> {
  const max = config.apiRateLimitMax;
  if (max === null) {
    return;
  }

  const allowed = createIpAllowlist(config.apiRateLimitAllow);
  await app.register(rateLimit, {
    global: true,
    max,
    timeWindow: config.apiRateLimitWindowMs,
    allowList: (request) => allowed(request.ip),
    skipOnError: true,
    errorResponseBuilder: () => rateLimited(),
  });

  app.log.info(
    {
      max,
      windowMs: config.apiRateLimitWindowMs,
      wsMaxPerIp: resolveWsMaxPerIp(config),
      trustProxy: config.apiTrustProxy,
      allow: config.apiRateLimitAllow,
    },
    'api rate limit enabled',
  );
}

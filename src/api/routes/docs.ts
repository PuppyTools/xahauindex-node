import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

function resolveAsset(relativePath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), relativePath),
    join(here, '../../..', relativePath),
    join(here, '../../../..', relativePath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Missing asset ${relativePath}`);
}

export const docsRoutes: FastifyPluginAsync = async (app) => {
  const html = readFileSync(resolveAsset('public/docs/index.html'), 'utf8');
  const openapi = readFileSync(resolveAsset('docs/openapi.yaml'), 'utf8');

  const sendDocs = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('text/html; charset=utf-8').send(html);
  };

  app.get('/', sendDocs);
  app.get('/docs', sendDocs);
  app.get('/docs/', sendDocs);
  app.get('/v1/openapi.yaml', async (_request, reply) => {
    return reply.type('application/yaml; charset=utf-8').send(openapi);
  });
};

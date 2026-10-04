import { readFileSync } from 'node:fs';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { renderCookbookMarkdown, renderDocsHtml } from '../docsPage.js';
import { loadOpenApi, loadOpenApiYaml, resolveAsset } from '../openapi.js';

export const docsRoutes: FastifyPluginAsync = async (app) => {
  const openapiYaml = loadOpenApiYaml();
  const spec = loadOpenApi();
  const html = renderDocsHtml(spec);
  const cookbook = renderCookbookMarkdown(spec);
  const css = readFileSync(resolveAsset('public/docs/docs.css'), 'utf8');

  const sendDocs = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('text/html; charset=utf-8').send(html);
  };

  app.get('/', sendDocs);
  app.get('/docs', sendDocs);
  app.get('/docs/', sendDocs);
  app.get('/docs/docs.css', async (_request, reply) => {
    return reply.type('text/css; charset=utf-8').send(css);
  });
  app.get('/docs/cookbook.md', async (_request, reply) => {
    return reply.type('text/markdown; charset=utf-8').send(cookbook);
  });
  app.get('/v1/openapi.yaml', async (_request, reply) => {
    return reply.type('application/yaml; charset=utf-8').send(openapiYaml);
  });
};

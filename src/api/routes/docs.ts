import { readFileSync } from 'node:fs';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { rewriteDocsBaseUrl } from '../../config.js';
import { renderCookbookMarkdown, renderDocsHtml } from '../docsPage.js';
import { loadOpenApi, loadOpenApiYaml, resolveAsset } from '../openapi.js';

export const docsRoutes: FastifyPluginAsync = async (app) => {
  const spec = loadOpenApi();
  const html = renderDocsHtml(spec, app.config);
  const cookbook = renderCookbookMarkdown(spec, { baseUrl: app.config.apiBaseUrl });
  const openapiYaml = rewriteDocsBaseUrl(loadOpenApiYaml(), app.config.apiBaseUrl);
  const css = readFileSync(resolveAsset('public/docs/docs.css'), 'utf8');
  const mark = readFileSync(resolveAsset('public/docs/xi.svg'));
  const favicon = readFileSync(resolveAsset('public/docs/favicon.svg'));

  const sendDocs = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('text/html; charset=utf-8').send(html);
  };
  const sendMark = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('image/svg+xml; charset=utf-8').send(mark);
  };
  const sendFavicon = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('image/svg+xml; charset=utf-8').send(favicon);
  };

  app.get('/', sendDocs);
  app.get('/docs', sendDocs);
  app.get('/docs/', sendDocs);
  app.get('/docs/docs.css', async (_request, reply) => {
    return reply.type('text/css; charset=utf-8').send(css);
  });
  app.get('/docs/xi.svg', sendMark);
  app.get('/docs/favicon.svg', sendFavicon);
  app.get('/favicon.svg', sendFavicon);
  app.get('/docs/cookbook.md', async (_request, reply) => {
    return reply.type('text/markdown; charset=utf-8').send(cookbook);
  });
  app.get('/v1/openapi.yaml', async (_request, reply) => {
    return reply.type('application/yaml; charset=utf-8').send(openapiYaml);
  });
};

import type { FastifyPluginAsync } from 'fastify';

import { resolveWsMaxPerIp } from '../../config.js';
import { rateLimited } from '../errors.js';
import { isStreamName, type HubClient, type StreamName } from '../hub.js';
import { createWsConnectionTracker } from '../wsLimit.js';

interface SubscribeMessage {
  command?: unknown;
  streams?: unknown;
}

function parseStreams(value: unknown): StreamName[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: StreamName[] = [];
  for (const item of value) {
    if (typeof item === 'string' && isStreamName(item) && !out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

export const subscribeRoutes: FastifyPluginAsync = async (app) => {
  const maxPerIp = resolveWsMaxPerIp(app.config);
  const tracker = createWsConnectionTracker();

  app.get(
    '/v1/subscribe',
    {
      websocket: true,
      ...(maxPerIp === null
        ? {}
        : {
            preHandler: async (request) => {
              if (!tracker.tryAcquire(request.ip, maxPerIp)) {
                throw rateLimited('Too many websocket connections');
              }
              request.raw.once('close', () => {
                tracker.release(request.ip);
              });
            },
          }),
    },
    (socket) => {
      const client: HubClient = {
        streams: new Set(),
        send: (payload) => {
          socket.send(JSON.stringify(payload));
        },
      };
      app.hub.add(client);

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let parsed: SubscribeMessage;
        try {
          parsed = JSON.parse(String(raw)) as SubscribeMessage;
        } catch {
          client.send({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } });
          return;
        }
        const streams = parseStreams(parsed.streams);
        if (parsed.command === 'subscribe') {
          for (const stream of streams) {
            client.streams.add(stream);
          }
          client.send({ type: 'subscribed', streams: [...client.streams] });
          return;
        }
        if (parsed.command === 'unsubscribe') {
          for (const stream of streams) {
            client.streams.delete(stream);
          }
          client.send({ type: 'unsubscribed', streams: [...client.streams] });
          return;
        }
        client.send({ error: { code: 'BAD_REQUEST', message: 'Unknown command' } });
      });

      socket.on('close', () => {
        app.hub.remove(client);
      });
    },
  );
};

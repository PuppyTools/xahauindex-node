export const STREAMS = ['tokens', 'uritokens', 'prices', 'hooks'] as const;

export type StreamName = (typeof STREAMS)[number];

export interface HubEvent {
  stream: StreamName;
  event: string;
  data: unknown;
  ledger_index: number;
}

export interface HubClient {
  streams: Set<StreamName>;
  send: (payload: unknown) => void;
}

export interface EventHub {
  add(client: HubClient): void;
  remove(client: HubClient): void;
  publish(event: HubEvent): void;
}

export function isStreamName(value: string): value is StreamName {
  return (STREAMS as readonly string[]).includes(value);
}

export function createHub(): EventHub {
  const clients = new Set<HubClient>();
  return {
    add: (client) => {
      clients.add(client);
    },
    remove: (client) => {
      clients.delete(client);
    },
    publish: (event) => {
      for (const client of clients) {
        if (client.streams.has(event.stream)) {
          client.send(event);
        }
      }
    },
  };
}

import type { SqliteDatabase } from '../db/client.js';
import { getLatestLedgerIndex } from '../db/queries/indexer.js';
import {
  listUriTokensDueForMeta,
  markUriTokenMetaChecked,
  updateUriTokenIcon,
} from '../db/queries/uritokens.js';
import { extractIconUrlFromMetadata, normalizeIconUrl, uriLooksLikeImage } from '../util/icon.js';
import { fetchPublicHttpsText } from '../util/domain.js';
import { sleep } from '../util/retry.js';
import type { LiveLogger } from './live.js';

export const URI_META_RECHECK_LEDGERS = 1000;
const META_MAX_BYTES = 64_000;

export type MetadataLoader = (url: string) => Promise<{ text: string; contentType: string }>;

function defaultLoader(url: string): Promise<{ text: string; contentType: string }> {
  return fetchPublicHttpsText(url, {
    maxBytes: META_MAX_BYTES,
    accept: 'application/json, application/ld+json, text/plain, */*',
  });
}

export function resolveUriTokenIcon(uri: string | null, loaderResult?: { text: string; contentType: string }): string | null {
  const source = normalizeIconUrl(uri);
  if (!source) {
    return null;
  }
  if (uriLooksLikeImage(source)) {
    return source;
  }
  if (!loaderResult) {
    return null;
  }
  if (loaderResult.contentType.toLowerCase().startsWith('image/')) {
    return source;
  }
  const trimmed = loaderResult.text.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return extractIconUrlFromMetadata(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

export async function refreshUriTokenIcon(options: {
  db: SqliteDatabase;
  id: string;
  uri: string | null;
  iconUrl: string | null;
  ledger: number;
  loader?: MetadataLoader;
  log: Pick<LiveLogger, 'warn' | 'info'>;
}): Promise<string | null> {
  const existing = normalizeIconUrl(options.iconUrl);
  if (existing) {
    markUriTokenMetaChecked(options.db, options.id, options.ledger);
    return existing;
  }
  const uri = normalizeIconUrl(options.uri);
  let icon = resolveUriTokenIcon(uri);
  if (icon === null && uri !== null && uri.startsWith('https://')) {
    const loader = options.loader ?? defaultLoader;
    try {
      const fetched = await loader(uri);
      icon = resolveUriTokenIcon(uri, fetched);
    } catch (error) {
      options.log.warn({ err: error, id: options.id, uri }, 'URI metadata fetch failed');
    }
  }
  if (icon) {
    updateUriTokenIcon(options.db, options.id, icon);
    options.log.info({ id: options.id, icon }, 'stored URIToken icon URL');
  }
  markUriTokenMetaChecked(options.db, options.id, options.ledger);
  return icon;
}

export async function runUriMetaPass(options: {
  db: SqliteDatabase;
  ledger: number;
  loader?: MetadataLoader;
  log: Pick<LiveLogger, 'warn' | 'info'>;
  interval?: number;
  signal?: AbortSignal;
}): Promise<number> {
  const due = listUriTokensDueForMeta(
    options.db,
    options.ledger,
    options.interval ?? URI_META_RECHECK_LEDGERS,
  );
  let stored = 0;
  for (const row of due) {
    if (options.signal?.aborted) {
      break;
    }
    const icon = await refreshUriTokenIcon({
      db: options.db,
      id: row.id,
      uri: row.uri,
      iconUrl: row.icon_url,
      ledger: options.ledger,
      log: options.log,
      ...(options.loader === undefined ? {} : { loader: options.loader }),
    });
    if (icon) {
      stored += 1;
    }
  }
  return stored;
}

export async function runUriMetaWorker(options: {
  db: SqliteDatabase;
  log: LiveLogger;
  loader?: MetadataLoader;
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<void> {
  const pollMs = options.pollMs ?? 2_000;
  while (options.signal === undefined || !options.signal.aborted) {
    try {
      await runUriMetaPass({
        db: options.db,
        ledger: getLatestLedgerIndex(options.db),
        log: options.log,
        ...(options.loader === undefined ? {} : { loader: options.loader }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      options.log.warn({ err: error }, 'URI metadata pass failed');
    }
    if (options.signal?.aborted) {
      return;
    }
    if (options.signal === undefined) {
      await sleep(pollMs);
      continue;
    }
    try {
      await sleep(pollMs, options.signal);
    } catch {
      return;
    }
  }
}

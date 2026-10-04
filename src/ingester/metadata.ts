import type { SqliteDatabase } from '../db/client.js';
import { getLatestLedgerIndex } from '../db/queries/indexer.js';
import {
  listUriTokensDueForMeta,
  markUriTokenMetaChecked,
  updateUriTokenIcon,
  updateUriTokenMetadata,
} from '../db/queries/uritokens.js';
import {
  extractIconUrlFromMetadata,
  metadataFromRow,
  normalizeIconUrl,
  parseUriMetadataJson,
  uriLooksLikeImage,
} from '../util/icon.js';
import { fetchPublicHttpsText } from '../util/domain.js';
import { sleep } from '../util/retry.js';
import type { LiveLogger } from './live.js';

export const URI_META_RECHECK_LEDGERS = 1000;
const META_MAX_BYTES = 64_000;

export type MetadataLoader = (url: string) => Promise<{ text: string; contentType: string }>;

export interface UriMetaRefreshResult {
  icon: string | null;
  metadata: unknown | null;
}

function defaultLoader(url: string): Promise<{ text: string; contentType: string }> {
  return fetchPublicHttpsText(url, {
    maxBytes: META_MAX_BYTES,
    accept: 'application/json, application/ld+json, text/plain, */*',
  });
}

export function resolveUriTokenIcon(
  uri: string | null,
  loaderResult?: { text: string; contentType: string },
): string | null {
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
  const parsed = parseUriMetadataJson(loaderResult.text);
  return parsed === null ? null : extractIconUrlFromMetadata(parsed);
}

export async function refreshUriTokenMetadata(options: {
  db: SqliteDatabase;
  id: string;
  uri: string | null;
  iconUrl: string | null;
  metadata?: string | null;
  ledger: number;
  loader?: MetadataLoader;
  log: Pick<LiveLogger, 'warn' | 'info'>;
}): Promise<UriMetaRefreshResult> {
  const existingIcon = normalizeIconUrl(options.iconUrl);
  const existingMeta = metadataFromRow(options.metadata ?? null);
  const uri = normalizeIconUrl(options.uri);
  if (uri === null || uriLooksLikeImage(uri) || !uri.startsWith('https://')) {
    const icon = existingIcon ?? resolveUriTokenIcon(uri);
    if (icon && !existingIcon) {
      updateUriTokenIcon(options.db, options.id, icon);
    }
    markUriTokenMetaChecked(options.db, options.id, options.ledger);
    return { icon: icon ?? existingIcon, metadata: existingMeta };
  }

  const loader = options.loader ?? defaultLoader;
  let fetched: { text: string; contentType: string } | undefined;
  try {
    fetched = await loader(uri);
  } catch (error) {
    options.log.warn({ err: error, id: options.id, uri }, 'URI metadata fetch failed');
    markUriTokenMetaChecked(options.db, options.id, options.ledger);
    return { icon: existingIcon, metadata: existingMeta };
  }

  const metadata = fetched.contentType.toLowerCase().startsWith('image/')
    ? null
    : parseUriMetadataJson(fetched.text);
  if (metadata !== null) {
    updateUriTokenMetadata(options.db, options.id, JSON.stringify(metadata));
    options.log.info({ id: options.id }, 'stored URIToken metadata JSON');
  }

  const icon = existingIcon ?? resolveUriTokenIcon(uri, fetched);
  if (icon && !existingIcon) {
    updateUriTokenIcon(options.db, options.id, icon);
    options.log.info({ id: options.id, icon }, 'stored URIToken icon URL');
  }
  markUriTokenMetaChecked(options.db, options.id, options.ledger);
  return { icon: icon ?? existingIcon, metadata: metadata ?? existingMeta };
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
    const result = await refreshUriTokenMetadata({
      db: options.db,
      id: row.id,
      uri: row.uri,
      iconUrl: row.icon_url,
      metadata: row.uri_metadata,
      ledger: options.ledger,
      log: options.log,
      ...(options.loader === undefined ? {} : { loader: options.loader }),
    });
    if (result.metadata !== null || result.icon !== null) {
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

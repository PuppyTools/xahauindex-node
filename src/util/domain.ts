import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface TomlAccount {
  address?: string;
  name?: string;
  desc?: string;
  icon?: string;
}

export interface XrpLedgerToml {
  accounts: TomlAccount[];
  metadata: {
    name?: string;
    description?: string;
    icon?: string;
  };
}

const TOML_MAX_BYTES = 256_000;
const TOML_TIMEOUT_MS = 10_000;

function isPrivateIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') {
    return true;
  }
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10 || a === 127) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const HEX_BLOB_RE = /^[0-9a-f]{32,}$/i;

export function tomlHostFromDomain(domain: string): string {
  return domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function isFetchableTomlDomain(domain: string): boolean {
  const host = tomlHostFromDomain(domain).toLowerCase();
  if (host.length < 4 || host.length > 253 || HEX_BLOB_RE.test(host)) {
    return false;
  }
  return HOSTNAME_RE.test(host);
}

export function isExpectedTomlFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text = `${name} ${code} ${message} ${cause}`;
  return /AbortError|ABORT_ERR|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|cert(ificate)?|altnames|self-signed|unrecognized name|TLS|HTTP 40[134]|HTTP 404|HTTP 410|aborted|timeout/i.test(
    text,
  );
}

export function assertSafeTomlHost(hostname: string): void {
  const host = hostname.trim().toLowerCase();
  if (host === '' || host === 'localhost' || isPrivateIp(host) || !isFetchableTomlDomain(host)) {
    throw new Error(`Refusing TOML host ${hostname}`);
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function assignMetadata(
  target: XrpLedgerToml['metadata'],
  key: string,
  value: string,
): void {
  if (key === 'name') {
    target.name = value;
  } else if (key === 'desc' || key === 'description') {
    target.description = value;
  } else if (key === 'icon' || key === 'icon_url') {
    target.icon = value;
  }
}

export function parseXrpLedgerToml(text: string): XrpLedgerToml {
  const toml: XrpLedgerToml = { accounts: [], metadata: {} };
  let section = '';
  let currentAccount: TomlAccount | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const table = line.match(/^\[\[([A-Za-z0-9_]+)\]\]$/);
    if (table?.[1]) {
      section = table[1].toUpperCase();
      if (section === 'ACCOUNTS') {
        currentAccount = {};
        toml.accounts.push(currentAccount);
      } else {
        currentAccount = undefined;
      }
      continue;
    }
    const single = line.match(/^\[([A-Za-z0-9_]+)\]$/);
    if (single?.[1]) {
      section = single[1].toUpperCase();
      currentAccount = undefined;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv?.[1] || kv[2] === undefined) {
      continue;
    }
    const key = kv[1].toLowerCase();
    const value = unquote(kv[2]);
    if (section === 'ACCOUNTS' && currentAccount) {
      if (key === 'address') {
        currentAccount.address = value;
      } else if (key === 'name') {
        currentAccount.name = value;
      } else if (key === 'desc' || key === 'description') {
        currentAccount.desc = value;
      } else if (key === 'icon' || key === 'icon_url') {
        currentAccount.icon = value;
      }
      continue;
    }
    if (section === 'METADATA') {
      assignMetadata(toml.metadata, key, value);
    }
  }
  return toml;
}

export function isAccountListed(toml: XrpLedgerToml, account: string): boolean {
  return toml.accounts.some(
    (entry) => entry.address !== undefined && entry.address.toLowerCase() === account.toLowerCase(),
  );
}

export function pickTomlProfile(
  toml: XrpLedgerToml,
  account: string,
): { name?: string; description?: string; icon?: string } {
  const entry = toml.accounts.find(
    (item) => item.address !== undefined && item.address.toLowerCase() === account.toLowerCase(),
  );
  const name = entry?.name ?? toml.metadata.name;
  const description = entry?.desc ?? toml.metadata.description;
  const icon = entry?.icon ?? toml.metadata.icon;
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
  };
}

export async function fetchPublicHttpsText(
  url: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ text: string; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only https URLs can be fetched');
  }
  assertSafeTomlHost(parsed.hostname);
  const resolved = await lookup(parsed.hostname, { all: true });
  if (resolved.some((record) => isPrivateIp(record.address))) {
    throw new Error(`Host ${parsed.hostname} resolved to a private address`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? TOML_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: options.accept ?? '*/*' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().startsWith('image/')) {
      return { text: '', contentType };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > (options.maxBytes ?? TOML_MAX_BYTES)) {
      throw new Error('Response too large');
    }
    return { text: buffer.toString('utf8'), contentType };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchXrpLedgerToml(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const host = tomlHostFromDomain(domain);
  if (!isFetchableTomlDomain(host)) {
    throw new Error(`Refusing TOML host ${host}`);
  }
  try {
    const fetched = await fetchPublicHttpsText(`https://${host}/.well-known/xrp-ledger.toml`, {
      maxBytes: TOML_MAX_BYTES,
      timeoutMs: TOML_TIMEOUT_MS,
      accept: 'text/plain, application/toml, */*',
      fetchImpl,
    });
    return fetched.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('HTTP ')) {
      throw new Error(`TOML ${message}`, { cause: error });
    }
    if (message.startsWith('Host ')) {
      throw new Error(`TOML host ${message.slice('Host '.length)}`, { cause: error });
    }
    throw error;
  }
}

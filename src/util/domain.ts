import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface TomlAccount {
  address?: string;
  name?: string;
  desc?: string;
  icon?: string;
}

export interface TomlToken {
  issuer?: string;
  name?: string;
  desc?: string;
  icon?: string;
}

export interface TomlLink {
  url: string;
  type: string | null;
  title: string | null;
}

interface TomlLinkDraft {
  url?: string;
  type?: string;
  title?: string;
}

export interface XrpLedgerToml {
  accounts: TomlAccount[];
  issuers: TomlAccount[];
  tokens: TomlToken[];
  weblinks: TomlLinkDraft[];
  organization: {
    website?: string;
    twitter?: string;
  };
  metadata: {
    name?: string;
    description?: string;
    icon?: string;
  };
}

const LINK_TABLES = new Set(['WEBLINKS', 'TOKENS.WEBLINKS', 'TOKENS.URLS']);
const TOML_LINK_LIMIT = 20;

export const TOML_USER_AGENT = 'XahauIndex/1.0 (+https://github.com/PuppyTools/xahauindex-node)';

const TOML_MAX_BYTES = 256_000;
const TOML_TIMEOUT_MS = 10_000;
const TOML_MAX_REDIRECTS = 2;

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

function assignAccountField(target: TomlAccount, key: string, value: string): void {
  if (key === 'address') {
    target.address = value;
  } else if (key === 'name') {
    target.name = value;
  } else if (key === 'desc' || key === 'description') {
    target.desc = value;
  } else if (key === 'icon' || key === 'icon_url') {
    target.icon = value;
  }
}

function assignTokenField(target: TomlToken, key: string, value: string): void {
  if (key === 'issuer') {
    target.issuer = value;
  } else if (key === 'name') {
    target.name = value;
  } else if (key === 'desc' || key === 'description') {
    target.desc = value;
  } else if (key === 'icon' || key === 'icon_url') {
    target.icon = value;
  }
}

function assignLinkField(target: TomlLinkDraft, key: string, value: string): void {
  if (key === 'url' || key === 'uri' || key === 'href') {
    target.url = value;
  } else if (key === 'type' || key === 'kind') {
    target.type = value;
  } else if (key === 'title' || key === 'name') {
    target.title = value;
  }
}

function assignOrganizationField(
  target: XrpLedgerToml['organization'],
  key: string,
  value: string,
): void {
  if (key === 'website' || key === 'url') {
    target.website = value;
  } else if (key === 'twitter' || key === 'x') {
    target.twitter = value;
  }
}

export function parseXrpLedgerToml(text: string): XrpLedgerToml {
  const toml: XrpLedgerToml = {
    accounts: [],
    issuers: [],
    tokens: [],
    weblinks: [],
    organization: {},
    metadata: {},
  };
  let section = '';
  let currentAccount: TomlAccount | undefined;
  let currentToken: TomlToken | undefined;
  let currentLink: TomlLinkDraft | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const table = line.match(/^\[\[([A-Za-z0-9_.]+)\]\]$/);
    if (table?.[1]) {
      section = table[1].toUpperCase();
      currentAccount = undefined;
      currentToken = undefined;
      currentLink = undefined;
      if (section === 'ACCOUNTS') {
        currentAccount = {};
        toml.accounts.push(currentAccount);
      } else if (section === 'ISSUERS') {
        currentAccount = {};
        toml.issuers.push(currentAccount);
      } else if (section === 'TOKENS') {
        currentToken = {};
        toml.tokens.push(currentToken);
      } else if (LINK_TABLES.has(section)) {
        currentLink = {};
        toml.weblinks.push(currentLink);
      }
      continue;
    }
    const single = line.match(/^\[([A-Za-z0-9_.]+)\]$/);
    if (single?.[1]) {
      section = single[1].toUpperCase();
      currentAccount = undefined;
      currentToken = undefined;
      currentLink = undefined;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv?.[1] || kv[2] === undefined) {
      continue;
    }
    const key = kv[1].toLowerCase();
    const value = unquote(kv[2]);
    if ((section === 'ACCOUNTS' || section === 'ISSUERS') && currentAccount) {
      assignAccountField(currentAccount, key, value);
      continue;
    }
    if (section === 'TOKENS' && currentToken) {
      assignTokenField(currentToken, key, value);
      continue;
    }
    if (LINK_TABLES.has(section) && currentLink) {
      assignLinkField(currentLink, key, value);
      continue;
    }
    if (section === 'ORGANIZATION') {
      assignOrganizationField(toml.organization, key, value);
      continue;
    }
    if (section === 'METADATA') {
      assignMetadata(toml.metadata, key, value);
    }
  }
  return toml;
}

function addressMatches(value: string | undefined, account: string): boolean {
  return value !== undefined && value.toLowerCase() === account.toLowerCase();
}

export function isAccountListed(toml: XrpLedgerToml, account: string): boolean {
  return (
    toml.accounts.some((entry) => addressMatches(entry.address, account)) ||
    toml.issuers.some((entry) => addressMatches(entry.address, account)) ||
    toml.tokens.some((entry) => addressMatches(entry.issuer, account))
  );
}

export function pickTomlProfile(
  toml: XrpLedgerToml,
  account: string,
): { name?: string; description?: string; icon?: string } {
  const entry =
    toml.issuers.find((item) => addressMatches(item.address, account)) ??
    toml.accounts.find((item) => addressMatches(item.address, account));
  const token = toml.tokens.find((item) => addressMatches(item.issuer, account));
  const name = entry?.name ?? token?.name ?? toml.metadata.name;
  const description = entry?.desc ?? token?.desc ?? toml.metadata.description;
  const icon = entry?.icon ?? token?.icon ?? toml.metadata.icon;
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
  };
}

export function normalizePublicUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = raw.trim();
  if (value === '') {
    return null;
  }
  const lowered = value.toLowerCase();
  if (lowered.startsWith('data:') || lowered.startsWith('javascript:') || lowered.startsWith('file:')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  return value;
}

export function normalizeTomlLinkType(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return null;
  }
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (compact === 'socialmedia' || compact === 'social' || compact === 'twitter' || compact === 'x') {
    return 'social';
  }
  if (compact === 'website' || compact === 'homepage' || compact === 'url') {
    return 'website';
  }
  return raw.trim().toLowerCase();
}

function twitterUrl(raw: string): string | null {
  const fromUrl = normalizePublicUrl(raw);
  if (fromUrl) {
    return fromUrl;
  }
  const handle = raw
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '')
    .split(/[/?#]/)[0];
  if (handle === undefined || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return null;
  }
  return `https://x.com/${handle}`;
}

function pushTomlLink(links: TomlLink[], seen: Set<string>, draft: TomlLinkDraft): void {
  const url = normalizePublicUrl(draft.url);
  if (!url) {
    return;
  }
  const key = url.toLowerCase();
  if (seen.has(key) || links.length >= TOML_LINK_LIMIT) {
    return;
  }
  seen.add(key);
  const title = draft.title?.trim();
  links.push({
    url,
    type: normalizeTomlLinkType(draft.type),
    title: title === undefined || title === '' ? null : title,
  });
}

export function pickTomlLinks(toml: XrpLedgerToml): TomlLink[] {
  const links: TomlLink[] = [];
  const seen = new Set<string>();
  for (const draft of toml.weblinks) {
    pushTomlLink(links, seen, draft);
  }
  if (toml.organization.website) {
    pushTomlLink(links, seen, { url: toml.organization.website, type: 'website', title: 'Website' });
  }
  if (toml.organization.twitter) {
    const url = twitterUrl(toml.organization.twitter);
    if (url) {
      pushTomlLink(links, seen, { url, type: 'social', title: 'Twitter' });
    }
  }
  return links;
}

export function serializeTomlLinks(links: TomlLink[]): string | null {
  return links.length === 0 ? null : JSON.stringify(links);
}

export function parseStoredTomlLinks(raw: string | null | undefined): TomlLink[] {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const links: TomlLink[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || !('url' in item)) {
        continue;
      }
      const record = item as { url: unknown; type?: unknown; title?: unknown };
      const url = normalizePublicUrl(typeof record.url === 'string' ? record.url : null);
      if (!url) {
        continue;
      }
      links.push({
        url,
        type: typeof record.type === 'string' ? normalizeTomlLinkType(record.type) : null,
        title: typeof record.title === 'string' && record.title.trim() !== '' ? record.title.trim() : null,
      });
    }
    return links;
  } catch {
    return [];
  }
}

export function websiteFromTomlLinks(links: TomlLink[]): string | null {
  return links.find((link) => link.type === 'website')?.url ?? links[0]?.url ?? null;
}

export async function fetchPublicHttpsText(
  url: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
    fetchImpl?: typeof fetch;
    redirectsLeft?: number;
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
      redirect: 'manual',
      headers: {
        accept: options.accept ?? '*/*',
        'user-agent': TOML_USER_AGENT,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const redirectsLeft = options.redirectsLeft ?? TOML_MAX_REDIRECTS;
      if (!location || redirectsLeft <= 0) {
        throw new Error(`HTTP ${response.status}`);
      }
      await response.body?.cancel();
      return fetchPublicHttpsText(new URL(location, url).toString(), {
        ...options,
        redirectsLeft: redirectsLeft - 1,
      });
    }
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

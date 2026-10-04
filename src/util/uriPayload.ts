import { normalizeIconUrl, parseUriMetadataJson, uriLooksLikeImage } from './icon.js';
import { hexToUtf8 } from './xahau.js';
import { xflToString } from './xfl.js';

export const URI_KINDS = ['https', 'ipfs', 'image', 'onchain', 'empty'] as const;
export type UriKind = (typeof URI_KINDS)[number];

const EVRLEASE_PREFIX = Buffer.from('evrlease');
const EVRHOST_PREFIX = Buffer.from('evrhost');
const LTV_PREFIX = Buffer.from('LTV');

export interface OnchainUriMetadata {
  source: 'onchain';
  format: 'evrlease' | 'evrhost' | 'json' | 'text' | 'bytes';
  encoding?: 'base64' | 'hex' | 'utf8';
  hex?: string;
  text?: string;
  name?: string;
  description?: string;
  version?: string | null;
  lease_index?: number;
  lease_amount?: string;
  half_tos?: string;
  identifier?: number | null;
  outbound_ip?: string | null;
  document?: unknown;
}

export function classifyUri(uri: string | null | undefined): UriKind {
  if (uri === undefined || uri === null || uri.trim() === '') {
    return 'empty';
  }
  const trimmed = uri.trim();
  const asUrl = normalizeIconUrl(trimmed);
  if (asUrl?.startsWith('ipfs://')) {
    return 'ipfs';
  }
  if (asUrl && uriLooksLikeImage(asUrl)) {
    return 'image';
  }
  if (asUrl?.startsWith('https://') || asUrl?.startsWith('http://')) {
    return 'https';
  }
  return 'onchain';
}

function tryHexToBuffer(raw: string): Buffer | null {
  const hex = raw.trim();
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  return Buffer.from(hex, 'hex');
}

function innerLeaseBuffer(uri: string | null, uriRaw: string): Buffer | null {
  const candidates: Buffer[] = [];
  const rawBuf = tryHexToBuffer(uriRaw);
  if (rawBuf) {
    const asAscii = rawBuf.toString('utf8').replace(/\0/g, '');
    if (/^[A-Za-z0-9+/]+=*$/.test(asAscii) && asAscii.length >= 16) {
      candidates.push(Buffer.from(asAscii, 'base64'));
    }
    candidates.push(rawBuf);
  }
  if (uri && uri.trim() !== '') {
    const trimmed = uri.trim();
    if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length >= 16) {
      candidates.push(Buffer.from(trimmed, 'base64'));
    }
    const uriHex = tryHexToBuffer(trimmed);
    if (uriHex) {
      candidates.push(uriHex);
    }
  }
  for (const buf of candidates) {
    if (buf.length >= EVRLEASE_PREFIX.length && buf.subarray(0, EVRLEASE_PREFIX.length).equals(EVRLEASE_PREFIX)) {
      return buf;
    }
    if (buf.length >= EVRHOST_PREFIX.length && buf.subarray(0, EVRHOST_PREFIX.length).equals(EVRHOST_PREFIX)) {
      return buf;
    }
  }
  return null;
}

function decodeEvrLease(buf: Buffer): OnchainUriMetadata | null {
  const prefixLen = EVRLEASE_PREFIX.length;
  const versioned = buf.length >= prefixLen + LTV_PREFIX.length && buf.subarray(prefixLen, prefixLen + LTV_PREFIX.length).equals(LTV_PREFIX);
  const versionPrefixLen = LTV_PREFIX.length;
  const versionLen = versioned ? versionPrefixLen + 2 : 0;
  const indexLen = 2;
  const halfTosLen = 16;
  const amountLen = 8;
  const identifierLen = 4;
  const halfTosOffset = prefixLen + versionLen + indexLen;
  const amountOffset = halfTosOffset + halfTosLen;
  const identifierOffset = amountOffset + amountLen;
  const ipOffset = identifierOffset + identifierLen;
  if (buf.length < amountOffset + amountLen) {
    return null;
  }

  let version: string | null = null;
  if (versioned) {
    version = `${buf.subarray(prefixLen, prefixLen + versionPrefixLen).toString('utf8')}${buf.readUInt16BE(prefixLen + versionPrefixLen)}`;
  }
  const leaseIndex = buf.readUInt16BE(prefixLen + versionLen);
  let leaseAmount: string | undefined;
  try {
    leaseAmount = xflToString(buf.readBigInt64BE(amountOffset));
  } catch {
    leaseAmount = undefined;
  }
  const identifier = buf.length >= identifierOffset + identifierLen ? buf.readUInt32BE(identifierOffset) : null;
  let outboundIp: string | null = null;
  if (buf.length > ipOffset && buf.readUInt8(ipOffset) === 6) {
    outboundIp = buf
      .subarray(ipOffset + 1, ipOffset + 17)
      .toString('hex')
      .toUpperCase()
      .replace(/(.{4})(?!$)/g, '$1:');
  }

  return {
    source: 'onchain',
    format: 'evrlease',
    encoding: 'base64',
    hex: buf.toString('hex'),
    name: `Evernode lease #${leaseIndex}`,
    description: 'Evernode host lease packed into the URIToken URI',
    version,
    lease_index: leaseIndex,
    ...(leaseAmount === undefined ? {} : { lease_amount: leaseAmount }),
    half_tos: buf.subarray(halfTosOffset, halfTosOffset + halfTosLen).toString('hex'),
    identifier,
    outbound_ip: outboundIp,
  };
}

function printableAscii(value: string): string {
  return value.replace(/[^\u0020-\u007E]/g, '').trim();
}

export function decodeOnchainUriMetadata(uri: string | null, uriRaw: string): OnchainUriMetadata | null {
  const kind = classifyUri(uri);
  if (kind !== 'onchain') {
    return null;
  }

  const json = parseUriMetadataJson(uri ?? '');
  if (json !== null) {
    return {
      source: 'onchain',
      format: 'json',
      encoding: 'utf8',
      text: uri?.trim() ?? '',
      document: json,
    };
  }

  const inner = innerLeaseBuffer(uri, uriRaw);
  if (inner?.subarray(0, EVRLEASE_PREFIX.length).equals(EVRLEASE_PREFIX)) {
    return decodeEvrLease(inner);
  }
  if (inner?.subarray(0, EVRHOST_PREFIX.length).equals(EVRHOST_PREFIX)) {
    return {
      source: 'onchain',
      format: 'evrhost',
      encoding: 'hex',
      hex: inner.toString('hex'),
      name: 'Evernode host token',
      description: 'Evernode host registration URI packed into the URIToken URI',
      text: printableAscii(inner.toString('utf8')),
    };
  }

  const fromRaw = tryHexToBuffer(uriRaw);
  const text = uri ?? (fromRaw ? hexToUtf8(uriRaw) : '');
  const printable = printableAscii(text);
  if (printable.length >= 2 && printable.length === text.replace(/\0/g, '').length) {
    return {
      source: 'onchain',
      format: 'text',
      encoding: 'utf8',
      text: printable,
      ...(fromRaw ? { hex: fromRaw.toString('hex') } : {}),
    };
  }
  if (fromRaw || (uri && uri.length > 0)) {
    return {
      source: 'onchain',
      format: 'bytes',
      encoding: fromRaw ? 'hex' : 'utf8',
      ...(fromRaw ? { hex: fromRaw.toString('hex') } : {}),
      ...(printable === '' ? {} : { text: printable }),
    };
  }
  return null;
}

export function resolveUriTokenMetadata(
  uri: string | null,
  uriRaw: string,
  storedMetadata: unknown | null,
): unknown | null {
  if (storedMetadata !== null) {
    return storedMetadata;
  }
  return decodeOnchainUriMetadata(uri, uriRaw);
}

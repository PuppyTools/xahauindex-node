import type { LedgerRemark } from '../types/xahau.js';
import { hexToUtf8 } from '../util/xahau.js';

export interface DecodedRemark {
  name: string;
  value: string;
  immutable: boolean;
  deleted: boolean;
}

export interface DisplayFields {
  name?: string;
  description?: string;
  iconUrl?: string;
  websiteUrl?: string;
}

const IMMUTABLE_FLAG = 1;

function tryParseJson(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return value;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown);
  } catch {
    return value;
  }
}

export function decodeRemarkBlob(hexOrText: string): string {
  if (/^[0-9a-fA-F]+$/.test(hexOrText) && hexOrText.length % 2 === 0) {
    const decoded = hexToUtf8(hexOrText);
    return decoded === '' ? hexOrText : decoded;
  }
  return hexOrText;
}

export function decodeRemarkValue(hexOrText: string): string {
  return tryParseJson(decodeRemarkBlob(hexOrText));
}

export function parseRemarkEntry(entry: LedgerRemark | unknown): DecodedRemark | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const inner =
    'Remark' in entry && typeof entry.Remark === 'object' && entry.Remark !== null
      ? entry.Remark
      : entry;
  if (typeof inner !== 'object' || inner === null || !('RemarkName' in inner)) {
    return null;
  }
  const record = inner as { RemarkName?: unknown; RemarkValue?: unknown; Flags?: unknown };
  if (typeof record.RemarkName !== 'string' || record.RemarkName === '') {
    return null;
  }
  const name = decodeRemarkBlob(record.RemarkName);
  if (name === '') {
    return null;
  }
  const flags = typeof record.Flags === 'number' ? record.Flags : 0;
  if (record.RemarkValue === undefined || record.RemarkValue === null) {
    return { name, value: '', immutable: (flags & IMMUTABLE_FLAG) !== 0, deleted: true };
  }
  if (typeof record.RemarkValue !== 'string') {
    return null;
  }
  return {
    name,
    value: decodeRemarkValue(record.RemarkValue),
    immutable: (flags & IMMUTABLE_FLAG) !== 0,
    deleted: false,
  };
}

export function parseRemarkArray(remarks: unknown): DecodedRemark[] {
  if (!Array.isArray(remarks)) {
    return [];
  }
  const out: DecodedRemark[] = [];
  for (const entry of remarks) {
    const decoded = parseRemarkEntry(entry);
    if (decoded) {
      out.push(decoded);
    }
  }
  return out;
}

export function remarksToDisplay(remarks: Iterable<{ name: string; value: string }>): DisplayFields {
  const fields: DisplayFields = {};
  for (const remark of remarks) {
    const key = remark.name.trim().toLowerCase();
    switch (key) {
      case 'name':
      case 'title':
        fields.name = remark.value;
        break;
      case 'description':
      case 'desc':
        fields.description = remark.value;
        break;
      case 'image':
      case 'icon':
      case 'icon_url':
      case 'preview':
        fields.iconUrl = remark.value;
        break;
      case 'website':
      case 'url':
      case 'website_url':
        fields.websiteUrl = remark.value;
        break;
      default:
        break;
    }
  }
  return fields;
}

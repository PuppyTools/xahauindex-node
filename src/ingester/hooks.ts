import type { HookEntry as ApiHookEntry, HookGrant, HookParameter } from '../types/api.js';
import type { HookFields, HookGrant as LedgerHookGrant, HookParameter as LedgerHookParameter } from '../types/xahau.js';
import { hexToUtf8 } from '../util/xahau.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeMaybeHex(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const decoded = hexToUtf8(value);
  return decoded === '' ? value : decoded;
}

export function hookFieldsOf(entry: unknown): HookFields | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  if (isRecord(entry.Hook)) {
    return entry.Hook as HookFields;
  }
  if (typeof entry.HookHash === 'string' && entry.HookHash !== '') {
    return entry as HookFields;
  }
  return undefined;
}

export function parametersFromUnknown(value: unknown): HookParameter[] {
  if (Array.isArray(value)) {
    return parametersOf({ HookParameters: value as LedgerHookParameter[] });
  }
  if (isRecord(value) && isRecord(value.HookParameter)) {
    return parametersOf({ HookParameters: [value as LedgerHookParameter] });
  }
  return [];
}

function parametersOf(fields: HookFields): HookParameter[] {
  const raw = fields.HookParameters ?? [];
  const out: HookParameter[] = [];
  for (const item of raw as LedgerHookParameter[]) {
    const name = decodeMaybeHex(item.HookParameter?.HookParameterName);
    const value = item.HookParameter?.HookParameterValue;
    out.push({
      ...(name === undefined ? {} : { name }),
      ...(value === undefined ? {} : { value }),
    });
  }
  return out;
}

function grantsOf(fields: HookFields): HookGrant[] {
  const raw = fields.HookGrants ?? [];
  const out: HookGrant[] = [];
  for (const item of raw as LedgerHookGrant[]) {
    out.push({
      ...(item.HookGrant?.Authorize === undefined ? {} : { account: item.HookGrant.Authorize }),
      ...(item.HookGrant?.HookHash === undefined ? {} : { hook_hash: item.HookGrant.HookHash }),
    });
  }
  return out;
}

export function normalizeHookEntries(entries: readonly unknown[]): ApiHookEntry[] {
  const out: ApiHookEntry[] = [];
  for (const entry of entries) {
    const fields = hookFieldsOf(entry);
    const hash = fields?.HookHash;
    if (!fields || !hash) {
      continue;
    }
    const hookName = decodeMaybeHex(fields.HookName);
    out.push({
      hook_hash: hash,
      hook_on: fields.HookOn ?? null,
      hook_on_incoming: fields.HookOnIncoming ?? null,
      hook_on_outgoing: fields.HookOnOutgoing ?? null,
      hook_can_emit: fields.HookCanEmit ?? null,
      hook_namespace: fields.HookNamespace ?? null,
      hook_name: hookName ?? null,
      hook_api_version: fields.HookApiVersion ?? null,
      parameters: parametersOf(fields),
      grants: grantsOf(fields),
    });
  }
  return out;
}

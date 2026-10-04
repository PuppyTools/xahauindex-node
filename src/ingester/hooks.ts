import type { HookEntry as ApiHookEntry, HookGrant, HookParameter } from '../types/api.js';
import type { HookEntry } from '../types/xahau.js';
import { hexToUtf8 } from '../util/xahau.js';

function decodeMaybeHex(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const decoded = hexToUtf8(value);
  return decoded === '' ? value : decoded;
}

function parametersOf(entry: HookEntry): HookParameter[] {
  const raw = entry.Hook?.HookParameters ?? [];
  const out: HookParameter[] = [];
  for (const item of raw) {
    const name = decodeMaybeHex(item.HookParameter?.HookParameterName);
    const value = item.HookParameter?.HookParameterValue;
    out.push({
      ...(name === undefined ? {} : { name }),
      ...(value === undefined ? {} : { value }),
    });
  }
  return out;
}

function grantsOf(entry: HookEntry): HookGrant[] {
  const raw = entry.Hook?.HookGrants ?? [];
  const out: HookGrant[] = [];
  for (const item of raw) {
    out.push({
      ...(item.HookGrant?.Authorize === undefined ? {} : { account: item.HookGrant.Authorize }),
      ...(item.HookGrant?.HookHash === undefined ? {} : { hook_hash: item.HookGrant.HookHash }),
    });
  }
  return out;
}

export function normalizeHookEntries(entries: HookEntry[]): ApiHookEntry[] {
  const out: ApiHookEntry[] = [];
  for (const entry of entries) {
    const hash = entry.Hook?.HookHash;
    if (!hash) {
      continue;
    }
    const hookName = decodeMaybeHex(entry.Hook?.HookName);
    out.push({
      hook_hash: hash,
      hook_on: entry.Hook?.HookOn ?? null,
      hook_on_incoming: entry.Hook?.HookOnIncoming ?? null,
      hook_on_outgoing: entry.Hook?.HookOnOutgoing ?? null,
      hook_namespace: entry.Hook?.HookNamespace ?? null,
      hook_name: hookName ?? null,
      hook_api_version: entry.Hook?.HookApiVersion ?? null,
      parameters: parametersOf(entry),
      grants: grantsOf(entry),
    });
  }
  return out;
}

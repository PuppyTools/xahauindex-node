/** Xahau HookOn bits from https://xahau.network/docs/hooks/concepts/hookon-field/ */
export const SET_HOOK_BIT = 22;

export const XAHAU_TX_TYPES = [
  { name: 'Payment', bit: 0 },
  { name: 'EscrowCreate', bit: 1 },
  { name: 'EscrowFinish', bit: 2 },
  { name: 'AccountSet', bit: 3 },
  { name: 'EscrowCancel', bit: 4 },
  { name: 'SetRegularKey', bit: 5 },
  { name: 'OfferCreate', bit: 7 },
  { name: 'OfferCancel', bit: 8 },
  { name: 'TicketCreate', bit: 10 },
  { name: 'TicketCancel', bit: 11 },
  { name: 'SignerListSet', bit: 12 },
  { name: 'PaymentChannelCreate', bit: 13 },
  { name: 'PaymentChannelFund', bit: 14 },
  { name: 'PaymentChannelClaim', bit: 15 },
  { name: 'CheckCreate', bit: 16 },
  { name: 'CheckCash', bit: 17 },
  { name: 'CheckCancel', bit: 18 },
  { name: 'DepositPreauth', bit: 19 },
  { name: 'TrustSet', bit: 20 },
  { name: 'AccountDelete', bit: 21 },
  { name: 'SetHook', bit: 22 },
  { name: 'URITokenMint', bit: 45 },
  { name: 'URITokenBurn', bit: 46 },
  { name: 'URITokenBuy', bit: 47 },
  { name: 'URITokenCreateSellOffer', bit: 48 },
  { name: 'URITokenCancelSellOffer', bit: 49 },
  { name: 'GenesisMint', bit: 96 },
  { name: 'Import', bit: 97 },
  { name: 'ClaimReward', bit: 98 },
  { name: 'Invoke', bit: 99 },
  { name: 'EnableAmendment', bit: 100 },
  { name: 'SetFee', bit: 101 },
  { name: 'UNLModify', bit: 102 },
  { name: 'EmitFailure', bit: 103 },
  { name: 'UNLReport', bit: 104 },
] as const;

export type HookTriggerMode = 'all_except' | 'only' | 'none';

export interface HookTriggerMask {
  raw: string;
  mode: HookTriggerMode;
  types: string[];
}

function normalizeHookOnHex(hex: string): string | undefined {
  const raw = hex.trim().replace(/^0x/i, '').toUpperCase();
  if (raw === '' || !/^[0-9A-F]+$/.test(raw) || raw.length > 64) {
    return undefined;
  }
  return raw.padStart(64, '0');
}

export function hookOnBitSet(hex: string, bit: number): boolean {
  const padded = normalizeHookOnHex(hex);
  if (padded === undefined || bit < 0 || bit > 255) {
    return false;
  }
  const nibbleIndex = padded.length - 1 - Math.floor(bit / 4);
  const nibble = Number.parseInt(padded[nibbleIndex] ?? '0', 16);
  return ((nibble >> (bit % 4)) & 1) === 1;
}

export function hookOnFiresOn(hex: string, bit: number): boolean {
  const set = hookOnBitSet(hex, bit);
  return bit === SET_HOOK_BIT ? set : !set;
}

export function decodeHookOn(hex: string | null | undefined): HookTriggerMask | null {
  if (hex === undefined || hex === null || hex === '') {
    return null;
  }
  const raw = normalizeHookOnHex(hex);
  if (raw === undefined) {
    return null;
  }
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const item of XAHAU_TX_TYPES) {
    if (hookOnFiresOn(raw, item.bit)) {
      enabled.push(item.name);
    } else {
      disabled.push(item.name);
    }
  }
  if (enabled.length === 0) {
    return { raw, mode: 'none', types: [] };
  }
  if (enabled.length >= disabled.length) {
    return { raw, mode: 'all_except', types: disabled };
  }
  return { raw, mode: 'only', types: enabled };
}

export function hexByteLength(hex: string | undefined): number {
  if (hex === undefined || hex === '') {
    return 0;
  }
  const raw = hex.trim().replace(/^0x/i, '');
  if (raw === '' || raw.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(raw)) {
    return 0;
  }
  return raw.length / 2;
}

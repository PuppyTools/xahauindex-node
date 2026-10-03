import { isValidAddress } from '@transia/xrpl';

import type { Amount, IssuedAmount } from '../types/xahau.js';

export const NATIVE_CURRENCY = 'XAH';

export const LSF_DISABLE_MASTER = 0x00_10_00_00;

export const KNOWN_BLACKHOLE_ADDRESSES = new Set<string>([
  'rrrrrrrrrrrrrrrrrrrrBZbvji',
  'rrrrrrrrrrrrrrrrrrrn5RM1rHd',
  'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
]);

export interface DecodedCurrency {
  currency: string;
  currencyHex: string | null;
}

export interface CurrencySide {
  currency: string;
  issuer: string | null;
}

export interface NormalizedPair {
  base: CurrencySide;
  counter: CurrencySide;
  inverted: boolean;
}

export function hexToUtf8(hex: string): string {
  const normalized = hex.trim();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    return '';
  }
  return Buffer.from(normalized, 'hex').toString('utf8').replace(/\0/g, '');
}

export function decodeCurrency(code: string): DecodedCurrency {
  if (/^[A-Za-z0-9?]{3}$/.test(code)) {
    return { currency: code.toUpperCase(), currencyHex: null };
  }
  if (/^[0-9a-fA-F]{40}$/.test(code)) {
    const decoded = hexToUtf8(code).trim();
    return {
      currency: decoded === '' ? code.toUpperCase() : decoded,
      currencyHex: code.toUpperCase(),
    };
  }
  return { currency: code, currencyHex: null };
}

export function isNativeCurrency(currency: string, issuer: string | null | undefined): boolean {
  return currency.toUpperCase() === NATIVE_CURRENCY && (issuer === null || issuer === undefined || issuer === '');
}

export function isValidAccount(address: string): boolean {
  return isValidAddress(address);
}

export function isBlackholed(flags: number | null | undefined, regularKey: string | null | undefined): boolean {
  const disableMaster = (flags ?? 0) & LSF_DISABLE_MASTER;
  if (disableMaster === 0) {
    return false;
  }
  if (regularKey === null || regularKey === undefined || regularKey === '') {
    return true;
  }
  return KNOWN_BLACKHOLE_ADDRESSES.has(regularKey);
}

export function amountToString(amount: Amount): string {
  return typeof amount === 'string' ? amount : amount.value;
}

export function issuedAmountFrom(amount: Amount): IssuedAmount | null {
  if (typeof amount === 'string') {
    return null;
  }
  return amount;
}

export function serializeAmount(amount: Amount | undefined): string | null {
  if (amount === undefined) {
    return null;
  }
  if (typeof amount === 'string') {
    return amount;
  }
  return JSON.stringify({
    value: amount.value,
    currency: amount.currency,
    issuer: amount.issuer,
  });
}

export function isZeroDecimal(value: string): boolean {
  return /^[+-]?0+(?:\.0+)?$/.test(value.trim());
}

export function isNegativeDecimal(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('-') && !isZeroDecimal(trimmed);
}

export function negateDecimal(value: string): string {
  const trimmed = value.trim();
  if (isZeroDecimal(trimmed)) {
    return '0';
  }
  return trimmed.startsWith('-') ? trimmed.slice(1) : `-${trimmed}`;
}

export function absDecimal(value: string): string {
  return isNegativeDecimal(value) ? negateDecimal(value) : stripPlus(value);
}

function stripPlus(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
}

function parseDecimal(value: string): { negative: boolean; digits: bigint; scale: number } {
  const trimmed = stripPlus(value);
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw = '0', fracRaw = ''] = unsigned.split('.');
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const frac = fracRaw.replace(/0+$/, '');
  const digits = BigInt(`${whole}${frac}` || '0');
  return { negative, digits, scale: frac.length };
}

function formatDecimal(negative: boolean, digits: bigint, scale: number): string {
  if (digits === 0n) {
    return '0';
  }
  const raw = digits.toString().padStart(scale + 1, '0');
  const split = raw.length - scale;
  const whole = raw.slice(0, split);
  const frac = raw.slice(split).replace(/0+$/, '');
  const body = frac.length === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

export function addDecimal(a: string, b: string): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const scale = Math.max(left.scale, right.scale);
  const leftDigits = left.digits * 10n ** BigInt(scale - left.scale);
  const rightDigits = right.digits * 10n ** BigInt(scale - right.scale);
  const leftSigned = left.negative ? -leftDigits : leftDigits;
  const rightSigned = right.negative ? -rightDigits : rightDigits;
  const sum = leftSigned + rightSigned;
  return formatDecimal(sum < 0n, sum < 0n ? -sum : sum, scale);
}

export function sideKey(side: CurrencySide): string {
  return `${side.currency}\0${side.issuer ?? ''}`;
}

export function normalizePair(a: CurrencySide, b: CurrencySide): NormalizedPair {
  const inverted = sideKey(a) > sideKey(b);
  return inverted
    ? { base: b, counter: a, inverted: true }
    : { base: a, counter: b, inverted: false };
}

export function rippleTimeToUnixSeconds(rippleTime: number): number {
  return rippleTime + 0x38_6d_43_80;
}

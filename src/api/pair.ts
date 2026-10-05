import type { PairKey } from '../db/queries/dex.js';
import {
  decodeCurrency,
  isNativeCurrency,
  isValidAccount,
  normalizePair,
  type CurrencySide,
} from '../util/xahau.js';
import { badRequest } from './errors.js';

export interface RequestedPair {
  stored: PairKey;
  inverted: boolean;
  requested: { base: CurrencySide; counter: CurrencySide };
}

function parseSide(currencyRaw: string, issuerRaw: string | undefined, label: string): CurrencySide {
  const decoded = decodeCurrency(currencyRaw);
  if (isNativeCurrency(decoded.currency, issuerRaw ?? null)) {
    return { currency: decoded.currency, issuer: null };
  }
  if (issuerRaw === undefined || issuerRaw === '') {
    throw badRequest(`${label} issuer is required for ${decoded.currency}`);
  }
  if (!isValidAccount(issuerRaw)) {
    throw badRequest(`${label} issuer is not a valid account`);
  }
  return { currency: decoded.currency, issuer: issuerRaw };
}

export function parseRequestedCurrency(
  currencyRaw: string,
  issuerRaw: string | undefined,
): CurrencySide {
  return parseSide(currencyRaw, issuerRaw, 'currency');
}

export function parseRequestedPair(
  base: string,
  counter: string,
  baseIssuer: string | undefined,
  counterIssuer: string | undefined,
): RequestedPair {
  const requestedBase = parseSide(base, baseIssuer, 'base');
  const requestedCounter = parseSide(counter, counterIssuer, 'counter');
  if (
    requestedBase.currency === requestedCounter.currency &&
    (requestedBase.issuer ?? '') === (requestedCounter.issuer ?? '')
  ) {
    throw badRequest('base and counter must be different');
  }
  const pair = normalizePair(requestedBase, requestedCounter);
  return {
    stored: {
      baseCurrency: pair.base.currency,
      baseIssuer: pair.base.issuer,
      counterCurrency: pair.counter.currency,
      counterIssuer: pair.counter.issuer,
    },
    inverted: pair.inverted,
    requested: { base: requestedBase, counter: requestedCounter },
  };
}

export function tokenXahPair(currency: string, issuer: string): PairKey {
  const pair = normalizePair({ currency, issuer }, { currency: 'XAH', issuer: null });
  return {
    baseCurrency: pair.base.currency,
    baseIssuer: pair.base.issuer,
    counterCurrency: pair.counter.currency,
    counterIssuer: pair.counter.issuer,
  };
}

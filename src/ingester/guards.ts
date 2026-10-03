import type {
  AccountRootObject,
  Amount,
  HookEntry,
  IssuedAmount,
  LedgerRemark,
  RippleStateObject,
  URITokenObject,
} from '../types/xahau.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseIssuedAmount(value: unknown): IssuedAmount | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const currency = asString(value.currency);
  const issuer = asString(value.issuer);
  const amountValue = asString(value.value);
  if (!currency || !issuer || !amountValue) {
    return undefined;
  }
  return { currency, issuer, value: amountValue };
}

export function parseAmount(value: unknown): Amount | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return parseIssuedAmount(value);
}

function parseRemarks(value: unknown): LedgerRemark[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry) => isRecord(entry)) as LedgerRemark[];
}

function parseHooks(value: unknown): HookEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry) => isRecord(entry)) as HookEntry[];
}

export function parseRippleState(value: unknown): RippleStateObject | undefined {
  if (!isRecord(value) || value.LedgerEntryType !== 'RippleState') {
    return undefined;
  }
  const balance = parseIssuedAmount(value.Balance);
  const highLimit = parseIssuedAmount(value.HighLimit);
  const lowLimit = parseIssuedAmount(value.LowLimit);
  if (!balance || !highLimit || !lowLimit) {
    return undefined;
  }
  const remarks = parseRemarks(value.Remarks);
  const index = asString(value.index);
  const flags = asNumber(value.Flags);
  const qualityIn = asNumber(value.QualityIn);
  const qualityOut = asNumber(value.QualityOut);
  return {
    LedgerEntryType: 'RippleState',
    ...(index === undefined ? {} : { index }),
    Balance: balance,
    HighLimit: highLimit,
    LowLimit: lowLimit,
    ...(flags === undefined ? {} : { Flags: flags }),
    ...(qualityIn === undefined ? {} : { QualityIn: qualityIn }),
    ...(qualityOut === undefined ? {} : { QualityOut: qualityOut }),
    ...(remarks === undefined ? {} : { Remarks: remarks }),
  };
}

export function parseUriToken(value: unknown): URITokenObject | undefined {
  if (!isRecord(value) || value.LedgerEntryType !== 'URIToken') {
    return undefined;
  }
  const uri = asString(value.URI);
  const issuer = asString(value.Issuer);
  const owner = asString(value.Owner);
  if (!uri || !issuer || !owner) {
    return undefined;
  }
  const amount = parseAmount(value.Amount);
  const remarks = parseRemarks(value.Remarks);
  const index = asString(value.index);
  const uriTokenId = asString(value.URITokenID);
  const digest = asString(value.Digest);
  const destination = asString(value.Destination);
  const flags = asNumber(value.Flags);
  const previousTxnId = asString(value.PreviousTxnID);
  const previousTxnLgrSeq = asNumber(value.PreviousTxnLgrSeq);
  return {
    LedgerEntryType: 'URIToken',
    ...(index === undefined ? {} : { index }),
    ...(uriTokenId === undefined ? {} : { URITokenID: uriTokenId }),
    URI: uri,
    Issuer: issuer,
    Owner: owner,
    ...(digest === undefined ? {} : { Digest: digest }),
    ...(amount === undefined ? {} : { Amount: amount }),
    ...(destination === undefined ? {} : { Destination: destination }),
    ...(flags === undefined ? {} : { Flags: flags }),
    ...(previousTxnId === undefined ? {} : { PreviousTxnID: previousTxnId }),
    ...(previousTxnLgrSeq === undefined ? {} : { PreviousTxnLgrSeq: previousTxnLgrSeq }),
    ...(remarks === undefined ? {} : { Remarks: remarks }),
  };
}

export function parseAccountRoot(value: unknown): AccountRootObject | undefined {
  if (!isRecord(value) || value.LedgerEntryType !== 'AccountRoot') {
    return undefined;
  }
  const account = asString(value.Account);
  if (!account) {
    return undefined;
  }
  const remarks = parseRemarks(value.Remarks);
  const hooks = parseHooks(value.Hook);
  const index = asString(value.index);
  const balance = asString(value.Balance);
  const flags = asNumber(value.Flags);
  const domain = asString(value.Domain);
  const emailHash = asString(value.EmailHash);
  const transferRate = asNumber(value.TransferRate);
  const regularKey = asString(value.RegularKey);
  const previousTxnLgrSeq = asNumber(value.PreviousTxnLgrSeq);
  return {
    LedgerEntryType: 'AccountRoot',
    ...(index === undefined ? {} : { index }),
    Account: account,
    ...(balance === undefined ? {} : { Balance: balance }),
    ...(flags === undefined ? {} : { Flags: flags }),
    ...(domain === undefined ? {} : { Domain: domain }),
    ...(emailHash === undefined ? {} : { EmailHash: emailHash }),
    ...(transferRate === undefined ? {} : { TransferRate: transferRate }),
    ...(regularKey === undefined ? {} : { RegularKey: regularKey }),
    ...(hooks === undefined ? {} : { Hook: hooks }),
    ...(remarks === undefined ? {} : { Remarks: remarks }),
    ...(previousTxnLgrSeq === undefined ? {} : { PreviousTxnLgrSeq: previousTxnLgrSeq }),
  };
}

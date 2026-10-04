import type {
  AccountRootObject,
  AffectedNode,
  Amount,
  HookEntry,
  HookDefinitionObject,
  HookObject,
  HookParameter,
  IssuedAmount,
  LedgerRemark,
  RippleStateObject,
  TxMeta,
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
  const index = asString(value.index);
  const balance = asString(value.Balance);
  const flags = asNumber(value.Flags);
  const domain = asString(value.Domain);
  const emailHash = asString(value.EmailHash);
  const transferRate = asNumber(value.TransferRate);
  const regularKey = asString(value.RegularKey);
  const previousTxnLgrSeq = asNumber(value.PreviousTxnLgrSeq);
  const hookStateCount = asNumber(value.HookStateCount);
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
    ...(remarks === undefined ? {} : { Remarks: remarks }),
    ...(previousTxnLgrSeq === undefined ? {} : { PreviousTxnLgrSeq: previousTxnLgrSeq }),
    ...(hookStateCount === undefined ? {} : { HookStateCount: hookStateCount }),
  };
}

export function parseHookDefinition(value: unknown): HookDefinitionObject | undefined {
  if (!isRecord(value) || value.LedgerEntryType !== 'HookDefinition') {
    return undefined;
  }
  const hookHash = asString(value.HookHash);
  if (!hookHash) {
    return undefined;
  }
  const index = asString(value.index);
  const hookNamespace = asString(value.HookNamespace);
  const hookOn = asString(value.HookOn);
  const hookOnIncoming = asString(value.HookOnIncoming);
  const hookOnOutgoing = asString(value.HookOnOutgoing);
  const hookCanEmit = asString(value.HookCanEmit);
  const hookName = asString(value.HookName);
  const hookApiVersion = asNumber(value.HookApiVersion);
  const createCode = asString(value.CreateCode);
  const hookSetTxnId = asString(value.HookSetTxnID);
  const fee =
    asString(value.Fee) ??
    (typeof value.Fee === 'number' && Number.isFinite(value.Fee) ? String(value.Fee) : undefined);
  const hookCallbackFee =
    asString(value.HookCallbackFee) ??
    (typeof value.HookCallbackFee === 'number' && Number.isFinite(value.HookCallbackFee)
      ? String(value.HookCallbackFee)
      : undefined);
  const flags = asNumber(value.Flags);
  const referenceCount =
    typeof value.ReferenceCount === 'string' || typeof value.ReferenceCount === 'number'
      ? value.ReferenceCount
      : undefined;
  const parameters = Array.isArray(value.HookParameters)
    ? (value.HookParameters as HookParameter[])
    : isRecord(value.HookParameters)
      ? (value.HookParameters as HookParameter)
      : undefined;
  return {
    LedgerEntryType: 'HookDefinition',
    HookHash: hookHash,
    ...(index === undefined ? {} : { index }),
    ...(hookNamespace === undefined ? {} : { HookNamespace: hookNamespace }),
    ...(hookOn === undefined ? {} : { HookOn: hookOn }),
    ...(hookOnIncoming === undefined ? {} : { HookOnIncoming: hookOnIncoming }),
    ...(hookOnOutgoing === undefined ? {} : { HookOnOutgoing: hookOnOutgoing }),
    ...(hookCanEmit === undefined ? {} : { HookCanEmit: hookCanEmit }),
    ...(hookName === undefined ? {} : { HookName: hookName }),
    ...(hookApiVersion === undefined ? {} : { HookApiVersion: hookApiVersion }),
    ...(parameters === undefined ? {} : { HookParameters: parameters }),
    ...(createCode === undefined ? {} : { CreateCode: createCode }),
    ...(hookSetTxnId === undefined ? {} : { HookSetTxnID: hookSetTxnId }),
    ...(referenceCount === undefined ? {} : { ReferenceCount: referenceCount }),
    ...(fee === undefined ? {} : { Fee: fee }),
    ...(hookCallbackFee === undefined ? {} : { HookCallbackFee: hookCallbackFee }),
    ...(flags === undefined ? {} : { Flags: flags }),
  };
}

export function parseHookObject(value: unknown): HookObject | undefined {
  if (!isRecord(value) || value.LedgerEntryType !== 'Hook') {
    return undefined;
  }
  const account = asString(value.Account);
  if (!account) {
    return undefined;
  }
  const hooks = parseHooks(value.Hooks) ?? [];
  const index = asString(value.index);
  const flags = asNumber(value.Flags);
  const previousTxnLgrSeq = asNumber(value.PreviousTxnLgrSeq);
  return {
    LedgerEntryType: 'Hook',
    Account: account,
    Hooks: hooks,
    ...(index === undefined ? {} : { index }),
    ...(flags === undefined ? {} : { Flags: flags }),
    ...(previousTxnLgrSeq === undefined ? {} : { PreviousTxnLgrSeq: previousTxnLgrSeq }),
  };
}

export type AffectedKind = 'created' | 'modified' | 'deleted';

export interface ParsedAffectedNode {
  kind: AffectedKind;
  type: string;
  index: string;
  fields: Record<string, unknown>;
  previous?: Record<string, unknown>;
}

export function parseAffectedNode(value: unknown): ParsedAffectedNode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (isRecord(value.CreatedNode)) {
    const type = asString(value.CreatedNode.LedgerEntryType);
    const index = asString(value.CreatedNode.LedgerIndex);
    if (!type || !index || !isRecord(value.CreatedNode.NewFields)) {
      return undefined;
    }
    return { kind: 'created', type, index, fields: value.CreatedNode.NewFields };
  }
  if (isRecord(value.ModifiedNode)) {
    const type = asString(value.ModifiedNode.LedgerEntryType);
    const index = asString(value.ModifiedNode.LedgerIndex);
    if (!type || !index) {
      return undefined;
    }
    const fields = isRecord(value.ModifiedNode.FinalFields) ? value.ModifiedNode.FinalFields : {};
    const previous = isRecord(value.ModifiedNode.PreviousFields)
      ? value.ModifiedNode.PreviousFields
      : undefined;
    return {
      kind: 'modified',
      type,
      index,
      fields,
      ...(previous === undefined ? {} : { previous }),
    };
  }
  if (isRecord(value.DeletedNode)) {
    const type = asString(value.DeletedNode.LedgerEntryType);
    const index = asString(value.DeletedNode.LedgerIndex);
    if (!type || !index) {
      return undefined;
    }
    const fields = isRecord(value.DeletedNode.FinalFields) ? value.DeletedNode.FinalFields : {};
    const previous = isRecord(value.DeletedNode.PreviousFields)
      ? value.DeletedNode.PreviousFields
      : undefined;
    return {
      kind: 'deleted',
      type,
      index,
      fields,
      ...(previous === undefined ? {} : { previous }),
    };
  }
  return undefined;
}

export interface ParsedLedgerTx {
  hash: string;
  transactionType: string;
  account: string;
  result: string;
  affectedNodes: AffectedNode[];
  objectId?: string;
  remarks?: unknown;
  amount?: Amount;
  uriTokenId?: string;
}

function parseTxMeta(value: unknown): TxMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result = asString(value.TransactionResult);
  const nodes = Array.isArray(value.AffectedNodes) ? (value.AffectedNodes as AffectedNode[]) : [];
  return {
    ...(result === undefined ? {} : { TransactionResult: result }),
    AffectedNodes: nodes,
  };
}

function flattenLedgerTx(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string' || !isRecord(value)) {
    return undefined;
  }
  if (isRecord(value.tx_json)) {
    const hash = asString(value.hash) ?? asString(value.tx_json.hash);
    return {
      ...value.tx_json,
      ...(hash === undefined ? {} : { hash }),
      meta: value.meta ?? value.metaData ?? value.tx_json.meta,
    };
  }
  if (isRecord(value.transaction)) {
    const hash = asString(value.hash) ?? asString(value.transaction.hash);
    return {
      ...value.transaction,
      ...(hash === undefined ? {} : { hash }),
      meta: value.meta ?? value.metaData ?? value.metadata ?? value.transaction.meta,
    };
  }
  return {
    ...value,
    meta: value.meta ?? value.metaData ?? value.metadata,
  };
}

export function parseLedgerTx(value: unknown): ParsedLedgerTx | undefined {
  const flat = flattenLedgerTx(value);
  if (!flat) {
    return undefined;
  }
  const transactionType = asString(flat.TransactionType);
  const account = asString(flat.Account);
  if (!transactionType || !account) {
    return undefined;
  }
  const meta = parseTxMeta(flat.meta);
  const engineResult = asString(flat.engine_result);
  const result = meta?.TransactionResult ?? engineResult ?? '';
  const hash = asString(flat.hash) ?? '';
  const objectId = asString(flat.ObjectID);
  const uriTokenId = asString(flat.URITokenID);
  const amount = parseAmount(flat.Amount);
  const parsed: ParsedLedgerTx = {
    hash,
    transactionType,
    account,
    result,
    affectedNodes: meta?.AffectedNodes ?? [],
  };
  if (objectId !== undefined) {
    parsed.objectId = objectId;
  }
  if (flat.Remarks !== undefined) {
    parsed.remarks = flat.Remarks;
  }
  if (amount !== undefined) {
    parsed.amount = amount;
  }
  if (uriTokenId !== undefined) {
    parsed.uriTokenId = uriTokenId;
  }
  return parsed;
}

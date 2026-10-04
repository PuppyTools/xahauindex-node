export type HexString = string;
export type AccountAddress = string;

export interface IssuedAmount {
  value: string;
  currency: string;
  issuer: string;
}

export type Amount = string | IssuedAmount;

export interface LedgerRemarkInner {
  RemarkName: string;
  RemarkValue?: string;
  Flags?: number;
}

export interface LedgerRemark {
  Remark?: LedgerRemarkInner;
}

export interface URITokenObject {
  LedgerEntryType: 'URIToken';
  index?: string;
  URITokenID?: string;
  URI: string;
  Issuer: AccountAddress;
  Owner: AccountAddress;
  Digest?: HexString;
  Amount?: Amount;
  Destination?: AccountAddress;
  Flags?: number;
  PreviousTxnID?: HexString;
  PreviousTxnLgrSeq?: number;
  Remarks?: LedgerRemark[];
}

export interface RippleStateObject {
  LedgerEntryType: 'RippleState';
  index?: string;
  Balance: IssuedAmount;
  HighLimit: IssuedAmount;
  LowLimit: IssuedAmount;
  Flags?: number;
  QualityIn?: number;
  QualityOut?: number;
  Remarks?: LedgerRemark[];
}

export interface HookParameterFields {
  HookParameterName?: HexString;
  HookParameterValue?: HexString;
}

export interface HookParameter {
  HookParameter?: HookParameterFields;
}

export interface HookGrantFields {
  HookHash?: HexString;
  Authorize?: AccountAddress;
}

export interface HookGrant {
  HookGrant?: HookGrantFields;
}

export interface HookFields {
  HookHash?: HexString;
  HookNamespace?: HexString;
  HookOn?: HexString;
  HookOnIncoming?: HexString;
  HookOnOutgoing?: HexString;
  HookName?: HexString;
  HookApiVersion?: number;
  HookCanEmit?: HexString;
  Flags?: number;
  HookParameters?: HookParameter[];
  HookGrants?: HookGrant[];
}

export interface HookEntry {
  Hook?: HookFields;
}

export interface AccountRootObject {
  LedgerEntryType: 'AccountRoot';
  index?: string;
  Account: AccountAddress;
  Balance?: string;
  Flags?: number;
  Domain?: HexString;
  EmailHash?: HexString;
  TransferRate?: number;
  RegularKey?: AccountAddress;
  Hook?: HookEntry[];
  Remarks?: LedgerRemark[];
  PreviousTxnLgrSeq?: number;
}

export interface UnknownLedgerObject {
  LedgerEntryType: string;
  index?: string;
}

export type LedgerObject =
  | URITokenObject
  | RippleStateObject
  | AccountRootObject
  | UnknownLedgerObject;

export interface CreatedNode {
  LedgerEntryType: string;
  LedgerIndex: string;
  NewFields: Record<string, unknown>;
}

export interface ModifiedNode {
  LedgerEntryType: string;
  LedgerIndex: string;
  FinalFields?: Record<string, unknown>;
  PreviousFields?: Record<string, unknown>;
}

export interface DeletedNode {
  LedgerEntryType: string;
  LedgerIndex: string;
  FinalFields?: Record<string, unknown>;
}

export type AffectedNode =
  | { CreatedNode: CreatedNode }
  | { ModifiedNode: ModifiedNode }
  | { DeletedNode: DeletedNode };

export interface TxMeta {
  TransactionResult?: string;
  AffectedNodes?: AffectedNode[];
}

export interface TxBase {
  hash?: HexString;
  TransactionType: string;
  Account: AccountAddress;
  meta?: TxMeta;
}

export interface URITokenMintTx extends TxBase {
  TransactionType: 'URITokenMint';
  URI: HexString;
  Digest?: HexString;
  Amount?: Amount;
  Destination?: AccountAddress;
  Flags?: number;
}

export interface URITokenBurnTx extends TxBase {
  TransactionType: 'URITokenBurn';
  URITokenID: HexString;
}

export interface URITokenCreateSellOfferTx extends TxBase {
  TransactionType: 'URITokenCreateSellOffer';
  URITokenID: HexString;
  Amount: Amount;
  Destination?: AccountAddress;
}

export interface URITokenCancelSellOfferTx extends TxBase {
  TransactionType: 'URITokenCancelSellOffer';
  URITokenID: HexString;
}

export interface URITokenBuyTx extends TxBase {
  TransactionType: 'URITokenBuy';
  URITokenID: HexString;
  Amount: Amount;
}

export interface SetRemarksTx extends TxBase {
  TransactionType: 'SetRemarks';
  ObjectID: HexString;
  Remarks: LedgerRemark[];
}

export interface SetHookTx extends TxBase {
  TransactionType: 'SetHook';
  Hooks?: HookEntry[];
}

export interface TrustSetTx extends TxBase {
  TransactionType: 'TrustSet';
  LimitAmount: IssuedAmount;
  Flags?: number;
  QualityIn?: number;
  QualityOut?: number;
}

export interface PaymentTx extends TxBase {
  TransactionType: 'Payment';
  Amount: Amount;
  Destination: AccountAddress;
}

export interface OfferCreateTx extends TxBase {
  TransactionType: 'OfferCreate';
  TakerGets: Amount;
  TakerPays: Amount;
}

export interface OfferDeleteTx extends TxBase {
  TransactionType: 'OfferDelete';
  OfferSequence?: number;
}

export interface AccountSetTx extends TxBase {
  TransactionType: 'AccountSet';
  Domain?: HexString;
  TransferRate?: number;
  SetFlag?: number;
  ClearFlag?: number;
}

export type LedgerTx =
  | URITokenMintTx
  | URITokenBurnTx
  | URITokenCreateSellOfferTx
  | URITokenCancelSellOfferTx
  | URITokenBuyTx
  | SetRemarksTx
  | SetHookTx
  | TrustSetTx
  | PaymentTx
  | OfferCreateTx
  | OfferDeleteTx
  | AccountSetTx
  | TxBase;

export interface LedgerClosedEvent {
  type?: 'ledgerClosed';
  ledger_index: number;
  ledger_hash: string;
  ledger_time: number;
  txn_count?: number;
}

export interface LedgerDataPage {
  ledger_index: number;
  marker?: unknown;
  state: LedgerObject[];
}

export function isUriToken(object: LedgerObject): object is URITokenObject {
  return object.LedgerEntryType === 'URIToken';
}

export function isRippleState(object: LedgerObject): object is RippleStateObject {
  return object.LedgerEntryType === 'RippleState';
}

export function isAccountRoot(object: LedgerObject): object is AccountRootObject {
  return object.LedgerEntryType === 'AccountRoot';
}

export function isIssuedAmount(amount: Amount): amount is IssuedAmount {
  return typeof amount === 'object' && amount !== null && 'currency' in amount;
}

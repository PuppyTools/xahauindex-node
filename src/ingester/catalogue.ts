import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createInflate } from 'node:zlib';

import { rippleTimeToUnixTime } from '@transia/xrpl';

import { HISTORY_TX_TYPES, decodeHistoryTransaction } from './historyDecode.js';

export const CATL_MAGIC = 0x4c_54_41_43;
export const CATL_HEADER_SIZE = 88;
export const CATALOGUE_VERSION = 1;
export const XAHAU_MAINNET_ID = 21337;

const TN_TRANSACTION_NM = 2;
const TN_TRANSACTION_MD = 3;
const TN_REMOVE = 254;
const TN_TERMINAL = 255;

const HISTORY_TX_TYPE_SET = new Set<string>(HISTORY_TX_TYPES);

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueError';
  }
}

export interface CatlHeader {
  minLedger: number;
  maxLedger: number;
  version: number;
  compressionLevel: number;
  networkId: number;
  filesize: bigint;
}

export interface CatalogueTxBlob {
  hash: string;
  rawTxn: Buffer;
  txnMeta: Buffer | null;
}

export interface CatalogueLedger {
  index: number;
  hash: string;
  accountHash: string;
  closeTime: number;
  blobs: CatalogueTxBlob[];
}

export function parseCatlHeader(buf: Buffer): CatlHeader {
  if (buf.length < CATL_HEADER_SIZE) {
    throw new CatalogueError('catalogue header is truncated');
  }
  const magic = buf.readUInt32LE(0);
  if (magic !== CATL_MAGIC) {
    throw new CatalogueError('file is not a xahaud CATL catalogue');
  }
  const versionField = buf.readUInt16LE(12);
  const version = versionField & 0x00ff;
  if (version !== CATALOGUE_VERSION) {
    throw new CatalogueError(`unsupported catalogue version ${version}`);
  }
  const minLedger = buf.readUInt32LE(4);
  const maxLedger = buf.readUInt32LE(8);
  if (maxLedger < minLedger) {
    throw new CatalogueError('catalogue max_ledger is before min_ledger');
  }
  return {
    minLedger,
    maxLedger,
    version,
    compressionLevel: (versionField & 0x0f00) >> 8,
    networkId: buf.readUInt16LE(14),
    filesize: buf.readBigUInt64LE(16),
  };
}

export function encodeVl(length: number): Buffer {
  if (length <= 192) {
    return Buffer.from([length]);
  }
  if (length <= 12_480) {
    const scaled = length - 193;
    return Buffer.from([193 + Math.floor(scaled / 256), scaled % 256]);
  }
  if (length <= 918_744) {
    const scaled = length - 12_481;
    return Buffer.from([241 + Math.floor(scaled / 65536), Math.floor(scaled / 256) % 256, scaled % 256]);
  }
  throw new CatalogueError('VL length is too large');
}

export function decodeVl(buf: Buffer, offset: number): { length: number; prefix: number } {
  if (offset >= buf.length) {
    throw new CatalogueError('truncated VL prefix');
  }
  const byte1 = buf[offset] ?? 0;
  if (byte1 <= 192) {
    return { length: byte1, prefix: 1 };
  }
  if (byte1 <= 240) {
    if (offset + 1 >= buf.length) {
      throw new CatalogueError('truncated VL prefix');
    }
    return { length: 193 + (byte1 - 193) * 256 + (buf[offset + 1] ?? 0), prefix: 2 };
  }
  if (byte1 <= 254) {
    if (offset + 2 >= buf.length) {
      throw new CatalogueError('truncated VL prefix');
    }
    return {
      length: 12_481 + (byte1 - 241) * 65536 + (buf[offset + 1] ?? 0) * 256 + (buf[offset + 2] ?? 0),
      prefix: 3,
    };
  }
  throw new CatalogueError('invalid VL prefix');
}

export function decodeCatalogueTransactions(blobs: readonly CatalogueTxBlob[]): unknown[] {
  const transactions: unknown[] = [];
  for (const blob of blobs) {
    if (blob.txnMeta === null) {
      continue;
    }
    const tx = decodeHistoryTransaction({
      transId: blob.hash,
      rawTxn: blob.rawTxn,
      txnMeta: blob.txnMeta,
    });
    if (tx === null || typeof tx !== 'object') {
      continue;
    }
    const type = (tx as { TransactionType?: unknown }).TransactionType;
    if (typeof type !== 'string' || !HISTORY_TX_TYPE_SET.has(type)) {
      continue;
    }
    transactions.push(tx);
  }
  return transactions;
}

export function splitTxMeta(data: Buffer): { rawTxn: Buffer; txnMeta: Buffer | null } {
  const txVl = decodeVl(data, 0);
  const txStart = txVl.prefix;
  const txEnd = txStart + txVl.length;
  if (txEnd > data.length) {
    throw new CatalogueError('truncated catalogue transaction');
  }
  const rawTxn = data.subarray(txStart, txEnd);
  if (txEnd === data.length) {
    return { rawTxn, txnMeta: null };
  }
  const metaVl = decodeVl(data, txEnd);
  const metaStart = txEnd + metaVl.prefix;
  const metaEnd = metaStart + metaVl.length;
  if (metaEnd > data.length) {
    throw new CatalogueError('truncated catalogue metadata');
  }
  return { rawTxn, txnMeta: data.subarray(metaStart, metaEnd) };
}

class ByteReader {
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly chunks: AsyncIterator<Buffer>;

  constructor(stream: Readable) {
    this.chunks = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async read(size: number): Promise<Buffer> {
    while (this.pending.length < size) {
      if (this.ended) {
        throw new CatalogueError('unexpected end of catalogue');
      }
      const next = await this.chunks.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = next.value;
      this.pending =
        this.pending.length === 0 ? chunk : (Buffer.concat([this.pending, chunk]) as Buffer);
    }
    if (this.pending.length < size) {
      throw new CatalogueError('unexpected end of catalogue');
    }
    const out = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return out;
  }

  async readU8(): Promise<number> {
    return (await this.read(1))[0] ?? 0;
  }

  async readU32(): Promise<number> {
    return (await this.read(4)).readUInt32LE(0);
  }

  async readU64(): Promise<number> {
    const value = (await this.read(8)).readBigUInt64LE(0);
    return Number(value);
  }
}

async function skipShaMap(reader: ByteReader): Promise<void> {
  for (;;) {
    const type = await reader.readU8();
    if (type === TN_TERMINAL) {
      return;
    }
    await reader.read(32);
    if (type === TN_REMOVE) {
      continue;
    }
    const size = await reader.readU32();
    if (size > 1024 * 1024 * 1024) {
      throw new CatalogueError(`catalogue SHAMap leaf is too large (${size})`);
    }
    await reader.read(size);
  }
}

async function readTxMap(reader: ByteReader): Promise<CatalogueTxBlob[]> {
  const out: CatalogueTxBlob[] = [];
  for (;;) {
    const type = await reader.readU8();
    if (type === TN_TERMINAL) {
      return out;
    }
    if (type === TN_REMOVE) {
      throw new CatalogueError('catalogue tx map contained a removal node');
    }
    const key = await reader.read(32);
    const size = await reader.readU32();
    if (size > 1024 * 1024 * 1024) {
      throw new CatalogueError(`catalogue tx leaf is too large (${size})`);
    }
    const data = await reader.read(size);
    if (type !== TN_TRANSACTION_MD && type !== TN_TRANSACTION_NM) {
      continue;
    }
    const split = type === TN_TRANSACTION_NM ? { rawTxn: data, txnMeta: null } : splitTxMeta(data);
    out.push({
      hash: key.toString('hex').toUpperCase(),
      rawTxn: split.rawTxn,
      txnMeta: split.txnMeta,
    });
  }
}

function unixSecondsFromRipple(rippleTime: number): number {
  return Math.floor(rippleTimeToUnixTime(rippleTime) / 1000);
}

async function readLedgerHeader(reader: ByteReader): Promise<{
  seq: number;
  hash: string;
  accountHash: string;
  closeTime: number;
}> {
  const seq = await reader.readU32();
  const hash = await reader.read(32);
  await reader.read(32);
  const accountHash = await reader.read(32);
  await reader.read(32);
  await reader.read(8);
  await reader.read(4);
  await reader.read(4);
  const closeTime = await reader.readU64();
  await reader.read(8);
  return {
    seq,
    hash: hash.toString('hex').toUpperCase(),
    accountHash: accountHash.toString('hex').toUpperCase(),
    closeTime: unixSecondsFromRipple(closeTime),
  };
}

export async function readCatalogueHeader(path: string): Promise<CatlHeader> {
  const handle = await open(path, 'r');
  try {
    const headerBuf = Buffer.alloc(CATL_HEADER_SIZE);
    const { bytesRead } = await handle.read(headerBuf, 0, CATL_HEADER_SIZE, 0);
    if (bytesRead !== CATL_HEADER_SIZE) {
      throw new CatalogueError('catalogue header is truncated');
    }
    return parseCatlHeader(headerBuf);
  } finally {
    await handle.close();
  }
}

export async function* iterateCatalogueLedgers(
  path: string,
  options?: { signal?: AbortSignal },
): AsyncGenerator<{ header: CatlHeader; ledger: CatalogueLedger }> {
  const header = await readCatalogueHeader(path);
  const payload = createReadStream(path, { start: CATL_HEADER_SIZE });
  const stream = header.compressionLevel > 0 ? payload.pipe(createInflate()) : payload;
  const reader = new ByteReader(stream);
  let prevAccountHash: string | null = null;
  let expected = header.minLedger;
  try {
    while (expected <= header.maxLedger) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('aborted');
      }
      const info = await readLedgerHeader(reader);
      if (info.seq !== expected) {
        throw new CatalogueError(`catalogue ledger ${info.seq} is out of sequence (expected ${expected})`);
      }
      const first = expected === header.minLedger;
      const stateUnchanged = !first && prevAccountHash === info.accountHash;
      if (!stateUnchanged) {
        await skipShaMap(reader);
      }
      const blobs = await readTxMap(reader);
      prevAccountHash = info.accountHash;
      yield {
        header,
        ledger: {
          index: info.seq,
          hash: info.hash,
          accountHash: info.accountHash,
          closeTime: info.closeTime,
          blobs,
        },
      };
      expected += 1;
    }
  } finally {
    payload.destroy();
    stream.destroy();
  }
}

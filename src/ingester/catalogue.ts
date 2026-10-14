import { readdirSync, statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { rippleTimeToUnixTime } from '@transia/xrpl';

import { HISTORY_TX_TYPES, decodeHistoryTransaction } from './historyDecode.js';
import { NodeZlibFileInflate, ZlibCatalogueInflate, zlibRandomAccessAvailable } from './zlibInflate.js';

export const CATL_MAGIC = 0x4c_54_41_43;
export const CATL_HEADER_SIZE = 88;
export const CATALOGUE_VERSION = 1;
export const XAHAU_MAINNET_ID = 21337;
const PAYLOAD_CHUNK = 256 * 1024;
const LEDGER_INFO_SIZE = 164;

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

export class CatalogueTruncatedError extends CatalogueError {
  readonly lastSeq: number;
  readonly expected: number;
  readonly fileMin: number;
  readonly fileMax: number;
  readonly filePos: number | null;
  readonly fileSize: number | null;

  constructor(expected: number, header: CatlHeader, progress?: { filePos: number; fileSize: number } | null) {
    const lastSeq = expected - 1;
    super(
      `catalogue payload ends at ledger ${lastSeq}; header claims ${header.minLedger}-${header.maxLedger} (expected ${expected})`,
    );
    this.name = 'CatalogueTruncatedError';
    this.lastSeq = lastSeq;
    this.expected = expected;
    this.fileMin = header.minLedger;
    this.fileMax = header.maxLedger;
    this.filePos = progress?.filePos ?? null;
    this.fileSize = progress?.fileSize ?? null;
  }
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

export interface CatalogueCheckpoint {
  path: string;
  nextSeq: number;
  prevAccountHash: string | null;
  pending: Buffer;
  inputOffset: number;
  bits: number;
  window: Buffer | null;
}

export interface CatalogueFile {
  path: string;
  header: CatlHeader;
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

interface CataloguePayload {
  readChunk(): Promise<Buffer | null>;
  snapshot(): Promise<{ extra: Buffer; inputOffset: number; bits: number; window: Buffer | null }>;
  progress(): { filePos: number; fileSize: number } | null;
  destroy(): void;
}

class FileCataloguePayload implements CataloguePayload {
  private pos: number;

  constructor(
    private readonly handle: FileHandle,
    start: number,
    private readonly fileSize: number,
  ) {
    this.pos = start;
  }

  async readChunk(): Promise<Buffer | null> {
    const buf = Buffer.alloc(PAYLOAD_CHUNK);
    const { bytesRead } = await this.handle.read(buf, 0, buf.length, this.pos);
    if (bytesRead === 0) {
      return null;
    }
    this.pos += bytesRead;
    return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  }

  async snapshot(): Promise<{ extra: Buffer; inputOffset: number; bits: number; window: Buffer | null }> {
    return { extra: Buffer.alloc(0), inputOffset: this.pos, bits: 0, window: null };
  }

  progress(): { filePos: number; fileSize: number } {
    return { filePos: this.pos, fileSize: this.fileSize };
  }

  destroy(): void {
    void this.handle.close();
  }
}

class ZlibCataloguePayload implements CataloguePayload {
  constructor(private readonly inflate: ZlibCatalogueInflate) {}

  async readChunk(): Promise<Buffer | null> {
    const chunk = await this.inflate.read(PAYLOAD_CHUNK);
    return chunk.length === 0 ? null : chunk;
  }

  async snapshot(): Promise<{ extra: Buffer; inputOffset: number; bits: number; window: Buffer | null }> {
    const { extra, point } = await this.inflate.snapshot();
    return { extra, inputOffset: point.inputOffset, bits: point.bits, window: point.window };
  }

  progress(): { filePos: number; fileSize: number } {
    return this.inflate.progress();
  }

  destroy(): void {
    this.inflate.close();
  }
}

class NodeZlibCataloguePayload implements CataloguePayload {
  constructor(private readonly inflate: NodeZlibFileInflate) {}

  async readChunk(): Promise<Buffer | null> {
    const chunk = await this.inflate.read(PAYLOAD_CHUNK);
    return chunk.length === 0 ? null : chunk;
  }

  async snapshot(): Promise<{ extra: Buffer; inputOffset: number; bits: number; window: Buffer | null }> {
    return { extra: Buffer.alloc(0), inputOffset: CATL_HEADER_SIZE, bits: 0, window: null };
  }

  progress(): { filePos: number; fileSize: number } {
    return this.inflate.progress();
  }

  destroy(): void {
    this.inflate.close();
  }
}

function skipShaMapPartial(buf: Buffer, offset: number): { offset: number; done: boolean } {
  while (offset < buf.length) {
    const type = buf[offset] ?? 0;
    if (type === TN_TERMINAL) {
      return { offset: offset + 1, done: true };
    }
    if (offset + 33 > buf.length) {
      return { offset, done: false };
    }
    let next = offset + 33;
    if (type !== TN_REMOVE) {
      if (next + 4 > buf.length) {
        return { offset, done: false };
      }
      const size = buf.readUInt32LE(next);
      if (size > 1024 * 1024 * 1024) {
        throw new CatalogueError(`catalogue SHAMap leaf is too large (${size})`);
      }
      next += 4;
      if (next + size > buf.length) {
        return { offset, done: false };
      }
      next += size;
    }
    offset = next;
  }
  return { offset, done: false };
}

class ByteReader {
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly payload: CataloguePayload) {}

  prepend(buf: Buffer): void {
    if (buf.length === 0) {
      return;
    }
    this.pending = this.pending.length === 0 ? buf : (Buffer.concat([buf, this.pending]) as Buffer);
  }

  append(buf: Buffer): void {
    if (buf.length === 0) {
      return;
    }
    this.pending = this.pending.length === 0 ? buf : (Buffer.concat([this.pending, buf]) as Buffer);
  }

  peekPending(): Buffer {
    return this.pending;
  }

  async snapshot(): Promise<{ extra: Buffer; inputOffset: number; bits: number; window: Buffer | null }> {
    return this.payload.snapshot();
  }

  async read(size: number): Promise<Buffer> {
    await this.ensure(size);
    const out = this.pending.subarray(0, size);
    this.consume(size);
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

  async skipShaMap(): Promise<void> {
    for (;;) {
      const result = skipShaMapPartial(this.pending, 0);
      if (result.done) {
        this.consume(result.offset);
        return;
      }
      this.consume(result.offset);
      if (!(await this.pull())) {
        throw new CatalogueError('unexpected end of catalogue');
      }
    }
  }

  private async ensure(size: number): Promise<void> {
    while (this.pending.length < size) {
      if (!(await this.pull())) {
        const unread = this.pending.length;
        throw new CatalogueError(
          unread === 0
            ? 'unexpected end of catalogue'
            : `unexpected end of catalogue (${unread} unread byte(s), needed ${size})`,
        );
      }
    }
  }

  private async pull(): Promise<boolean> {
    if (this.ended) {
      return false;
    }
    const chunk = await this.payload.readChunk();
    if (chunk === null) {
      this.ended = true;
      return false;
    }
    this.pending = this.pending.length === 0 ? chunk : (Buffer.concat([this.pending, chunk]) as Buffer);
    return true;
  }

  private consume(size: number): void {
    if (size <= 0) {
      return;
    }
    this.pending = this.pending.subarray(size);
    if (this.pending.byteOffset > PAYLOAD_CHUNK) {
      this.pending = Buffer.from(this.pending);
    }
  }
}

async function skipShaMap(reader: ByteReader): Promise<void> {
  await reader.skipShaMap();
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
  const buf = await reader.read(LEDGER_INFO_SIZE);
  return {
    seq: buf.readUInt32LE(0),
    hash: buf.subarray(4, 36).toString('hex').toUpperCase(),
    accountHash: buf.subarray(68, 100).toString('hex').toUpperCase(),
    closeTime: unixSecondsFromRipple(Number(buf.readBigUInt64LE(148))),
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

export async function listCatalogueFiles(path: string): Promise<CatalogueFile[]> {
  const info = statSync(path);
  if (info.isFile()) {
    return [{ path, header: await readCatalogueHeader(path) }];
  }
  if (!info.isDirectory()) {
    throw new CatalogueError(`HISTORY_CATALOGUE is not a file or directory: ${path}`);
  }
  const names = readdirSync(path);
  const files: CatalogueFile[] = [];
  for (const name of names) {
    const full = join(path, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    try {
      files.push({ path: full, header: await readCatalogueHeader(full) });
    } catch {
      continue;
    }
  }
  files.sort((a, b) => a.header.minLedger - b.header.minLedger || a.path.localeCompare(b.path));
  if (files.length === 0) {
    throw new CatalogueError(`HISTORY_CATALOGUE directory has no CATL files: ${path}`);
  }
  return files;
}

async function openCataloguePayload(
  path: string,
  header: CatlHeader,
  resume: CatalogueCheckpoint | null,
  fromStart: 'libz' | 'node' = 'libz',
): Promise<CataloguePayload> {
  const start = resume !== null && header.compressionLevel === 0 ? resume.inputOffset : CATL_HEADER_SIZE;
  if (header.compressionLevel === 0) {
    const handle = await open(path, 'r');
    const fileSize = (await handle.stat()).size;
    return new FileCataloguePayload(handle, start, fileSize);
  }
  if (resume !== null && resume.window !== null && zlibRandomAccessAvailable()) {
    const inflate = await ZlibCatalogueInflate.open(path, CATL_HEADER_SIZE, {
      inputOffset: resume.inputOffset,
      bits: resume.bits,
      window: resume.window,
    });
    return new ZlibCataloguePayload(inflate);
  }
  if (fromStart === 'libz' && zlibRandomAccessAvailable()) {
    const inflate = await ZlibCatalogueInflate.open(path, CATL_HEADER_SIZE);
    return new ZlibCataloguePayload(inflate);
  }
  const inflate = await NodeZlibFileInflate.open(path, CATL_HEADER_SIZE);
  return new NodeZlibCataloguePayload(inflate);
}

export async function* iterateCatalogueLedgers(
  path: string,
  options?: {
    signal?: AbortSignal;
    resume?: CatalogueCheckpoint;
    decodeFrom?: number;
    skipUntil?: number;
    skipCheckpointEvery?: number;
    onSkipProgress?: (info: {
      seq: number;
      scanned: number;
      checkpoint: () => Promise<CatalogueCheckpoint>;
    }) => Promise<void>;
  },
): AsyncGenerator<{
  header: CatlHeader;
  ledger: CatalogueLedger;
  checkpoint: () => Promise<CatalogueCheckpoint>;
}> {
  const header = await readCatalogueHeader(path);
  const resume =
    options?.resume !== undefined &&
    options.resume.path === path &&
    options.resume.nextSeq >= header.minLedger &&
    options.resume.nextSeq <= header.maxLedger + 1
      ? options.resume
      : null;
  const skipUntil = options?.skipUntil ?? header.minLedger;
  const fromStart = resume === null && skipUntil > header.minLedger ? 'node' : 'libz';
  const payload = await openCataloguePayload(path, header, resume, fromStart);
  const reader = new ByteReader(payload);
  if (resume !== null && resume.pending.length > 0) {
    reader.prepend(resume.pending);
  }
  let prevAccountHash = resume?.prevAccountHash ?? null;
  const startSeq = resume?.nextSeq ?? header.minLedger;
  let expected = startSeq;
  const decodeFrom = options?.decodeFrom ?? header.minLedger;
  const skipCheckpointEvery = options?.skipCheckpointEvery ?? 50_000;
  let skipped = 0;
  try {
    while (expected <= header.maxLedger) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('aborted');
      }
      const info = await readLedgerHeader(reader);
      if (info.seq !== expected) {
        throw new CatalogueError(`catalogue ledger ${info.seq} is out of sequence (expected ${expected})`);
      }
      const first = prevAccountHash === null && expected === header.minLedger;
      const stateUnchanged = !first && prevAccountHash === info.accountHash;
      if (!stateUnchanged) {
        await skipShaMap(reader);
      }
      let blobs: CatalogueTxBlob[] = [];
      if (expected < decodeFrom || expected < skipUntil) {
        await skipShaMap(reader);
      } else {
        blobs = await readTxMap(reader);
      }
      prevAccountHash = info.accountHash;
      expected += 1;
      const nextSeq = expected;
      const accountHash = prevAccountHash;
      const checkpoint = async (): Promise<CatalogueCheckpoint> => {
        const snap = await reader.snapshot();
        if (snap.extra.length > 0) {
          reader.append(snap.extra);
        }
        return {
          path,
          nextSeq,
          prevAccountHash: accountHash,
          pending: Buffer.from(reader.peekPending()),
          inputOffset: snap.inputOffset,
          bits: snap.bits,
          window: snap.window,
        };
      };
      if (info.seq < skipUntil) {
        skipped += 1;
        if (options?.onSkipProgress !== undefined && info.seq % skipCheckpointEvery === 0) {
          await options.onSkipProgress({ seq: info.seq, scanned: skipped, checkpoint });
        }
        if (skipped % 2_000 === 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        continue;
      }
      yield {
        header,
        ledger: {
          index: info.seq,
          hash: info.hash,
          accountHash: info.accountHash,
          closeTime: info.closeTime,
          blobs,
        },
        checkpoint,
      };
    }
  } catch (error) {
    if (error instanceof CatalogueError && error.message.startsWith('unexpected end of catalogue')) {
      if (expected > startSeq) {
        throw new CatalogueTruncatedError(expected, header, payload.progress());
      }
      throw new CatalogueError(
        `unexpected end of catalogue at ledger ${expected} (file ${header.minLedger}-${header.maxLedger})`,
      );
    }
    throw error;
  } finally {
    payload.destroy();
  }
}

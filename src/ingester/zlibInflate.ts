import { open, type FileHandle } from 'node:fs/promises';

import koffi from 'koffi';

const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_BUF_ERROR = -5;
const Z_NO_FLUSH = 0;
const Z_BLOCK = 5;
const ZLIB_WINDOW_BITS = 15;
const RAW_WINDOW_BITS = -15;
const WINSIZE = 32_768;
const CHUNK = 65_536;

interface Libz {
  sizeofStream: number;
  version: string;
  inflateInit2_: (strm: Buffer, windowBits: number, version: string, streamSize: number) => number;
  inflate: (strm: Buffer, flush: number) => number;
  inflateEnd: (strm: Buffer) => number;
  inflateGetDictionary: (strm: Buffer, dict: Buffer, len: Buffer) => number;
  inflateSetDictionary: (strm: Buffer, dict: Buffer, len: number) => number;
  inflatePrime: (strm: Buffer, bits: number, value: number) => number;
  decode: (strm: Buffer) => ZStreamView;
  encode: (strm: Buffer, view: ZStreamView) => void;
}

interface ZStreamView {
  next_in: Buffer | null;
  avail_in: number;
  total_in: number | bigint;
  next_out: Buffer | null;
  avail_out: number;
  total_out: number | bigint;
  msg: string | null;
  state: unknown;
  zalloc: unknown;
  zfree: unknown;
  opaque: unknown;
  data_type: number;
  adler: number | bigint;
  reserved: number | bigint;
}

export interface ZlibAccessPoint {
  /** Absolute file offset of the next compressed byte (zran `in`). */
  inputOffset: number;
  bits: number;
  window: Buffer;
}

let libz: Libz | null | undefined;

function libzName(): string {
  if (process.platform === 'darwin') {
    return 'libz.dylib';
  }
  if (process.platform === 'win32') {
    return 'zlib1.dll';
  }
  return 'libz.so.1';
}

function loadLibz(): Libz | null {
  if (libz !== undefined) {
    return libz;
  }
  try {
    const native = koffi.load(libzName());
    const ZStream = koffi.struct('z_stream', {
      next_in: 'uint8 *',
      avail_in: 'uint32',
      total_in: 'ulong',
      next_out: 'uint8 *',
      avail_out: 'uint32',
      total_out: 'ulong',
      msg: 'char *',
      state: 'void *',
      zalloc: 'void *',
      zfree: 'void *',
      opaque: 'void *',
      data_type: 'int32',
      adler: 'ulong',
      reserved: 'ulong',
    });
    const zlibVersion = native.func('const char *zlibVersion()');
    libz = {
      sizeofStream: koffi.sizeof(ZStream),
      version: zlibVersion() as string,
      inflateInit2_: native.func(
        'int inflateInit2_(_Inout_ z_stream *strm, int windowBits, const char *version, int stream_size)',
      ),
      inflate: native.func('int inflate(_Inout_ z_stream *strm, int flush)'),
      inflateEnd: native.func('int inflateEnd(_Inout_ z_stream *strm)'),
      inflateGetDictionary: native.func(
        'int inflateGetDictionary(_Inout_ z_stream *strm, uint8 *dict, _Inout_ uint32 *len)',
      ),
      inflateSetDictionary: native.func(
        'int inflateSetDictionary(_Inout_ z_stream *strm, const uint8 *dict, uint32 len)',
      ),
      inflatePrime: native.func('int inflatePrime(_Inout_ z_stream *strm, int bits, int value)'),
      decode: (strm) => koffi.decode(strm, ZStream) as ZStreamView,
      encode: (strm, view) => {
        koffi.encode(strm, ZStream, view);
      },
    };
    return libz;
  } catch {
    libz = null;
    return null;
  }
}

export function zlibRandomAccessAvailable(): boolean {
  return loadLibz() !== null;
}

function check(rc: number, what: string): void {
  if (rc !== Z_OK && rc !== Z_STREAM_END && rc !== Z_BUF_ERROR) {
    throw new Error(`${what} failed (${rc})`);
  }
}

export class ZlibCatalogueInflate {
  private readonly lib: Libz;
  private readonly handle: FileHandle;
  private readonly strm: Buffer;
  private readonly inBuf: Buffer = Buffer.alloc(CHUNK);
  private readonly outScratch: Buffer = Buffer.alloc(CHUNK);
  private inOff = 0;
  private inLen = 0;
  private filePos: number;
  private pendingOut: Buffer = Buffer.alloc(0);
  private ended = false;
  private closed = false;

  private constructor(lib: Libz, handle: FileHandle, strm: Buffer, filePos: number) {
    this.lib = lib;
    this.handle = handle;
    this.strm = strm;
    this.filePos = filePos;
  }

  static async open(path: string, payloadStart: number, resume?: ZlibAccessPoint): Promise<ZlibCatalogueInflate> {
    const lib = loadLibz();
    if (lib === null) {
      throw new Error('libz is not available');
    }
    const handle = await open(path, 'r');
    const strm = Buffer.alloc(lib.sizeofStream);
    try {
      if (resume === undefined) {
        check(lib.inflateInit2_(strm, ZLIB_WINDOW_BITS, lib.version, lib.sizeofStream), 'inflateInit2');
        return new ZlibCatalogueInflate(lib, handle, strm, payloadStart);
      }
      const bits = resume.bits;
      const seek = resume.inputOffset - (bits > 0 ? 1 : 0);
      check(lib.inflateInit2_(strm, RAW_WINDOW_BITS, lib.version, lib.sizeofStream), 'inflateInit2 raw');
      if (bits > 0) {
        const byte = Buffer.alloc(1);
        const { bytesRead } = await handle.read(byte, 0, 1, seek);
        if (bytesRead !== 1) {
          throw new Error('catalogue checkpoint is truncated');
        }
        check(lib.inflatePrime(strm, bits, byte[0]! >> (8 - bits)), 'inflatePrime');
        check(lib.inflateSetDictionary(strm, resume.window, resume.window.length), 'inflateSetDictionary');
        return new ZlibCatalogueInflate(lib, handle, strm, seek + 1);
      }
      check(lib.inflateSetDictionary(strm, resume.window, resume.window.length), 'inflateSetDictionary');
      return new ZlibCatalogueInflate(lib, handle, strm, seek);
    } catch (error) {
      lib.inflateEnd(strm);
      await handle.close();
      throw error;
    }
  }

  async read(size: number): Promise<Buffer> {
    while (this.pendingOut.length < size && !this.ended) {
      const produced = await this.inflateOnce(Z_NO_FLUSH);
      if (produced === 0 && this.ended) {
        break;
      }
      if (produced === 0) {
        const more = await this.readFile();
        if (more === 0) {
          this.ended = true;
          break;
        }
      }
    }
    const take = Math.min(size, this.pendingOut.length);
    const out = this.pendingOut.subarray(0, take);
    this.pendingOut = this.pendingOut.subarray(take);
    return take === size ? out : Buffer.from(out);
  }

  /**
   * Inflate to the next zran access point (`(data_type & 0xc0) === 0x80`) and
   * return uncompressed bytes already produced but not yet pulled, plus any
   * extra bytes emitted while aligning.
   */
  async snapshot(): Promise<{ extra: Buffer; point: ZlibAccessPoint }> {
    while (!this.ended && (this.dataType() & 0xc0) !== 0x80) {
      const produced = await this.inflateOnce(Z_BLOCK);
      if (produced === 0 && (this.dataType() & 0xc0) !== 0x80 && !this.ended) {
        const more = await this.readFile();
        if (more === 0) {
          this.ended = true;
          break;
        }
      }
    }
    const extra = this.pendingOut;
    this.pendingOut = Buffer.alloc(0);
    return { extra, point: this.accessPoint() };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lib.inflateEnd(this.strm);
    void this.handle.close();
  }

  private dataType(): number {
    return this.lib.decode(this.strm).data_type;
  }

  private accessPoint(): ZlibAccessPoint {
    const nextCompressed = this.filePos - (this.inLen - this.inOff);
    const window = Buffer.alloc(WINSIZE);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(WINSIZE);
    check(this.lib.inflateGetDictionary(this.strm, window, lenBuf), 'inflateGetDictionary');
    const dictLen = lenBuf.readUInt32LE();
    return {
      inputOffset: nextCompressed,
      bits: this.dataType() & 7,
      window: dictLen === WINSIZE ? window : window.subarray(0, dictLen),
    };
  }

  private async inflateOnce(flush: number): Promise<number> {
    if (this.ended) {
      return 0;
    }
    if (this.inOff >= this.inLen) {
      const more = await this.readFile();
      if (more === 0 && flush !== Z_BLOCK) {
        this.ended = true;
        return 0;
      }
    }
    const view = this.lib.decode(this.strm);
    const input = this.inBuf.subarray(this.inOff, this.inLen);
    const output = this.outScratch;
    view.next_in = input;
    view.avail_in = input.length;
    view.next_out = output;
    view.avail_out = output.length;
    this.lib.encode(this.strm, view);
    const rc = this.lib.inflate(this.strm, flush);
    const after = this.lib.decode(this.strm);
    const consumed = input.length - after.avail_in;
    const produced = output.length - after.avail_out;
    this.inOff += consumed;
    if (produced > 0) {
      const chunk = Buffer.from(output.subarray(0, produced));
      this.pendingOut = this.pendingOut.length === 0 ? chunk : Buffer.concat([this.pendingOut, chunk]);
    }
    if (rc === Z_STREAM_END) {
      this.ended = true;
    } else if (rc !== Z_OK && rc !== Z_BUF_ERROR) {
      check(rc, 'inflate');
    }
    return produced;
  }

  private async readFile(): Promise<number> {
    const { bytesRead } = await this.handle.read(this.inBuf, 0, this.inBuf.length, this.filePos);
    this.inOff = 0;
    this.inLen = bytesRead;
    this.filePos += bytesRead;
    return bytesRead;
  }
}

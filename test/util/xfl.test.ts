import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { xflToString } from '../../src/util/xfl.js';

function getXfl(floatStr: string): bigint {
  const minMantissa = 1000000000000000n;
  const maxMantissa = 9999999999999999n;
  const normalized = Number.parseFloat(floatStr).toString();
  let exponent: bigint;
  let mantissa: bigint;
  if (normalized === '0') {
    return 0n;
  }
  if (normalized.includes('.')) {
    const parts = normalized.split('.');
    exponent = BigInt(-(parts[1] ?? '').length);
    mantissa = BigInt(Number.parseInt(parts.join(''), 10));
  } else if (normalized.endsWith('0')) {
    const mantissaStr = normalized.replace(/0+$/g, '');
    exponent = BigInt(normalized.length - mantissaStr.length);
    mantissa = BigInt(Number.parseInt(mantissaStr, 10));
  } else {
    exponent = 0n;
    mantissa = BigInt(Number.parseInt(normalized, 10));
  }
  const negative = mantissa < 0n;
  if (negative) {
    mantissa *= -1n;
  }
  while (mantissa > maxMantissa) {
    mantissa /= 10n;
    exponent += 1n;
  }
  while (mantissa < minMantissa) {
    mantissa *= 10n;
    exponent -= 1n;
  }
  exponent += 97n;
  let xfl = negative ? 0n : 1n;
  xfl <<= 8n;
  xfl |= exponent;
  xfl <<= 54n;
  xfl |= mantissa;
  return xfl;
}

describe('xflToString', () => {
  it('round-trips Evernode-style lease amounts', () => {
    assert.equal(xflToString(0n), '0');
    assert.equal(xflToString(getXfl('12.5')), '12.5');
    assert.equal(xflToString(getXfl('0.0001')), '0.0001');
  });
});

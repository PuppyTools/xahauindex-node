import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDecimal,
  decodeCurrency,
  dropsToXah,
  hexToUtf8,
  isBlackholed,
  isZeroDecimal,
  LSF_DISABLE_MASTER,
  negateDecimal,
  normalizePair,
  subtractDecimal,
} from '../../src/util/xahau.js';

describe('currency helpers', () => {
  it('keeps standard 3-character codes', () => {
    assert.deepEqual(decodeCurrency('usd'), { currency: 'USD', currencyHex: null });
  });

  it('decodes 40-character hex codes and strips NULs', () => {
    const hex = Buffer.from('MyToken\0'.padEnd(20, '\0'), 'utf8').toString('hex');
    const decoded = decodeCurrency(hex);
    assert.equal(decoded.currency, 'MyToken');
    assert.equal(decoded.currencyHex, hex.toUpperCase());
  });

  it('decodes Domain-style hex to UTF-8', () => {
    assert.equal(hexToUtf8(Buffer.from('example.com', 'utf8').toString('hex')), 'example.com');
  });
});

describe('decimals', () => {
  it('adds IOU-style decimals without floats', () => {
    assert.equal(addDecimal('1.50', '2.5'), '4');
    assert.equal(addDecimal('0.1', '0.2'), '0.3');
    assert.equal(addDecimal('-5', '2'), '-3');
    assert.equal(negateDecimal('12.0'), '-12.0');
    assert.ok(isZeroDecimal('0.000'));
    assert.equal(subtractDecimal('2.5', '1.25'), '1.25');
    assert.equal(dropsToXah('1000000'), '1');
    assert.equal(dropsToXah('1500000'), '1.5');
  });
});

describe('pairs and blackhole', () => {
  it('orders sides lexicographically with XAH issuer null', () => {
    const pair = normalizePair(
      { currency: 'XAH', issuer: null },
      { currency: 'USD', issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' },
    );
    assert.equal(pair.base.currency, 'USD');
    assert.equal(pair.counter.currency, 'XAH');
    assert.equal(pair.inverted, true);
  });

  it('detects a disabled master key with no RegularKey', () => {
    assert.equal(isBlackholed(LSF_DISABLE_MASTER, null), true);
    assert.equal(isBlackholed(LSF_DISABLE_MASTER, 'rrrrrrrrrrrrrrrrrrrrBZbvji'), true);
    assert.equal(isBlackholed(0, null), false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  absDecimal,
  addDecimal,
  decodeAccountDomain,
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
    assert.equal(decodeAccountDomain(Buffer.from('example.com', 'utf8').toString('hex')), 'example.com');
    assert.equal(
      decodeAccountDomain(
        'ED7573749189112BED42DED36ECFE7BFF43C2D50A6A3F080EF874BE3D5CCDC2B004D59584A000000000000',
      ),
      null,
    );
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

  it('adds XRPL scientific-notation IOU amounts', () => {
    assert.equal(addDecimal('0', '5296754300000000e-26'), '0.000000000052967543');
    assert.equal(addDecimal('5296754300000000e-26', '1'), '1.000000000052967543');
    assert.equal(addDecimal('1.23e-2', '4.56e-2'), '0.0579');
    assert.equal(addDecimal('3.5E+6', '500000'), '4000000');
    assert.ok(isZeroDecimal('0e-26'));
    assert.ok(isZeroDecimal('0E0'));
    assert.equal(isZeroDecimal('5296754300000000e-26'), false);
    assert.equal(absDecimal('-5296754300000000e-26'), '0.000000000052967543');
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

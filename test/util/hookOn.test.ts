import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeHookOn, hexByteLength, hookOnFiresOn } from '../../src/util/hookOn.js';

describe('decodeHookOn', () => {
  it('treats all-zero as every type except SetHook', () => {
    const mask = decodeHookOn('0');
    assert.ok(mask);
    assert.equal(mask.mode, 'all_except');
    assert.deepEqual(mask.types, ['SetHook']);
    assert.equal(hookOnFiresOn('0', 0), true);
    assert.equal(hookOnFiresOn('0', 22), false);
  });

  it('decodes a Payment-only mask', () => {
    const mask = decodeHookOn('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFFFFE');
    assert.ok(mask);
    assert.equal(mask.mode, 'only');
    assert.deepEqual(mask.types, ['Payment']);
  });

  it('decodes a fully disabled mask', () => {
    const mask = decodeHookOn('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFFFFF');
    assert.ok(mask);
    assert.equal(mask.mode, 'none');
    assert.deepEqual(mask.types, []);
  });

  it('returns null for empty or junk', () => {
    assert.equal(decodeHookOn(null), null);
    assert.equal(decodeHookOn('zz'), null);
    assert.equal(hexByteLength('0061736D'), 4);
    assert.equal(hexByteLength('odd'), 0);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRemarkArray,
  parseRemarkEntry,
  remarksToDisplay,
} from '../../src/ingester/remarks.js';

describe('remarks decoder', () => {
  it('decodes hex name/value pairs', () => {
    const decoded = parseRemarkEntry({
      Remark: {
        RemarkName: Buffer.from('name').toString('hex'),
        RemarkValue: Buffer.from('Cool NFT').toString('hex'),
        Flags: 0,
      },
    });
    assert.ok(decoded);
    assert.equal(decoded.deleted, false);
    assert.equal(decoded.name, 'name');
    assert.equal(decoded.value, 'Cool NFT');
  });

  it('stringifies JSON values', () => {
    const decoded = parseRemarkEntry({
      Remark: {
        RemarkName: Buffer.from('attributes').toString('hex'),
        RemarkValue: Buffer.from('{"color":"red"}').toString('hex'),
      },
    });
    assert.ok(decoded);
    assert.equal(decoded.value, '{"color":"red"}');
  });

  it('treats a missing value as a delete', () => {
    const decoded = parseRemarkEntry({
      Remark: { RemarkName: Buffer.from('name').toString('hex') },
    });
    assert.ok(decoded);
    assert.equal(decoded.deleted, true);
  });

  it('maps well-known keys onto display fields', () => {
    const display = remarksToDisplay(
      parseRemarkArray([
        { Remark: { RemarkName: Buffer.from('title').toString('hex'), RemarkValue: Buffer.from('USD').toString('hex') } },
        { Remark: { RemarkName: Buffer.from('icon').toString('hex'), RemarkValue: Buffer.from('https://i').toString('hex') } },
      ]).filter((item) => !item.deleted),
    );
    assert.equal(display.name, 'USD');
    assert.equal(display.iconUrl, 'https://i');
  });
});

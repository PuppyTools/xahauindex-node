import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evernodeCatalog, labelForHook } from '../../src/util/hookLabels.js';

describe('labelForHook', () => {
  it('labels a current Evernode heartbeat hash', () => {
    const label = labelForHook({
      hookHash: '1f7c84e14313c4ff2d4f39535428bf10767ccf8e87efb51306cc3f94d13439ec',
    });
    assert.ok(label);
    assert.equal(label.name, 'Evernode heartbeat');
    assert.equal(label.project, 'Evernode');
    assert.equal(label.source, 'catalog');
  });

  it('labels an Evernode governor account after a hash change', () => {
    const label = labelForHook({
      hookHash: 'A'.repeat(64),
      account: 'rBvKgF3jSZWdJcwSsmoJspoXLLDVLDp6jg',
    });
    assert.ok(label);
    assert.equal(label.name, 'Evernode governor');
  });

  it('returns null for unknown hashes and accounts', () => {
    assert.equal(labelForHook({ hookHash: 'A'.repeat(64) }), null);
    assert.equal(evernodeCatalog().length, 4);
  });
});

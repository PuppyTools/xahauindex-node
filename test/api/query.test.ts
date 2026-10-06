import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LIMIT,
  DEFAULT_PER_PAGE,
  MAX_LIMIT,
  MAX_PER_PAGE,
  parseLimit,
  parsePerPage,
} from '../../src/api/query.js';

describe('page ceilings', () => {
  it('keeps list defaults and clamps per_page at 250', () => {
    assert.equal(DEFAULT_PER_PAGE, 20);
    assert.equal(MAX_PER_PAGE, 250);
    assert.equal(parsePerPage(undefined), 20);
    assert.equal(parsePerPage('20'), 20);
    assert.equal(parsePerPage('250'), 250);
    assert.equal(parsePerPage('999'), 250);
  });

  it('keeps range defaults and clamps limit at 1000', () => {
    assert.equal(DEFAULT_LIMIT, 100);
    assert.equal(MAX_LIMIT, 1000);
    assert.equal(parseLimit(undefined), 100);
    assert.equal(parseLimit('100'), 100);
    assert.equal(parseLimit('1000'), 1000);
    assert.equal(parseLimit('9999'), 1000);
  });
});

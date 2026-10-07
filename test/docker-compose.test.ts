import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

describe('docker compose history mounts', () => {
  const compose = parse(readFileSync('docker-compose.yml', 'utf8')) as {
    services: {
      xahauindex: {
        environment: Record<string, string>;
        volumes: string[];
      };
    };
  };
  const service = compose.services.xahauindex;

  it('rewrites host history paths from .env so operators do not edit compose', () => {
    assert.equal(service.environment.HISTORY_CATALOGUE, '${HISTORY_CATALOGUE:+/import/catalogue}');
    assert.equal(service.environment.HISTORY_LEDGER_DB, '${HISTORY_LEDGER_DB:+/import/ledger.db}');
    assert.equal(service.environment.HISTORY_TX_DB, '${HISTORY_TX_DB:+/import/transaction.db}');
    assert.ok(service.volumes.includes('${HISTORY_CATALOGUE:-./docker/empty-import}:/import/catalogue:ro'));
    assert.ok(service.volumes.includes('${HISTORY_LEDGER_DB:-./docker/empty-import}:/import/ledger.db:ro'));
    assert.ok(service.volumes.includes('${HISTORY_TX_DB:-./docker/empty-import}:/import/transaction.db:ro'));
    assert.ok(existsSync('docker/empty-import'));
  });
});

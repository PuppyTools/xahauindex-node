import { Type } from '@sinclair/typebox';

import { MetaSchema } from './common.js';

export const StatusSchema = Type.Object({
  status: Type.Union([
    Type.Literal('syncing'),
    Type.Literal('live'),
    Type.Literal('degraded'),
  ]),
  snapshot_status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('complete'),
  ]),
  snapshot_ledger: Type.Union([Type.Integer(), Type.Null()]),
  history_start_ledger: Type.Union([Type.Integer(), Type.Null()]),
  backfill_status: Type.Union([
    Type.Literal('idle'),
    Type.Literal('running'),
    Type.Literal('complete'),
  ]),
  backfill_from: Type.Union([Type.Integer(), Type.Null()]),
  backfill_ledger: Type.Union([Type.Integer(), Type.Null()]),
  ledger_index: Type.Integer(),
  network_ledger_index: Type.Union([Type.Integer(), Type.Null()]),
  lag_ledgers: Type.Union([Type.Integer(), Type.Null()]),
  indexed_ledgers: Type.Integer(),
  token_count: Type.Integer(),
  uri_token_count: Type.Integer(),
  issuer_count: Type.Integer(),
  uptime_seconds: Type.Integer(),
});

export const StatusResponseSchema = Type.Object({
  data: StatusSchema,
  meta: MetaSchema,
});

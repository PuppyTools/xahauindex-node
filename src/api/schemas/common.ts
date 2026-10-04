import { Type } from 'typebox';

export const MetaSchema = Type.Object({
  ledger_index: Type.Integer(),
  count: Type.Optional(Type.Integer()),
  page: Type.Optional(Type.Integer()),
  per_page: Type.Optional(Type.Integer()),
  history_start_ledger: Type.Optional(Type.Integer()),
});

export const ErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

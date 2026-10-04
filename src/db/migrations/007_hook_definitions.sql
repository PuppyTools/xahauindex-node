CREATE TABLE hook_definitions (
  hook_hash         TEXT PRIMARY KEY,
  hook_namespace    TEXT,
  hook_on           TEXT,
  hook_on_incoming  TEXT,
  hook_on_outgoing  TEXT,
  hook_can_emit     TEXT,
  hook_name         TEXT,
  hook_api_version  INTEGER,
  parameters_json   TEXT NOT NULL DEFAULT '[]',
  reference_count   INTEGER,
  code_size         INTEGER NOT NULL DEFAULT 0,
  hook_fee          TEXT,
  hook_callback_fee TEXT,
  hook_set_txn_id   TEXT,
  flags             INTEGER,
  first_ledger      INTEGER NOT NULL,
  last_updated      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uri_token_transfers_tx
  ON uri_token_transfers(uri_token_id, tx_hash);

CREATE UNIQUE INDEX IF NOT EXISTS dex_trades_idemp
  ON dex_trades(tx_hash, maker, taker, ledger_index, base_amount, counter_amount);

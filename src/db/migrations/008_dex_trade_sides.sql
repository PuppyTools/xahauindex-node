CREATE INDEX dex_trades_base_time ON dex_trades(base_currency, base_issuer, close_time DESC);
CREATE INDEX dex_trades_counter_time ON dex_trades(counter_currency, counter_issuer, close_time DESC);

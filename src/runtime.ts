export interface Runtime {
  startedAt: number;
  networkLedgerIndex: number | null;
}

export function createRuntime(startedAt = Date.now()): Runtime {
  return {
    startedAt,
    networkLedgerIndex: null,
  };
}

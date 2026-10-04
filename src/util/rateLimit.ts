export function errorTexts(error: unknown): string[] {
  const texts: string[] = [];
  if (error instanceof Error) {
    texts.push(error.message);
    texts.push(error.name);
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown; data?: unknown };
    if (typeof record.name === 'string') {
      texts.push(record.name);
    }
    if (typeof record.data === 'object' && record.data !== null) {
      const data = record.data as { error?: unknown; error_code?: unknown; error_message?: unknown };
      if (typeof data.error === 'string') {
        texts.push(data.error);
      }
      if (typeof data.error_message === 'string') {
        texts.push(data.error_message);
      }
      if (typeof data.error_code === 'number') {
        texts.push(String(data.error_code));
      }
    }
  }
  return texts;
}

export function isRateLimited(error: unknown): boolean {
  return errorTexts(error).some((text) => /tooBusy|rate limit|units quota/i.test(text));
}

const RETRY_IN_MS = /retry in ~?(\d+)\s*ms/i;

export function rateLimitWaitMs(error: unknown, fallbackMs = 10_000): number {
  for (const text of errorTexts(error)) {
    const match = RETRY_IN_MS.exec(text);
    if (match?.[1] !== undefined) {
      const hinted = Number.parseInt(match[1], 10);
      if (Number.isInteger(hinted) && hinted > 0) {
        return Math.min(120_000, hinted + 250);
      }
    }
  }
  return Math.min(120_000, Math.max(1_000, fallbackMs));
}

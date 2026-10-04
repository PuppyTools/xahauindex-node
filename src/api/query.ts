export function parsePage(raw: unknown, fallback = 1): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : fallback;
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return value;
}

export function parsePerPage(raw: unknown, fallback = 20, max = 100): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : fallback;
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(max, value);
}

export function parseBoolQuery(raw: unknown): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true || raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === false || raw === 'false' || raw === '0') {
    return false;
  }
  return undefined;
}

export function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

export function parseLimit(raw: unknown, fallback = 100, max = 500): number {
  const value = parseOptionalInt(raw);
  if (value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(max, value);
}

export function asQuery(query: unknown): Record<string, string | undefined> {
  if (typeof query !== 'object' || query === null) {
    return {};
  }
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

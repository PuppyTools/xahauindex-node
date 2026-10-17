export interface LedgerSpanLike {
  from: number;
  through: number;
}

export function mergeLedgerSpans<T extends LedgerSpanLike>(spans: readonly T[]): Array<{ from: number; through: number }> {
  const valid = spans
    .filter((span) => Number.isInteger(span.from) && Number.isInteger(span.through) && span.from >= 1 && span.through >= span.from)
    .map((span) => ({ from: span.from, through: span.through }))
    .sort((a, b) => a.from - b.from || a.through - b.through);
  const merged: Array<{ from: number; through: number }> = [];
  for (const span of valid) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.through + 1) {
      last.through = Math.max(last.through, span.through);
    } else {
      merged.push(span);
    }
  }
  return merged;
}

export function ledgerGapsBetween(spans: readonly LedgerSpanLike[]): Array<{ from: number; through: number }> {
  const gaps: Array<{ from: number; through: number }> = [];
  for (let index = 1; index < spans.length; index += 1) {
    const prev = spans[index - 1];
    const next = spans[index];
    if (prev === undefined || next === undefined) {
      continue;
    }
    if (next.from > prev.through + 1) {
      gaps.push({ from: prev.through + 1, through: next.from - 1 });
    }
  }
  return gaps;
}

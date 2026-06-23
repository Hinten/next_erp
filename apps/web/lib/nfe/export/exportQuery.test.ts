import { describe, expect, it } from 'vitest';

import { dayBoundsIso, rangeStamp } from './exportQuery';

describe('dayBoundsIso', () => {
  it('maps ms-epoch bounds to UTC ISO strings (matching the stored data_emissao format)', () => {
    const { startIso, endIso } = dayBoundsIso(
      Date.UTC(2026, 4, 1, 3, 0, 0),
      Date.UTC(2026, 4, 31, 2, 59, 59, 999),
    );
    expect(startIso).toBe('2026-05-01T03:00:00.000Z');
    expect(endIso).toBe('2026-05-31T02:59:59.999Z');
  });
});

describe('rangeStamp', () => {
  it('formats a local YYYYMMDD-YYYYMMDD stamp', () => {
    const start = new Date(2026, 4, 1).getTime(); // local
    const end = new Date(2026, 4, 31).getTime();
    expect(rangeStamp(start, end)).toBe('20260501-20260531');
  });
});

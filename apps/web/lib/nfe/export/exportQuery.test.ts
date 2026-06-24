import { describe, expect, it } from 'vitest';

import { rangeStamp } from './exportQuery';

describe('rangeStamp', () => {
  it('formats a local YYYYMMDD-YYYYMMDD stamp', () => {
    const start = new Date(2026, 4, 1).getTime(); // local
    const end = new Date(2026, 4, 31).getTime();
    expect(rangeStamp(start, end)).toBe('20260501-20260531');
  });
});

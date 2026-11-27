import { describe, expect, it } from 'vitest';

import { CorruptWatermarkError, compareStamps, decide, parseWatermark } from './watermark';

const t = (seconds: number, nanoseconds = 0) => ({ seconds, nanoseconds });

describe('compareStamps', () => {
  it('orders by seconds first, then nanoseconds', () => {
    expect(compareStamps(t(10, 999), t(11, 0))).toBeLessThan(0);
    expect(compareStamps(t(11, 0), t(10, 999))).toBeGreaterThan(0);
    expect(compareStamps(t(10, 5), t(10, 6))).toBeLessThan(0);
    expect(compareStamps(t(10, 6), t(10, 6))).toBe(0);
  });

  it('keeps a one-nanosecond difference distinct (the fold must not round)', () => {
    // Near-miss: Firestore commit times are µs-resolution inside ns fields, and two
    // writes in one second differ only below the second. A compare that folded to
    // seconds or milliseconds would call these equal and let the older one win.
    expect(compareStamps(t(10, 1), t(10, 0))).toBeGreaterThan(0);
    expect(compareStamps(t(10, 1_000), t(10, 999))).toBeGreaterThan(0);
  });
});

describe('decide', () => {
  it('applies when nothing was applied yet', () => {
    expect(decide({ exists: true, stamp: t(5) }, null)).toBe('apply');
    expect(decide({ exists: false, stamp: t(5) }, null)).toBe('apply');
  });

  it('applies a newer observation and skips an older one', () => {
    const applied = { exists: true, stamp: t(10, 500) };
    expect(decide({ exists: true, stamp: t(10, 501) }, applied)).toBe('apply');
    expect(decide({ exists: true, stamp: t(10, 499) }, applied)).toBe('skip');
  });

  it('applies an EQUAL stamp — the same version seen twice, so the replay can repair it', () => {
    expect(decide({ exists: true, stamp: t(10, 500) }, { exists: true, stamp: t(10, 500) })).toBe(
      'apply',
    );
  });

  it('lets a late re-read of a deleted doc win over the older version, and not vice versa', () => {
    // The delete was observed at readTime 20. An invocation that read the
    // t=15 version earlier but commits later must not resurrect the doc.
    const deleted = { exists: false, stamp: t(20) };
    expect(decide({ exists: true, stamp: t(15) }, deleted)).toBe('skip');
    // ...while a re-create after the delete (updateTime 25 > readTime 20) applies.
    expect(decide({ exists: true, stamp: t(25) }, deleted)).toBe('apply');
  });
});

describe('parseWatermark', () => {
  it('reads what the mirror writes', () => {
    expect(parseWatermark('a/b', { path: 'a/b', exists: true, stamp: t(3, 4) })).toEqual({
      exists: true,
      stamp: t(3, 4),
    });
  });

  it('treats a missing document as "nothing applied"', () => {
    expect(parseWatermark('a/b', undefined)).toBeNull();
  });

  it.each([
    ['null', null],
    ['no exists', { stamp: t(1) }],
    ['string stamp', { exists: true, stamp: '2026-01-01' }],
    ['fractional seconds', { exists: true, stamp: { seconds: 1.5, nanoseconds: 0 } }],
  ])('refuses a watermark it did not write (%s)', (_label, data) => {
    expect(() => parseWatermark('a/b', data)).toThrow(CorruptWatermarkError);
  });
});

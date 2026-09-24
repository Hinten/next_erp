import { describe, expect, it } from 'vitest';
import { millisSinceEpoch } from './datetime';
import { expiraEmApos, ttlExpiry } from './ttl';

/** Shaped like `firebase-admin`'s and `firebase/firestore`'s `Timestamp` alike. */
function fakeTimestamp(ms: number) {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

describe('ttlExpiry', () => {
  const schema = ttlExpiry().nullable().optional();

  // What a writer stamps: the SAME Date instance must come out, because the SDK
  // only stores a Timestamp when it receives a Date — a copy would be fine, a
  // number (what millisSinceEpoch would return) would be a TTL that never fires.
  it('passes a Date through as the same instance', () => {
    const d = new Date(Date.UTC(2027, 0, 1));
    expect(schema.parse(d)).toBe(d);
  });

  // What a read returns, from either SDK. Duck-typed: packages/schemas depends on
  // neither SDK, and the two ship different Timestamp classes.
  it('passes a Firestore Timestamp through as the same object', () => {
    const ts = fakeTimestamp(1_800_000_000_123);
    expect(schema.parse(ts)).toBe(ts);
  });

  it('accepts absent and null (rows that must never expire carry no stamp)', () => {
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse(null)).toBeNull();
  });

  // The near-misses: every one of these is ACCEPTED by millisSinceEpoch, and a
  // TTL policy silently ignores all of them. Rejecting them is the helper's job.
  it.each([
    ['a millisecond number', 1_800_000_000_000],
    ['an ISO string', '2027-01-01T00:00:00.000Z'],
  ])('rejects %s, which millisSinceEpoch would accept', (_label, value) => {
    expect(millisSinceEpoch().safeParse(value).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['an Invalid Date', new Date(Number.NaN)],
    ['an empty object', {}],
    ['a toMillis-only object', { toMillis: () => 1 }],
    ['a seconds/nanoseconds pair with no toMillis', { seconds: 1, nanoseconds: 0 }],
  ])('rejects %s', (_label, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('expiraEmApos', () => {
  it('adds whole days to the given instant', () => {
    const agora = Date.UTC(2026, 8, 24, 13, 30, 0);
    expect(expiraEmApos(agora, 30).toISOString()).toBe('2026-10-24T13:30:00.000Z');
    expect(expiraEmApos(agora, 365).toISOString()).toBe('2027-09-24T13:30:00.000Z');
  });

  it('is pure: the same instant always yields the same expiry', () => {
    const agora = 1_790_000_000_000;
    expect(expiraEmApos(agora, 180).getTime()).toBe(expiraEmApos(agora, 180).getTime());
  });

  it.each([
    ['NaN clock', Number.NaN, 30],
    ['zero days', 1_790_000_000_000, 0],
    ['negative days', 1_790_000_000_000, -1],
    ['fractional days', 1_790_000_000_000, 1.5],
  ])('throws on %s', (_label, agora, dias) => {
    expect(() => expiraEmApos(agora, dias)).toThrow(RangeError);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MICROS_LOWER_BOUND,
  MILLIS_UPPER_BOUND,
  coerceToMicros,
  coerceToMillis,
  dataCivilNoFuso,
  dateToMicros,
  dateToMillis,
  fimDoDiaNoFuso,
  formatIsoNoFuso,
  microsToDate,
  microsToMillis,
  millisToDate,
  millisToMicros,
  nowMicros,
  nowMillis,
  parseIsoToMicros,
  somarDiasCivis,
} from './index';

describe('now*', () => {
  it('nowMillis ≈ Date.now()', () => {
    expect(Math.abs(nowMillis() - Date.now())).toBeLessThan(50);
  });

  it('nowMicros is millisecond precision in microsecond units', () => {
    const us = nowMicros();
    expect(us % 1000).toBe(0); // low three digits always zero
    expect(Math.abs(microsToMillis(us) - Date.now())).toBeLessThan(50);
  });
});

describe('unit conversions', () => {
  it('millisToMicros / microsToMillis round-trip', () => {
    expect(millisToMicros(1_700_000_000_000)).toBe(1_700_000_000_000_000);
    expect(microsToMillis(1_700_000_000_000_000)).toBe(1_700_000_000_000);
  });

  it('microsToMillis truncates sub-millisecond digits', () => {
    expect(microsToMillis(1_700_000_000_000_999)).toBe(1_700_000_000_000);
  });
});

describe('Date interop', () => {
  it('round-trips through a Date in both units', () => {
    const d = new Date('2026-06-16T12:00:00.000Z');
    expect(dateToMillis(d)).toBe(d.getTime());
    expect(dateToMicros(d)).toBe(d.getTime() * 1000);
    expect(millisToDate(d.getTime()).getTime()).toBe(d.getTime());
    expect(microsToDate(d.getTime() * 1000).getTime()).toBe(d.getTime());
  });
});

describe('coerceToMicros', () => {
  const ms = 1_700_000_000_000; // ~2023 — a real millisecond timestamp
  const us = ms * 1000;

  it('scales a millisecond number to microseconds', () => {
    expect(coerceToMicros(ms)).toBe(us);
  });

  it('leaves a microsecond number unchanged (idempotent re-run)', () => {
    expect(coerceToMicros(us)).toBe(us);
  });

  // NOTE: asserted against LITERAL microsecond values, never `Date.parse(iso) * 1000`.
  // That expectation form is a tautology — it restates the very truncation this
  // parser exists to avoid, so it would keep passing if the bug came back.
  it('parses an ISO-8601 string (legacy pagamento)', () => {
    expect(coerceToMicros('2026-06-16T12:00:00.000Z')).toBe(1_781_611_200_000_000);
  });

  it('reads a Date', () => {
    const d = new Date('2026-06-16T12:00:00.000Z');
    expect(coerceToMicros(d)).toBe(d.getTime() * 1000);
  });

  it('returns null for null / undefined / NaN / garbage / dead-zone / object', () => {
    expect(coerceToMicros(null)).toBeNull();
    expect(coerceToMicros(undefined)).toBeNull();
    expect(coerceToMicros(Number.NaN)).toBeNull();
    expect(coerceToMicros('not a date')).toBeNull();
    expect(coerceToMicros(5e13)).toBeNull(); // between the two bounds — undeterminable
    expect(coerceToMicros({})).toBeNull();
  });
});

describe('coerceToMillis', () => {
  const ms = 1_700_000_000_000;
  const us = ms * 1000;

  it('leaves a millisecond number unchanged', () => {
    expect(coerceToMillis(ms)).toBe(ms);
  });

  it('scales a microsecond number down to milliseconds', () => {
    expect(coerceToMillis(us)).toBe(ms);
  });

  it('parses ISO strings and Dates', () => {
    expect(coerceToMillis('2026-06-16T12:00:00.000Z')).toBe(1_781_611_200_000);
    expect(coerceToMillis(new Date('2026-06-16T12:00:00.000Z'))).toBe(1_781_611_200_000);
  });

  it('truncates sub-millisecond digits rather than rounding them up', () => {
    expect(coerceToMillis('2026-06-16T12:00:00.999999Z')).toBe(1_781_611_200_999);
  });

  it('returns null in the undeterminable gap', () => {
    expect(coerceToMillis(5e13)).toBeNull();
  });
});

/**
 * The regression suite for the Loja Integrada stale-overwrite defect.
 *
 * `Date.parse` returns milliseconds, so a provider's sub-millisecond digits were
 * destroyed at the boundary and `coerceToMicros` then refilled them with zeros —
 * making the loss invisible. Two order updates less than a millisecond apart
 * collapsed onto byte-identical stamps, a freshness guard could not order them,
 * and the stale payload won.
 *
 * Every literal below is an absolute instant, so these assertions are
 * independent of the host timezone (`apps/nfe` runs TZ=America/Sao_Paulo while
 * every other backend is UTC).
 */
describe('ISO parsing keeps the precision the provider sent', () => {
  const NOON_UTC_US = 1_781_611_200_000_000; // 2026-06-16T12:00:00Z

  it('preserves microseconds — the defect this parser exists to fix', () => {
    expect(coerceToMicros('2026-06-16T12:00:00.123456Z')).toBe(NOON_UTC_US + 123_456);
  });

  it('right-pads a short fraction (.5 is 500000µs, not 5µs)', () => {
    expect(coerceToMicros('2026-06-16T12:00:00.5Z')).toBe(NOON_UTC_US + 500_000);
    expect(coerceToMicros('2026-06-16T12:00:00.12Z')).toBe(NOON_UTC_US + 120_000);
  });

  it('omits the fraction entirely when it is zero (DRF isoformat does this)', () => {
    expect(coerceToMicros('2026-06-16T12:00:00Z')).toBe(NOON_UTC_US);
  });

  it('truncates finer-than-microsecond digits rather than rounding', () => {
    // A rounding implementation would give …123500 here. That is the discriminator.
    expect(coerceToMicros('2026-06-16T12:00:00.1234999Z')).toBe(NOON_UTC_US + 123_499);
    expect(coerceToMicros('2026-06-16T12:00:00.123456789Z')).toBe(NOON_UTC_US + 123_456);
  });

  it('accepts the ISO comma decimal separator (Date.parse returns NaN for it)', () => {
    expect(Number.isNaN(Date.parse('2026-06-16T12:00:00,123456Z'))).toBe(true);
    expect(coerceToMicros('2026-06-16T12:00:00,123456Z')).toBe(NOON_UTC_US + 123_456);
  });

  it('honours an explicit offset — and does NOT silently discard it', () => {
    // Guards the ordering inside parseIsoInstantNs: PlainDateTime.from() SUCCEEDS
    // on this string while ignoring the -03:00, which would land the instant three
    // hours early. Instant.from() must therefore be attempted first.
    expect(coerceToMicros('2026-06-16T09:00:00.123456-03:00')).toBe(NOON_UTC_US + 123_456);
    expect(coerceToMicros('2026-06-16T09:00:00.123456-0300')).toBe(NOON_UTC_US + 123_456);
  });

  it('resolves an offset-less string as UTC, never as host-local time', () => {
    // Django REST Framework with USE_TZ=False emits exactly this shape. The old
    // Date.parse path read it in the process timezone, so the same payload landed
    // three hours apart in apps/nfe (TZ=America/Sao_Paulo) versus every other
    // backend. Asserting equality with the Z form pins the host-independence.
    expect(coerceToMicros('2026-06-16T12:00:00')).toBe(NOON_UTC_US);
    expect(coerceToMicros('2026-06-16T12:00:00.123456')).toBe(NOON_UTC_US + 123_456);
  });

  it('reads a date-only string as UTC midnight (unchanged from Date.parse)', () => {
    expect(coerceToMicros('2026-06-16')).toBe(1_781_568_000_000_000);
  });

  it('gets pre-epoch instants right (the fraction is not a negative offset)', () => {
    // Naïve arithmetic — truncated second plus a positive fraction — yields
    // -1_000_500_000 here. BigInt division on epochNanoseconds cannot make that mistake.
    expect(coerceToMicros('1969-12-31T23:59:59.5Z')).toBe(-500_000);
    expect(coerceToMillis('1969-12-31T23:59:59.5Z')).toBe(-500);
  });

  it('refuses non-ISO human formats that Date.parse accepted (documented narrowing)', () => {
    expect(Number.isNaN(Date.parse('June 16, 2026'))).toBe(false);
    expect(coerceToMicros('June 16, 2026')).toBeNull();
  });

  it('refuses an instant too far from the epoch to hold exactly', () => {
    expect(coerceToMicros('9999-12-31T00:00:00Z')).toBeNull();
  });
});

describe('safe-integer headroom', () => {
  it('microseconds since epoch stays a safe integer well past 2100', () => {
    const us2100 = dateToMicros(new Date('2100-01-01T00:00:00.000Z'));
    expect(us2100).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(us2100)).toBe(true);
  });

  it('the unit bounds leave an undeterminable gap', () => {
    expect(MILLIS_UPPER_BOUND).toBeLessThan(MICROS_LOWER_BOUND);
  });

  it('scaling the largest classifiable millisecond value to µs stays safe', () => {
    // The cap exists so ms × 1000 never overflows Number.MAX_SAFE_INTEGER.
    expect(MILLIS_UPPER_BOUND * 1000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('refuses a millisecond value large enough to overflow µs (no silent precision loss)', () => {
    const farFutureMs = 1.05e13; // ~year 2302 in ms — above the cap
    expect(farFutureMs * 1000).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(coerceToMicros(farFutureMs)).toBeNull();
  });
});

/**
 * Civil time in an explicit zone. Every expected value is an absolute instant built
 * with `Date.UTC` (or a literal string), so nothing here depends on the host's
 * timezone, and the zone is always passed — never read from the environment.
 */
const SAO_PAULO = 'America/Sao_Paulo';

describe('formatIsoNoFuso', () => {
  it('prints the instant in the zone with a numeric offset and milliseconds, never Z', () => {
    const out = formatIsoNoFuso(Date.UTC(2026, 8, 30, 2, 59, 59, 0), SAO_PAULO);
    expect(out).toBe('2026-09-29T23:59:59.000-03:00');
    expect(out.endsWith('Z')).toBe(false);
  });

  it('keeps the milliseconds', () => {
    expect(formatIsoNoFuso(Date.UTC(2026, 8, 30, 2, 59, 59, 123), SAO_PAULO)).toBe(
      '2026-09-29T23:59:59.123-03:00',
    );
  });

  it('takes the offset from the instant, not a constant: DST era -02:00, winter -03:00', () => {
    // Brazil observed daylight saving from 2018-11-04 to 2019-02-17.
    expect(formatIsoNoFuso(Date.UTC(2018, 11, 1, 14, 0, 0, 0), SAO_PAULO)).toBe(
      '2018-12-01T12:00:00.000-02:00',
    );
    // Near-miss: the same zone six months earlier, and a later summer without DST.
    expect(formatIsoNoFuso(Date.UTC(2018, 5, 1, 15, 0, 0, 0), SAO_PAULO)).toBe(
      '2018-06-01T12:00:00.000-03:00',
    );
    expect(formatIsoNoFuso(Date.UTC(2026, 11, 1, 15, 0, 0, 0), SAO_PAULO)).toBe(
      '2026-12-01T12:00:00.000-03:00',
    );
  });

  it('honours the zone it is given (a half-hour offset, and UTC as +00:00 rather than Z)', () => {
    expect(formatIsoNoFuso(Date.UTC(2026, 0, 1, 0, 0, 0, 0), 'Asia/Kolkata')).toBe(
      '2026-01-01T05:30:00.000+05:30',
    );
    expect(formatIsoNoFuso(Date.UTC(2026, 0, 1, 0, 0, 0, 0), 'UTC')).toBe(
      '2026-01-01T00:00:00.000+00:00',
    );
  });

  it('names the same instant it was given (parsing the string round-trips)', () => {
    const instantes = [
      Date.UTC(2026, 8, 30, 2, 59, 59, 0),
      Date.UTC(2018, 11, 1, 14, 0, 0, 0),
      Date.UTC(2026, 0, 1, 0, 0, 0, 1),
    ];
    for (const ms of instantes) {
      expect(parseIsoToMicros(formatIsoNoFuso(ms, SAO_PAULO))).toBe(ms * 1000);
    }
  });

  it('throws RangeError for an unknown zone rather than guessing one', () => {
    expect(() => formatIsoNoFuso(Date.UTC(2026, 8, 30), 'Not/AZone')).toThrow(RangeError);
  });
});

describe('fimDoDiaNoFuso', () => {
  it('is 23:59:59.000 of that civil day in the zone', () => {
    const fim = fimDoDiaNoFuso('2026-09-30', SAO_PAULO);
    expect(fim).toBe(Date.UTC(2026, 9, 1, 2, 59, 59, 0));
    expect(formatIsoNoFuso(fim ?? 0, SAO_PAULO)).toBe('2026-09-30T23:59:59.000-03:00');
  });

  it('follows the zone: the same civil day ends three hours sooner in UTC than in São Paulo', () => {
    expect(fimDoDiaNoFuso('2026-09-30', 'UTC')).toBe(Date.UTC(2026, 8, 30, 23, 59, 59, 0));
  });

  it('picks the EARLIER occurrence when the zone repeats that wall time (DST fall-back)', () => {
    // São Paulo's clocks went back at 00:00 on 2019-02-17, so 23:00-23:59 of the 16th
    // happened twice: first at -02:00, then at -03:00. The deadline must not run late.
    expect(fimDoDiaNoFuso('2019-02-16', SAO_PAULO)).toBe(Date.UTC(2019, 1, 17, 1, 59, 59, 0));
  });

  it('uses the offset in force that day (a DST-era day ends one hour earlier in UTC)', () => {
    // 23:59:59-02:00 is 01:59:59Z the next day; a hard-coded -03:00 gives 02:59:59Z.
    expect(fimDoDiaNoFuso('2018-12-01', SAO_PAULO)).toBe(Date.UTC(2018, 11, 2, 1, 59, 59, 0));
  });

  it('returns null for an impossible day instead of clamping it (overflow reject)', () => {
    // The ISO string parser itself rejects 02-30 (overflow is irrelevant for string
    // input), so this pins the null contract, not the `overflow: 'reject'` option.
    expect(fimDoDiaNoFuso('2026-02-30', SAO_PAULO)).toBeNull();
    expect(fimDoDiaNoFuso('2026-04-31', SAO_PAULO)).toBeNull();
    expect(fimDoDiaNoFuso('2026-02-29', SAO_PAULO)).toBeNull();
    expect(fimDoDiaNoFuso('2026-13-01', SAO_PAULO)).toBeNull();
    expect(fimDoDiaNoFuso('2026-00-10', SAO_PAULO)).toBeNull();
    // Near-miss: the same shapes on real days are accepted.
    expect(fimDoDiaNoFuso('2028-02-29', SAO_PAULO)).not.toBeNull();
    expect(fimDoDiaNoFuso('2026-04-30', SAO_PAULO)).not.toBeNull();
  });

  it('returns null for anything that is not exactly YYYY-MM-DD', () => {
    const ruins = ['2026-9-30', '', 'abc', '2026-09-30T10:00:00', ' 2026-09-30', '2026-09-30 '];
    for (const ruim of ruins) {
      expect(fimDoDiaNoFuso(ruim, SAO_PAULO)).toBeNull();
    }
  });

  it('throws RangeError for an unknown zone on a valid date', () => {
    expect(() => fimDoDiaNoFuso('2026-09-30', 'Not/AZone')).toThrow(RangeError);
  });
});

describe('dataCivilNoFuso', () => {
  it('is the civil day the instant falls on in the zone, not in UTC', () => {
    expect(dataCivilNoFuso(Date.UTC(2026, 8, 28, 2, 30), SAO_PAULO)).toBe('2026-09-27');
    expect(dataCivilNoFuso(Date.UTC(2026, 8, 28, 2, 30), 'UTC')).toBe('2026-09-28');
  });

  it('flips exactly at local midnight', () => {
    expect(dataCivilNoFuso(Date.UTC(2026, 8, 28, 2, 59, 59, 999), SAO_PAULO)).toBe('2026-09-27');
    expect(dataCivilNoFuso(Date.UTC(2026, 8, 28, 3, 0, 0, 0), SAO_PAULO)).toBe('2026-09-28');
  });

  it('crosses month and year boundaries', () => {
    expect(dataCivilNoFuso(Date.UTC(2027, 0, 1, 2, 0), SAO_PAULO)).toBe('2026-12-31');
  });

  it('inverts fimDoDiaNoFuso, and one second later is the next day', () => {
    for (const dia of ['2026-09-30', '2026-12-31', '2028-02-29', '2018-12-01', '2018-11-03']) {
      const fim = fimDoDiaNoFuso(dia, SAO_PAULO);
      expect(fim).not.toBeNull();
      expect(dataCivilNoFuso(fim ?? 0, SAO_PAULO)).toBe(dia);
      expect(dataCivilNoFuso((fim ?? 0) + 1000, SAO_PAULO)).toBe(somarDiasCivis(dia, 1));
    }
  });
});

describe('somarDiasCivis', () => {
  it('does calendar arithmetic across months, years and leap days', () => {
    expect(somarDiasCivis('2026-02-28', 1)).toBe('2026-03-01');
    expect(somarDiasCivis('2028-02-28', 1)).toBe('2028-02-29'); // leap year
    expect(somarDiasCivis('2026-12-31', 1)).toBe('2027-01-01');
    expect(somarDiasCivis('2026-01-31', 30)).toBe('2026-03-02');
    expect(somarDiasCivis('2026-09-29', 3)).toBe('2026-10-02');
  });

  it('subtracts with a negative count and is the identity for 0', () => {
    expect(somarDiasCivis('2026-03-01', -1)).toBe('2026-02-28');
    expect(somarDiasCivis('2026-09-30', 0)).toBe('2026-09-30');
  });

  it('is unaffected by daylight saving (whole calendar days, not 24-hour blocks)', () => {
    // 2018-11-03 -> 2018-11-04 is the São Paulo spring-forward night.
    expect(somarDiasCivis('2018-11-03', 1)).toBe('2018-11-04');
    expect(somarDiasCivis('2019-02-16', 2)).toBe('2019-02-18');
  });

  it('returns null for a malformed or impossible date', () => {
    expect(somarDiasCivis('2026-02-30', 1)).toBeNull();
    expect(somarDiasCivis('2026-9-30', 1)).toBeNull();
    expect(somarDiasCivis('', 1)).toBeNull();
    expect(somarDiasCivis('abc', 1)).toBeNull();
    expect(somarDiasCivis('2026-09-30T10:00:00', 1)).toBeNull();
  });

  it('returns null, not an exception, when the day count is unusable', () => {
    expect(somarDiasCivis('2026-09-30', 1.5)).toBeNull();
    expect(somarDiasCivis('2026-09-30', Number.NaN)).toBeNull();
    expect(somarDiasCivis('2026-01-01', 1e9)).toBeNull();
  });

  it('composes into the default link expiry: today + 3 civil days, end of that day', () => {
    // 2026-09-29T02:30Z is still the 28th in São Paulo, so +3 civil days is 10-01.
    const hoje = dataCivilNoFuso(Date.UTC(2026, 8, 29, 2, 30), SAO_PAULO);
    expect(hoje).toBe('2026-09-28');
    const expira = somarDiasCivis(hoje, 3);
    expect(expira).toBe('2026-10-01');
    expect(fimDoDiaNoFuso(expira ?? '', SAO_PAULO)).toBe(Date.UTC(2026, 9, 2, 2, 59, 59, 0));
  });
});

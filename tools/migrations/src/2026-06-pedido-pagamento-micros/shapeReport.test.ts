import { describe, expect, it } from 'vitest';
import { classify, emptyStats, formatReport, record } from './shapeReport';

const MS = 1_781_611_200_000; // 2026-06-16T12:00:00Z
const US_PADDED = MS * 1000; // …000 — no information below the millisecond
const US_REAL = US_PADDED + 123_456; // carries a genuine sub-millisecond fraction

describe('classify', () => {
  it('buckets the shapes the corpus actually holds', () => {
    expect(classify(null)).toBe('ausente');
    expect(classify(MS)).toBe('millis');
    expect(classify(US_PADDED)).toBe('micros');
    expect(classify('2026-06-16T12:00:00.000Z')).toBe('iso-string');
    expect(classify('nao e uma data')).toBe('string-invalida');
    expect(classify(5e13)).toBe('zona-morta');
  });

  it('flags a Timestamp as blocking — coerceToMicros refuses it', () => {
    expect(classify({ seconds: 1, nanoseconds: 0 })).toBe('timestamp-ou-outro');
  });
});

/**
 * The precision census. This is the question the migration's README used to
 * answer wrongly: are these microseconds carrying information, or are they
 * `ms × 1000` padding? A field that is 100% padded gains nothing from being
 * stored in microseconds.
 */
describe('padded vs real microseconds', () => {
  it('counts a ms value scaled up as PADDING, not as precision', () => {
    const s = emptyStats();
    record(s, MS);
    expect(s.microsPadded).toBe(1);
    expect(s.microsReais).toBe(0);
  });

  it('counts an already-padded µs value as PADDING', () => {
    const s = emptyStats();
    record(s, US_PADDED);
    expect(s.microsPadded).toBe(1);
    expect(s.microsReais).toBe(0);
  });

  it('counts a genuine sub-millisecond µs value as REAL', () => {
    const s = emptyStats();
    record(s, US_REAL);
    expect(s.microsReais).toBe(1);
    expect(s.microsPadded).toBe(0);
  });

  it('sees provider precision through an ISO string — the parser fix flowing through', () => {
    // Before the ISO parser was fixed this arrived as …123000 and would have
    // been counted as padding, hiding the fact that the provider sent precision.
    const s = emptyStats();
    record(s, '2026-06-16T12:00:00.123456Z');
    expect(s.microsReais).toBe(1);
    expect(s.microsPadded).toBe(0);
  });

  it('still counts a zero-fraction ISO string as padding', () => {
    const s = emptyStats();
    record(s, '2026-06-16T12:00:00.000Z');
    expect(s.microsPadded).toBe(1);
    expect(s.microsReais).toBe(0);
  });

  it('never counts an unconvertible value in either bucket', () => {
    const s = emptyStats();
    record(s, 'nao e uma data');
    record(s, 5e13); // the undeterminable gap
    record(s, null);
    expect(s.microsPadded).toBe(0);
    expect(s.microsReais).toBe(0);
  });
});

describe('formatReport', () => {
  it('labels an all-padded field PADDING and a mixed one REAL', () => {
    const self = emptyStats();
    record(self, MS);
    record(self, US_PADDED);

    const provider = emptyStats();
    record(provider, US_REAL);
    record(provider, US_PADDED);

    const out = formatReport(
      new Map([
        ['pedidos.dtImpressao', self],
        ['pedidos.ultimaModificacao', provider],
      ]),
    );

    expect(out).toContain('µs=PADDING (2/2 end in 000)');
    expect(out).toContain('µs=REAL (1/2 sub-ms)');
  });

  it('keeps the precision census OUT of the blocking verdict', () => {
    // Padding is informational, never a reason to stop a run — only an
    // unclassifiable value is.
    const s = emptyStats();
    record(s, MS);
    const out = formatReport(new Map([['pedidos.timestamp', s]]));
    expect(out).toContain('OK —');
    expect(out).not.toContain('STOP');
  });

  it('still stops on a value coerceToMicros refuses', () => {
    const s = emptyStats();
    record(s, { seconds: 1, nanoseconds: 0 });
    const out = formatReport(new Map([['pedidos.timestamp', s]]));
    expect(out).toContain('STOP');
  });
});

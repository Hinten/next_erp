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

  it('splits ISO strings on whether they carry a zone', () => {
    // What Dart's toIso8601String() emits for a local DateTime — read as UTC.
    expect(classify('2024-05-01T00:00:00.000')).toBe('iso-sem-fuso');
    expect(classify('2024-05-01T00:00')).toBe('iso-sem-fuso');
    // Date-only: the trailing `-01` is the day, not a `-01` offset.
    expect(classify('2024-05-01')).toBe('iso-sem-fuso');
    // Near-misses: an explicit zone is read exactly and stays `iso-string`.
    expect(classify('2024-05-01T00:00:00.000Z')).toBe('iso-string');
    expect(classify('2024-05-01T00:00:00-03:00')).toBe('iso-string');
  });

  it('asks the converter, not Date.parse — so it agrees with --apply in both directions', () => {
    // Date.parse accepts these; coerceToMicros refuses them, so --apply SKIPS them.
    expect(classify('June 16, 2026')).toBe('string-invalida');
    expect(classify('2024/05/01')).toBe('string-invalida');
    expect(classify('Mon Jun 16 2026 00:00:00 GMT-0300')).toBe('string-invalida');
    // Date.parse refuses these; coerceToMicros converts them, zone and all.
    expect(classify('2026-06-16T12:00:00,5Z')).toBe('iso-string');
    expect(classify('2026-06-16T12:00:00-03')).toBe('iso-string');
    expect(classify('2026-06-16T12:00:00+03:00[America/Sao_Paulo]')).toBe('iso-string');
    // Near-miss: an annotation is not an offset — without one the value still reads as UTC.
    expect(classify('2026-06-16T12:00:00[America/Sao_Paulo]')).toBe('iso-sem-fuso');
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

  it('flags offset-less ISO fields with a CHECK — outside the verdict', () => {
    const cheque = emptyStats();
    record(cheque, '2024-05-01T00:00:00.000');
    record(cheque, null);
    const out = formatReport(new Map([['pagamentos.cheque.bomPara', cheque]]));
    expect(out).toContain('iso-sem-fuso=1');
    expect(out).toMatch(/CHECK: .*pagamentos\.cheque\.bomPara/);
    // It converts fine — possibly to the wrong instant — so it never stops a run.
    expect(out).toContain('OK —');
    expect(out).not.toContain('STOP');
  });

  it('scopes the verdict to fields --apply converts — a report-only refusal is a CHECK', () => {
    const TIMESTAMP = { seconds: 1, nanoseconds: 0 };

    const bomPara = emptyStats(true);
    record(bomPara, TIMESTAMP);
    const out = formatReport(new Map([['pagamentos.cheque.bomPara', bomPara]]));
    expect(out).toContain('(report-only)');
    expect(out).toMatch(/CHECK: report-only .*pagamentos\.cheque\.bomPara/);
    expect(out).toContain('OK —');
    expect(out).not.toContain('STOP');

    // Near-miss: the SAME value in a field the backfill converts still stops the run.
    const vencimento = emptyStats();
    record(vencimento, TIMESTAMP);
    const ambos = formatReport(
      new Map([
        ['pagamentos.cheque.bomPara', bomPara],
        ['pagamentos.vencimento', vencimento],
      ]),
    );
    expect(ambos).toContain('STOP: 1 value(s)');
  });

  it('raises no CHECK when every ISO string carries its zone', () => {
    const s = emptyStats();
    record(s, '2026-06-16T12:00:00.000Z');
    record(s, '2026-06-16T09:00:00.000-03:00');
    const out = formatReport(new Map([['pagamentos.vencimento', s]]));
    expect(out).toContain('iso-string=2');
    expect(out).not.toContain('CHECK');
  });
});

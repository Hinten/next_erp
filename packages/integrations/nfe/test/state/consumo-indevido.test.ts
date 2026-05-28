/**
 * Unit smoke for the Consumo Indevido Shield helper. Live tests in the
 * homologação suite exercise it against real SEFAZ; this file pins the
 * three properties the CI report step + the test code depend on:
 *
 *   1. The error message ALWAYS contains the `[CONSUMO_INDEVIDO_SHIELD]`
 *      marker so `report-consumo-indevido` can grep job logs reliably.
 *   2. `assertNotConsumoIndevido` throws on cStat=656 and is a no-op
 *      on every other cStat (paralisado, duplicidade, rejection, ok).
 *   3. The thrown error is an `instanceof NFeConsumoIndevidoError` so
 *      test code can narrow via `instanceof` (per CLAUDE.md rule #6).
 */
import { describe, expect, it } from 'vitest';

import {
  CONSUMO_INDEVIDO_MARKER,
  NFeConsumoIndevidoError,
  assertNotConsumoIndevido,
} from '../../src/state';

describe('Consumo Indevido Shield', () => {
  it('error message starts with the marker prefix', () => {
    const err = new NFeConsumoIndevidoError({
      cStat: '656',
      xMotivo: 'Consumo Indevido',
      source: 'unit-smoke',
    });
    expect(err.message.startsWith(CONSUMO_INDEVIDO_MARKER)).toBe(true);
    expect(err.message).toContain('cStat=656');
    expect(err.message).toContain('Consumo Indevido');
    expect(err.message).toContain('unit-smoke');
  });

  it('assertNotConsumoIndevido throws on cStat=656', () => {
    expect(() =>
      assertNotConsumoIndevido({ cStat: '656', xMotivo: 'Consumo Indevido' }, 'autorizarLote'),
    ).toThrow(NFeConsumoIndevidoError);
  });

  it('assertNotConsumoIndevido is a no-op for non-656 cStats', () => {
    const ok = ['100', '103', '107', '108', '204', '539', '215'];
    for (const cStat of ok) {
      expect(() =>
        assertNotConsumoIndevido({ cStat, xMotivo: 'whatever' }, 'autorizarLote'),
      ).not.toThrow();
    }
  });

  it('thrown error narrows via instanceof', () => {
    try {
      assertNotConsumoIndevido({ cStat: '656', xMotivo: 'x' }, 'x');
    } catch (err) {
      expect(err instanceof NFeConsumoIndevidoError).toBe(true);
      if (err instanceof NFeConsumoIndevidoError) {
        expect(err.cStat).toBe('656');
        expect(err.source).toBe('x');
      }
    }
  });
});

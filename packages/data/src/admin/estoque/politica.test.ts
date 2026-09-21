import { describe, expect, it } from 'vitest';

import { deveEnviarFamiliaCore, ESTOQUE_MIN } from './politica';

/**
 * The send policy, promoted from Mercado Livre (#1520 step 12, R9).
 *
 * Ported from the `deveEnviarFamilia` slice of
 * `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.test.ts` with the
 * same inputs and the same expected answers — ML's suite stays byte-unedited, so
 * the two together are the behaviour-parity proof. The one signature change is
 * that `limiar` arrives as a PARAMETER instead of `limiarEstoqueAlto()`, so the
 * threshold is supplied explicitly on every call below rather than read from an
 * ambient env var.
 */

/** ML's `MERCADO_LIVRE_STOCK_LIMIAR_ALTO` default, supplied as a parameter here. */
const LIMIAR = 100;

const mapa = (entries: Array<[string, number]>) => new Map(entries);

describe('ESTOQUE_MIN', () => {
  it('is the pure code constant 0 — the lower clamp, not a tunable', () => {
    expect(ESTOQUE_MIN).toBe(0);
  });
});

describe('deveEnviarFamiliaCore — the high-stock rule and its guard', () => {
  it('⚠️ PAIR: 110 → 95 SENDS on the incremental tier; NEAR-MISS: 200 → 199 does not', () => {
    // THE crossing guard. The rule is `min(anterior, atual) <= limiar`, never
    // `atual` alone: gating on the current value would skip exactly the movement
    // that walks a listing INTO the danger zone, and the next sale oversells.
    // The near-miss is the movement that genuinely is not worth the fast lane —
    // if both come out the same, the min has been "simplified" away.
    expect(deveEnviarFamiliaCore(mapa([['PROD', 95]]), mapa([['PROD', 110]]), true, LIMIAR)).toBe(
      true,
    );
    expect(deveEnviarFamiliaCore(mapa([['PROD', 199]]), mapa([['PROD', 200]]), true, LIMIAR)).toBe(
      false,
    );
  });

  it('the guard is symmetric: 95 → 110 sends too', () => {
    expect(deveEnviarFamiliaCore(mapa([['PROD', 110]]), mapa([['PROD', 95]]), true, LIMIAR)).toBe(
      true,
    );
  });

  it('the threshold is STRICT — landing exactly on it still sends', () => {
    // "Skip while min(...) > limiar", so a value EQUAL to the threshold is
    // inside the danger zone, not outside it.
    expect(deveEnviarFamiliaCore(mapa([['PROD', 100]]), mapa([['PROD', 101]]), true, LIMIAR)).toBe(
      true,
    );
  });

  it('⚠️ the DAILY tier ignores the high-stock arm entirely — any change is enough', () => {
    const atuais = mapa([['PROD', 199]]);
    const anteriores = mapa([['PROD', 200]]);
    expect(deveEnviarFamiliaCore(atuais, anteriores, true, LIMIAR)).toBe(false);
    expect(deveEnviarFamiliaCore(atuais, anteriores, false, LIMIAR)).toBe(true);
    // …and the threshold cannot rescue a daily send, however high it is set.
    expect(deveEnviarFamiliaCore(atuais, anteriores, false, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('the threshold comes from the PARAMETER, so a channel can move it per tier', () => {
    const atuais = mapa([['PROD', 40]]);
    const anteriores = mapa([['PROD', 41]]);
    expect(deveEnviarFamiliaCore(atuais, anteriores, true, 100)).toBe(true); // 40 <= 100 ⇒ sends
    expect(deveEnviarFamiliaCore(atuais, anteriores, true, 10)).toBe(false); // now comfortably high
  });

  it('one LOW sibling justifies the whole send even when another is high', () => {
    expect(
      deveEnviarFamiliaCore(
        mapa([
          ['PROD', 999],
          ['CH1', 3],
        ]),
        mapa([
          ['PROD', 1000],
          ['CH1', 4],
        ]),
        true,
        LIMIAR,
      ),
    ).toBe(true);
  });
});

describe('deveEnviarFamiliaCore — failing OPEN', () => {
  it('a NULL baseline sends (the first sweep after deploy)', () => {
    expect(deveEnviarFamiliaCore(mapa([['PROD', 8]]), null, true, LIMIAR)).toBe(true);
  });

  it('⚠️ an UNKNOWN member sends — PAIR: absent from the baseline ⇒ send; NEAR-MISS: present and equal ⇒ no send', () => {
    // This is the consuming half of `quantidadesAnterioresCore`'s omission
    // contract: the member is left OUT of the baseline precisely so this returns
    // true. A fallback that put the current value there instead would land on
    // the near-miss below, which is a silent drop.
    expect(deveEnviarFamiliaCore(mapa([['PROD', 8]]), new Map(), true, LIMIAR)).toBe(true);
    expect(deveEnviarFamiliaCore(mapa([['PROD', 8]]), mapa([['PROD', 8]]), true, LIMIAR)).toBe(
      false,
    );
  });

  it('unchanged everywhere ⇒ no send, on either tier', () => {
    const iguais = mapa([
      ['PROD', 8],
      ['CH1', 3],
    ]);
    expect(deveEnviarFamiliaCore(iguais, mapa([...iguais]), true, LIMIAR)).toBe(false);
    expect(deveEnviarFamiliaCore(iguais, mapa([...iguais]), false, LIMIAR)).toBe(false);
  });

  it('nothing to send at all ⇒ skip', () => {
    expect(deveEnviarFamiliaCore(new Map(), new Map(), true, LIMIAR)).toBe(false);
  });
});

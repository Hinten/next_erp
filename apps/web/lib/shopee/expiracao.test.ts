import { describe, expect, it } from 'vitest';

import { corExpiracaoAutorizacao, textoExpiracaoAutorizacao } from './expiracao';

/**
 * The badge is a fold: many day counts collapse onto four colours and four
 * sentences. A test that the fold APPLIES cannot show where it STOPS, so every
 * threshold below is asserted as a PAIR — two values that must come out the
 * same, and the near miss one step away that must stay distinct.
 *
 * ⚠️ Without the near misses a single `>=` slip moves the day the badge changes
 * colour and nothing fails: the operator simply learns about a lapsing
 * authorization one day later than the design intended, which on a 7-day consent
 * is most of the warning.
 */

describe('corExpiracaoAutorizacao — the boundaries', () => {
  it('31 is green and 30 is yellow — the near miss across DIAS_ATENCAO', () => {
    expect(corExpiracaoAutorizacao(31)).toBe('green');
    expect(corExpiracaoAutorizacao(30)).toBe('yellow');
  });

  it('31 and 365 fold to the SAME green — anything beyond a month is not news', () => {
    expect(corExpiracaoAutorizacao(365)).toBe(corExpiracaoAutorizacao(31));
  });

  it('30 and 1 fold to the same yellow, and 0 does NOT', () => {
    // The equal pair and its near miss in one place: the whole 1..30 window is
    // one warning, and the day it runs out is a different verdict.
    expect(corExpiracaoAutorizacao(1)).toBe(corExpiracaoAutorizacao(30));
    expect(corExpiracaoAutorizacao(0)).not.toBe(corExpiracaoAutorizacao(1));
  });

  it('0 is red — today, not "still a day left"', () => {
    // `apps/shopee` floors the division, so the last partial day reads 0. An
    // operator told "1 dia" on the morning it expires would plan for tomorrow.
    expect(corExpiracaoAutorizacao(0)).toBe('red');
  });

  it('-1 is red as well — expired is not a different colour from expiring today', () => {
    expect(corExpiracaoAutorizacao(-1)).toBe('red');
    expect(corExpiracaoAutorizacao(-1)).toBe(corExpiracaoAutorizacao(0));
  });

  it('null is gray — unknown is never green', () => {
    // A conta with no authorization on file (or one this build could not read)
    // must not be painted healthy.
    expect(corExpiracaoAutorizacao(null)).toBe('gray');
    expect(corExpiracaoAutorizacao(null)).not.toBe('green');
  });

  it('⚠️ NaN is gray, not red — a missing verdict is not an expired one', () => {
    expect(corExpiracaoAutorizacao(Number.NaN)).toBe('gray');
  });
});

describe('textoExpiracaoAutorizacao — the words the operator reads', () => {
  it('31 and 30 both count days, and say a DIFFERENT number', () => {
    // The colour folds these together (green/yellow aside, both are "expira em
    // N dias"); the text must not fold them, or the badge would say the same
    // thing for a month and for a day.
    expect(textoExpiracaoAutorizacao(31)).toBe('expira em 31 dias');
    expect(textoExpiracaoAutorizacao(30)).toBe('expira em 30 dias');
    expect(textoExpiracaoAutorizacao(31)).not.toBe(textoExpiracaoAutorizacao(30));
  });

  it('1 is singular — "expira em 1 dia", never "1 dias"', () => {
    expect(textoExpiracaoAutorizacao(1)).toBe('expira em 1 dia');
  });

  it('2 is the near miss on that plural', () => {
    expect(textoExpiracaoAutorizacao(2)).toBe('expira em 2 dias');
  });

  it('0 says TODAY, and -1 says already expired — the two reds stay distinguishable', () => {
    // They share a colour on purpose, so the words are the only thing carrying
    // the difference. Folding them into one sentence would tell an operator a
    // still-usable conta is gone, or the reverse.
    expect(textoExpiracaoAutorizacao(0)).toBe('expira hoje');
    expect(textoExpiracaoAutorizacao(-1)).toBe('autorização expirada');
    expect(textoExpiracaoAutorizacao(0)).not.toBe(textoExpiracaoAutorizacao(-1));
  });

  it('-1 and -400 fold to the same sentence — expired has no degrees', () => {
    expect(textoExpiracaoAutorizacao(-400)).toBe(textoExpiracaoAutorizacao(-1));
  });

  it('null says the expiry is unknown, and does not claim a lapse', () => {
    expect(textoExpiracaoAutorizacao(null)).toBe('expiração desconhecida');
    expect(textoExpiracaoAutorizacao(null)).not.toBe(textoExpiracaoAutorizacao(-1));
  });

  it('⚠️ NaN reads as unknown, never as `expira em NaN dias`', () => {
    expect(textoExpiracaoAutorizacao(Number.NaN)).toBe('expiração desconhecida');
  });

  it('never returns an empty string, for any day count the wire can carry', () => {
    for (const dias of [null, -400, -1, 0, 1, 2, 30, 31, 365]) {
      expect(textoExpiracaoAutorizacao(dias).length).toBeGreaterThan(5);
    }
  });
});

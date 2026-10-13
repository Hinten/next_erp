import { describe, expect, it } from 'vitest';
import { SITUACAO_VALIDADE_TOKEN_LI, situacaoValidadeTokenLi } from '@delfrance/schemas';

import {
  corValidadeLi,
  dataCivilParaExibicao,
  diaEMesNoFuso,
  orientacaoValidadeLi,
  textoValidadeLi,
} from './expiracao';

/**
 * The expiry badge is a fold — many day counts collapse onto three colours and a
 * handful of sentences — so each boundary is asserted as a PAIR: the values that
 * must come out the same, and the near miss one step away that must not.
 */

describe('corValidadeLi — the server verdict, mapped', () => {
  it('ok is green, expirando yellow, vencido red', () => {
    expect(corValidadeLi(SITUACAO_VALIDADE_TOKEN_LI.ok)).toBe('green');
    expect(corValidadeLi(SITUACAO_VALIDADE_TOKEN_LI.expirando)).toBe('yellow');
    expect(corValidadeLi(SITUACAO_VALIDADE_TOKEN_LI.vencido)).toBe('red');
  });

  it('null is gray — unknown is never green', () => {
    expect(corValidadeLi(null)).toBe('gray');
  });

  it('⭐ the shared threshold reaches the colour: 31 days green, 30 yellow; 0 yellow, -1 red', () => {
    // The panel takes the server's verdict, which comes from this very
    // function — so the 30-day warning here and the aviso's can never disagree.
    expect(corValidadeLi(situacaoValidadeTokenLi(31))).toBe('green');
    expect(corValidadeLi(situacaoValidadeTokenLi(30))).toBe('yellow');
    expect(corValidadeLi(situacaoValidadeTokenLi(0))).toBe('yellow');
    expect(corValidadeLi(situacaoValidadeTokenLi(-1))).toBe('red');
  });
});

describe('textoValidadeLi — the words', () => {
  it('31 and 30 count days and say a DIFFERENT number', () => {
    expect(textoValidadeLi(31)).toBe('vence em 31 dias');
    expect(textoValidadeLi(30)).toBe('vence em 30 dias');
  });

  it('1 is singular, 2 the near miss on that plural', () => {
    expect(textoValidadeLi(1)).toBe('vence em 1 dia');
    expect(textoValidadeLi(2)).toBe('vence em 2 dias');
  });

  it('⭐ 0 is "vence hoje", and -1 has already passed — the two stay distinguishable', () => {
    expect(textoValidadeLi(0)).toBe('vence hoje');
    expect(textoValidadeLi(-1)).toBe('venceu há 1 dia');
    expect(textoValidadeLi(-5)).toBe('venceu há 5 dias');
  });

  it('null and NaN say "unknown", never a count or "venceu"', () => {
    expect(textoValidadeLi(null)).toBe('validade desconhecida');
    expect(textoValidadeLi(Number.NaN)).toBe('validade desconhecida');
  });
});

describe('orientacaoValidadeLi — what to DO', () => {
  it('expirando: renew in the painel, then update the date here', () => {
    expect(orientacaoValidadeLi(SITUACAO_VALIDADE_TOKEN_LI.expirando)).toContain(
      'Só atualizar a validade',
    );
  });

  it('vencido: says both outcomes — renewed (update the date) or revoked (a new token)', () => {
    const texto = orientacaoValidadeLi(SITUACAO_VALIDADE_TOKEN_LI.vencido) ?? '';
    expect(texto).toContain('atualize a validade');
    expect(texto).toContain('gere um novo');
  });

  it('ok and null say nothing — the panel must not narrate a healthy token', () => {
    expect(orientacaoValidadeLi(SITUACAO_VALIDADE_TOKEN_LI.ok)).toBeNull();
    expect(orientacaoValidadeLi(null)).toBeNull();
  });
});

describe('dates without a Date', () => {
  it('⭐ a civil date is split, never parsed — 2026-12-31 stays the 31st', () => {
    // `new Date('2026-12-31')` is UTC midnight and renders as the 30th west of
    // Greenwich; the split cannot shift a day.
    expect(dataCivilParaExibicao('2026-12-31')).toBe('31/12/2026');
    expect(dataCivilParaExibicao('2027-01-01')).toBe('01/01/2027');
  });

  it('leaves anything that is not YYYY-MM-DD unchanged rather than guessing', () => {
    expect(dataCivilParaExibicao('31/12/2026')).toBe('31/12/2026');
    expect(dataCivilParaExibicao('')).toBe('');
  });

  it('⭐ an instant reads as its SÃO PAULO date: 02:30 UTC is still the previous day', () => {
    // 2026-10-09T02:30Z is 2026-10-08 23:30 in São Paulo.
    expect(diaEMesNoFuso(Date.UTC(2026, 9, 9, 2, 30))).toBe('08/10');
    // The near miss three hours later is already the 9th there too.
    expect(diaEMesNoFuso(Date.UTC(2026, 9, 9, 3, 30))).toBe('09/10');
  });

  it('a non-finite instant is null', () => {
    expect(diaEMesNoFuso(Number.NaN)).toBeNull();
  });
});

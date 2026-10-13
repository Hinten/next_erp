import { describe, expect, it } from 'vitest';
import { CODIGO_ERRO_LI } from '@delfrance/schemas';

import { validarDataDeValidade } from './validade';

/** 2027-01-15T15:00:00Z — noon in São Paulo. */
const MEIO_DIA_SP = Date.UTC(2027, 0, 15, 15, 0, 0);
/** 2027-01-16T02:30:00Z — the 16th in UTC, still 23:30 on the 15th in São Paulo. */
const NOITE_SP = Date.UTC(2027, 0, 16, 2, 30, 0);

describe('validarDataDeValidade', () => {
  it('accepts today and stores 23:59:59 São Paulo of that day', () => {
    expect(validarDataDeValidade('2027-01-15', MEIO_DIA_SP)).toEqual({
      ok: true,
      expiraEm: '2027-01-15',
      // 23:59:59 at UTC−3 is 02:59:59 UTC the next day.
      tokenExpiraEmMs: Date.UTC(2027, 0, 16, 2, 59, 59),
    });
  });

  it('accepts today + 120 days, and refuses today + 121 (near-miss)', () => {
    expect(validarDataDeValidade('2027-05-15', MEIO_DIA_SP).ok).toBe(true);
    expect(validarDataDeValidade('2027-05-16', MEIO_DIA_SP)).toMatchObject({
      ok: false,
      code: CODIGO_ERRO_LI.validadeDistante,
    });
  });

  it('refuses yesterday (near-miss of today)', () => {
    expect(validarDataDeValidade('2027-01-14', MEIO_DIA_SP)).toMatchObject({
      ok: false,
      code: CODIGO_ERRO_LI.validadePassada,
    });
  });

  it('accepts a real leap day, refuses a date that does not exist', () => {
    const novembro2027 = Date.UTC(2027, 10, 1, 15, 0, 0);
    expect(validarDataDeValidade('2028-02-29', novembro2027).ok).toBe(true);
    expect(validarDataDeValidade('2026-02-30', MEIO_DIA_SP)).toMatchObject({
      ok: false,
      code: CODIGO_ERRO_LI.validadeInvalida,
    });
  });

  it.each(['', '31/12/2027', '2027-1-15', '2027-01-15T00:00:00Z', ' 2027-01-15', 'amanhã'])(
    'refuses the malformed %j as LI_VALIDADE_INVALIDA',
    (data) => {
      expect(validarDataDeValidade(data, MEIO_DIA_SP)).toMatchObject({
        ok: false,
        code: CODIGO_ERRO_LI.validadeInvalida,
      });
    },
  );

  it('at 23:30 in São Paulo (02:30 UTC next day) today is still São Paulo’s', () => {
    // A UTC "today" would refuse the operator's own today as already past…
    expect(validarDataDeValidade('2027-01-15', NOITE_SP).ok).toBe(true);
    // …and accept 121 days out, counted from the wrong day.
    expect(validarDataDeValidade('2027-05-16', NOITE_SP)).toMatchObject({
      ok: false,
      code: CODIGO_ERRO_LI.validadeDistante,
    });
  });

  it('the refusal sentence never echoes an unvalidated input', () => {
    const lixo = 'li-token-sentinela-colado-no-campo-errado';
    const r = validarDataDeValidade(lixo, MEIO_DIA_SP);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(lixo);
  });
});

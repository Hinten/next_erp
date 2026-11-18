/**
 * `configEstoqueLi.ts` (master plan step 12, PRs 12-f and 12-g): the stock sync's numeric
 * settings — the cap (its reader moved here unchanged; `processarEstoque.test.ts` still pins it
 * through the re-export), the eager ceiling of the kit fan-out and the daily reconcile's page size
 * for the store's stock list. Every refusal has a near-miss beside the value it is refused next to.
 */
import { describe, expect, it } from 'vitest';
import { MAX_KITS_EM_LINHA_ESTOQUE_LI, MAX_LIMITE_PAGINA_ESTOQUE_LI } from '@delfrance/schemas';

import {
  LIMITE_PAGINA_ESTOQUE_ENV_LI,
  LIMITE_PAGINA_ESTOQUE_PADRAO_LI,
  TETO_ESTOQUE_ENV_LI,
  TETO_KITS_IMEDIATOS_ENV_LI,
  TETO_KITS_IMEDIATOS_INVALIDO_LI,
  TETO_KITS_IMEDIATOS_PADRAO_LI,
  lerLimitePaginaEstoqueLi,
  lerTetoEstoqueLi,
  lerTetoKitsImediatosLi,
} from './configEstoqueLi';
import * as processar from './processarEstoque';

const comTeto = (v: string | undefined) => ({ [TETO_KITS_IMEDIATOS_ENV_LI]: v });

describe('the eager ceiling (LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX)', () => {
  it('the variable name, the default and the refusal value', () => {
    expect(TETO_KITS_IMEDIATOS_ENV_LI).toBe('LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX');
    expect(TETO_KITS_IMEDIATOS_PADRAO_LI).toBe(30);
    expect(TETO_KITS_IMEDIATOS_PADRAO_LI).toBe(MAX_KITS_EM_LINHA_ESTOQUE_LI);
    expect(TETO_KITS_IMEDIATOS_INVALIDO_LI).toBe(0);
  });

  it('unset and exactly blank ⇒ the default 30, valid', () => {
    expect(lerTetoKitsImediatosLi({})).toEqual({ teto: 30, valido: true });
    expect(lerTetoKitsImediatosLi(comTeto(undefined))).toEqual({ teto: 30, valido: true });
    expect(lerTetoKitsImediatosLi(comTeto(''))).toEqual({ teto: 30, valido: true });
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['29', 29],
    ['30', 30],
  ])('%j ⇒ %d, valid (0 is the queue lever, not a refusal)', (valor, teto) => {
    expect(lerTetoKitsImediatosLi(comTeto(valor))).toEqual({ teto, valido: true });
  });

  it.each([
    '31',
    '300',
    '9999999999999999999999',
    ' 3',
    '3 ',
    '30 ',
    '03',
    '00',
    '-1',
    '+3',
    '1.5',
    '1e1',
    '0x1e',
    'abc',
    ' ',
  ])('%j ⇒ refused: 0 and NOT valid (the caller logs one WARNING)', (valor) => {
    expect(lerTetoKitsImediatosLi(comTeto(valor))).toEqual({ teto: 0, valido: false });
  });

  it('⚠️ NEAR-MISS at the bound: 30 is accepted, 31 is refused (the eager path reads only the inline header)', () => {
    expect(lerTetoKitsImediatosLi(comTeto(String(MAX_KITS_EM_LINHA_ESTOQUE_LI)))).toEqual({
      teto: 30,
      valido: true,
    });
    expect(lerTetoKitsImediatosLi(comTeto(String(MAX_KITS_EM_LINHA_ESTOQUE_LI + 1)))).toEqual({
      teto: 0,
      valido: false,
    });
  });

  it('never throws, whatever the environment holds', () => {
    for (const v of ['', 'x', '-', '∞', 'NaN', 'Infinity', '\n0']) {
      expect(() => lerTetoKitsImediatosLi(comTeto(v))).not.toThrow();
    }
  });
});

describe('the cap reader moved to the leaf', () => {
  it('the send run re-exports THE SAME reader and name (one copy)', () => {
    expect(processar.lerTetoEstoqueLi).toBe(lerTetoEstoqueLi);
    expect(processar.TETO_ESTOQUE_ENV_LI).toBe(TETO_ESTOQUE_ENV_LI);
    expect(TETO_ESTOQUE_ENV_LI).toBe('LOJA_INTEGRADA_ESTOQUE_MAX');
  });

  it('unchanged: unset/blank ⇒ +∞, canonical positive ⇒ itself, anything else ⇒ null', () => {
    expect(lerTetoEstoqueLi({})).toBe(Number.POSITIVE_INFINITY);
    expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: '' })).toBe(Number.POSITIVE_INFINITY);
    expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: '5' })).toBe(5);
    for (const v of ['0', '05', ' 5', '-5', '5.0', 'x']) {
      expect(lerTetoEstoqueLi({ [TETO_ESTOQUE_ENV_LI]: v })).toBeNull();
    }
  });
});

describe('the reconcile page size (LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA)', () => {
  const comLimite = (v: string | undefined) => ({ [LIMITE_PAGINA_ESTOQUE_ENV_LI]: v });

  it('the variable name; the default is the measured 100, never above the schema bound', () => {
    expect(LIMITE_PAGINA_ESTOQUE_ENV_LI).toBe('LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA');
    expect(LIMITE_PAGINA_ESTOQUE_PADRAO_LI).toBe(100);
    expect(LIMITE_PAGINA_ESTOQUE_PADRAO_LI).toBeLessThanOrEqual(MAX_LIMITE_PAGINA_ESTOQUE_LI);
  });

  it('unset and exactly blank ⇒ 100, valid', () => {
    expect(lerLimitePaginaEstoqueLi({})).toEqual({ limite: 100, valido: true });
    expect(lerLimitePaginaEstoqueLi(comLimite(undefined))).toEqual({ limite: 100, valido: true });
    expect(lerLimitePaginaEstoqueLi(comLimite(''))).toEqual({ limite: 100, valido: true });
  });

  it.each([
    ['1', 1],
    ['50', 50],
    ['99', 99],
    ['100', 100],
  ])('%j ⇒ %d, valid', (valor, limite) => {
    expect(lerLimitePaginaEstoqueLi(comLimite(valor))).toEqual({ limite, valido: true });
  });

  it.each(['101', '200', '100000', '9999999999999999999999'])(
    '%j ⇒ CLAMPED to the schema bound, NOT valid (one WARNING)',
    (valor) => {
      expect(lerLimitePaginaEstoqueLi(comLimite(valor))).toEqual({
        limite: MAX_LIMITE_PAGINA_ESTOQUE_LI,
        valido: false,
      });
    },
  );

  it('⚠️ NEAR-MISS at the bound: 100 is valid as is, 101 is clamped', () => {
    expect(lerLimitePaginaEstoqueLi(comLimite(String(MAX_LIMITE_PAGINA_ESTOQUE_LI)))).toEqual({
      limite: MAX_LIMITE_PAGINA_ESTOQUE_LI,
      valido: true,
    });
    expect(
      lerLimitePaginaEstoqueLi(comLimite(String(MAX_LIMITE_PAGINA_ESTOQUE_LI + 1))).valido,
    ).toBe(false);
  });

  it.each(['0', '00', '03', ' 5', '5 ', '-1', '+5', '1.5', '1e2', '0x10', 'abc', ' '])(
    '%j ⇒ the default 100, NOT valid (one WARNING) — never trimmed, never folded',
    (valor) => {
      expect(lerLimitePaginaEstoqueLi(comLimite(valor))).toEqual({ limite: 100, valido: false });
    },
  );

  it('never throws, whatever the environment holds', () => {
    for (const v of ['', 'x', '-', '∞', 'NaN', 'Infinity', '\n5']) {
      expect(() => lerLimitePaginaEstoqueLi(comLimite(v))).not.toThrow();
    }
  });
});

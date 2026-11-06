/**
 * The product-import dispatch's time budget (master plan step 9): every unit's worst case, the
 * boundary at which a unit is refused, and the clock edge cases. Pure: no Firestore, no network.
 */
import { describe, expect, it } from 'vitest';
import { PRAZO_LI_MS } from '@delfrance/integrations-loja-integrada';
import {
  CAUDA_DESPACHO_IMPORTACAO_LI_MS,
  ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS,
} from '@delfrance/schemas';

import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import {
  DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS,
  PIOR_CASO_FAMILIA_SEM_CHAMADA_LI_MS,
  PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS,
  UNIDADE_IMPORTACAO_LI,
  type UnidadeImportacaoLi,
  abrirOrcamentoLi,
  cabeNoOrcamentoLi,
} from './orcamento';

describe('the worst case of each unit', () => {
  it('a Loja Integrada call = the pacer’s wait + the read deadline (2 s + 20 s = 22 s)', () => {
    expect(PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada).toBe(
      RITMO_LEITURA_LI_MS + PRAZO_LI_MS.leitura,
    );
    expect(PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada).toBe(22_000);
  });

  it('a family with no call = 10 s, nominal', () => {
    expect(PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.familia).toBe(PIOR_CASO_FAMILIA_SEM_CHAMADA_LI_MS);
    expect(PIOR_CASO_FAMILIA_SEM_CHAMADA_LI_MS).toBe(10_000);
  });

  it('the table has a row for every unit, and no other', () => {
    expect(Object.keys(PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS).sort()).toEqual(
      Object.values(UNIDADE_IMPORTACAO_LI).sort(),
    );
  });

  it('every unit fits an EMPTY budget, so a dispatch always makes progress', () => {
    for (const unidade of Object.values(UNIDADE_IMPORTACAO_LI)) {
      expect(PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS[unidade], unidade).toBeLessThanOrEqual(
        ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS,
      );
      expect(cabeNoOrcamentoLi(0, unidade), unidade).toBe(true);
    }
  });
});

describe('the dispatch: 70 s of units + a 30 s tail = 100 s', () => {
  it('pins the numbers the reads queue’s co-tenant arithmetic is written for', () => {
    expect(ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS).toBe(70_000);
    expect(CAUDA_DESPACHO_IMPORTACAO_LI_MS).toBe(30_000);
    expect(DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS).toBe(100_000);
  });

  it('the tail outlasts one more call’s worst case: the last unit’s overrun never eats the hand-off', () => {
    // A unit that started inside the budget ends at most at 70 s; the checkpoint and the enqueue
    // then have the whole tail. The tail is longer than one call, so even a misjudged unit (one
    // started one call too late) still leaves the hand-off time to land.
    expect(CAUDA_DESPACHO_IMPORTACAO_LI_MS).toBeGreaterThan(
      PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada,
    );
  });
});

describe('cabeNoOrcamentoLi — the boundary, exactly', () => {
  const casos: readonly (readonly [UnidadeImportacaoLi, number])[] = [
    ['chamada', ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS - PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada],
    ['familia', ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS - PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.familia],
  ];

  it.each(casos)(
    'a %s that ENDS exactly at 70 s starts (elapsed %d ms)',
    (unidade, ultimoInicio) => {
      expect(cabeNoOrcamentoLi(ultimoInicio, unidade)).toBe(true);
    },
  );

  it.each(casos)(
    '⚠️ NEAR-MISS: a %s one millisecond later is refused (elapsed %d + 1 ms)',
    (unidade, ultimoInicio) => {
      expect(cabeNoOrcamentoLi(ultimoInicio + 1, unidade)).toBe(false);
    },
  );

  it('today’s numbers: a call starts up to 48 s in, a family up to 60 s in', () => {
    expect(cabeNoOrcamentoLi(48_000, 'chamada')).toBe(true);
    expect(cabeNoOrcamentoLi(48_001, 'chamada')).toBe(false);
    expect(cabeNoOrcamentoLi(60_000, 'familia')).toBe(true);
    expect(cabeNoOrcamentoLi(60_001, 'familia')).toBe(false);
    // The two units are not interchangeable: at 50 s a family still fits, a call does not.
    expect(cabeNoOrcamentoLi(50_000, 'familia')).toBe(true);
    expect(cabeNoOrcamentoLi(50_000, 'chamada')).toBe(false);
  });

  it('a clock that stepped BACKWARDS reads as 0 elapsed, never as extra budget', () => {
    expect(cabeNoOrcamentoLi(-1_000_000, 'chamada')).toBe(true);
    expect(cabeNoOrcamentoLi(-1, 'familia')).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'a non-finite elapsed time (%s) fits nothing',
    (decorrido) => {
      expect(cabeNoOrcamentoLi(decorrido, 'chamada')).toBe(false);
      expect(cabeNoOrcamentoLi(decorrido, 'familia')).toBe(false);
    },
  );

  it('a unit with no row throws (only an untyped caller can pass one)', () => {
    expect(() => cabeNoOrcamentoLi(0, 'foto' as UnidadeImportacaoLi)).toThrow(TypeError);
    expect(() => cabeNoOrcamentoLi(0, 'toString' as UnidadeImportacaoLi)).toThrow(TypeError);
  });
});

describe('abrirOrcamentoLi — one dispatch on a scripted clock', () => {
  it('measures from the handler’s stamp, and asks the clock on EVERY question', () => {
    let agora = 1_000_000;
    const orcamento = abrirOrcamentoLi(() => agora, 990_000);
    expect(orcamento.inicioMs).toBe(990_000);
    // The job read and the context load (10 s here) already count.
    expect(orcamento.decorridoMs()).toBe(10_000);
    expect(orcamento.cabe('chamada')).toBe(true);

    agora = 990_000 + 48_000;
    expect(orcamento.cabe('chamada')).toBe(true);
    agora += 1;
    expect(orcamento.cabe('chamada')).toBe(false);
    expect(orcamento.cabe('familia')).toBe(true);
    agora = 990_000 + 60_001;
    expect(orcamento.cabe('familia')).toBe(false);
  });

  it('without a stamp, the first reading is the start', () => {
    const leituras = [5_000, 5_000, 30_000];
    const orcamento = abrirOrcamentoLi(() => leituras.shift() ?? 0);
    expect(orcamento.inicioMs).toBe(5_000);
    expect(orcamento.decorridoMs()).toBe(0);
    expect(orcamento.decorridoMs()).toBe(25_000);
  });

  it('a clock behind the stamp gives 0 elapsed, never a negative', () => {
    const orcamento = abrirOrcamentoLi(() => 900, 1_000);
    expect(orcamento.decorridoMs()).toBe(0);
    expect(orcamento.cabe('chamada')).toBe(true);
  });

  it('a stretch of calls: the 3rd call at 44 s still starts, the 4th at 66 s does not', () => {
    // Each call takes its worst case: the dispatch must stop BEFORE the unit that would cross 70 s.
    let agora = 0;
    const orcamento = abrirOrcamentoLi(() => agora, 0);
    let feitas = 0;
    while (orcamento.cabe('chamada')) {
      agora += PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada;
      feitas += 1;
    }
    expect(feitas).toBe(3);
    expect(agora).toBe(66_000);
    expect(agora).toBeLessThanOrEqual(ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS);
  });
});

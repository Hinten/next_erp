import { describe, expect, it } from 'vitest';
import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import { alvosOferecidos } from '@/components/etiqueta/EscolherTransportadoraDialog';

import { alvoFreteLiDoDoc } from './useAlvosMapaFreteLi';

/**
 * The projection both Loja Integrada target pickers read. Two flags answer two
 * DIFFERENT questions, and the step-15 picker must use the one the label route
 * itself decides by:
 *
 * - `ativo` / `suportado` — the conta editor's display flags (step 20): the
 *   stored flag exactly `true`, a tipo among the five targets;
 * - `roteavel` — whether the label routing route would ACCEPT the doc as a
 *   target, decided by the route's own evaluator (`avaliarAlvoDoMapaLi` under
 *   the label policy), the Melhor Envio service aside: a hand-picked Melhor
 *   Envio target takes its service from the method's own row.
 */
describe('alvoFreteLiDoDoc — `roteavel` is the label route’s own rule', () => {
  it('EQUAL pair: an ABSENT `ativo` is as active as `true` — the route accepts both', () => {
    const comFlag = alvoFreteLiDoDoc('a', { tipo: INTEGRACAO_FRETE.motoboy, ativo: true });
    const semFlag = alvoFreteLiDoDoc('b', { tipo: INTEGRACAO_FRETE.motoboy });

    expect(comFlag.roteavel).toBe(true);
    expect(semFlag.roteavel).toBe(true);
    // …while the editor's display flag still reads the stored value exactly.
    expect(semFlag.ativo).toBe(false);
  });

  it('⚠️ NEAR-MISS: `ativo: false` is NOT offerable', () => {
    expect(alvoFreteLiDoDoc('a', { tipo: INTEGRACAO_FRETE.motoboy, ativo: false }).roteavel).toBe(
      false,
    );
  });

  it('⚠️ NEAR-MISS: a tipo outside the five targets (a marketplace’s freight, the Loja Integrada doc itself) is NOT offerable', () => {
    for (const tipo of [
      INTEGRACAO_FRETE.mercadoLivre,
      INTEGRACAO_FRETE.lojaIntegrada,
      'MelhorEnvios',
      '',
    ]) {
      expect(alvoFreteLiDoDoc('a', { tipo, ativo: true }).roteavel, tipo).toBe(false);
    }
  });

  it('every one of the five targets is offerable — Melhor Envio included, its service coming from the row', () => {
    for (const tipo of [
      INTEGRACAO_FRETE.melhorEnvios,
      INTEGRACAO_FRETE.motoboy,
      INTEGRACAO_FRETE.retiradaNaLoja,
      INTEGRACAO_FRETE.fob,
      INTEGRACAO_FRETE.outros,
    ]) {
      expect(alvoFreteLiDoDoc('a', { tipo, ativo: true }).roteavel, tipo).toBe(true);
    }
  });

  it('the picker offers exactly the `roteavel` targets', () => {
    const alvos = [
      alvoFreteLiDoDoc('ativo', { tipo: INTEGRACAO_FRETE.motoboy, ativo: true, nome: 'A' }),
      alvoFreteLiDoDoc('migrado', { tipo: INTEGRACAO_FRETE.motoboy, nome: 'B' }),
      alvoFreteLiDoDoc('inativo', { tipo: INTEGRACAO_FRETE.motoboy, ativo: false, nome: 'C' }),
      alvoFreteLiDoDoc('ml', { tipo: INTEGRACAO_FRETE.mercadoLivre, ativo: true, nome: 'D' }),
    ];

    expect(alvosOferecidos(alvos).map((a) => a.id)).toEqual(['ativo', 'migrado']);
  });
});

/**
 * The checkout's retirada hand-off rule (master plan step 15, #1825, B9): one rule for the
 * checkout's phase 2 and the Loja Integrada label routing route. Tested from both sides — the one
 * pair that advances, and the near-misses one field away that must not.
 */
import { describe, expect, it } from 'vitest';
import { avancaParaRetirada } from './faseRetirada';
import {
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  estadoFreteSchema,
  integracoesFreteSchema,
} from './shared/frete';
import * as barrel from './index';

describe('avancaParaRetirada', () => {
  it('EQUAL: a pickup target whose freight is `checkFinalizado` advances', () => {
    expect(avancaParaRetirada(ESTADO_FRETE.checkFinalizado, INTEGRACAO_FRETE.retiradaNaLoja)).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: `emSeparacao` with retiradaNaLoja, or `checkFinalizado` with motoboy ⇒ false', () => {
    expect(avancaParaRetirada(ESTADO_FRETE.emSeparacao, INTEGRACAO_FRETE.retiradaNaLoja)).toBe(
      false,
    );
    expect(avancaParaRetirada(ESTADO_FRETE.checkFinalizado, INTEGRACAO_FRETE.motoboy)).toBe(false);
  });

  it('no other freight estado advances a pickup — a freight already moved on is never dragged back', () => {
    for (const estado of estadoFreteSchema.options) {
      if (estado === ESTADO_FRETE.checkFinalizado) continue;
      expect(avancaParaRetirada(estado, INTEGRACAO_FRETE.retiradaNaLoja), estado).toBe(false);
    }
  });

  it('no other target tipo advances from `checkFinalizado`', () => {
    for (const tipo of integracoesFreteSchema.options) {
      if (tipo === INTEGRACAO_FRETE.retiradaNaLoja) continue;
      expect(avancaParaRetirada(ESTADO_FRETE.checkFinalizado, tipo), tipo).toBe(false);
    }
  });

  it('compares exactly — no trim, no case fold — and never throws', () => {
    expect(avancaParaRetirada('checkFinalizado ', INTEGRACAO_FRETE.retiradaNaLoja)).toBe(false);
    expect(avancaParaRetirada(ESTADO_FRETE.checkFinalizado, 'RetiradaNaLoja')).toBe(false);
    for (const lixo of [null, undefined, 5, {}, []]) {
      expect(avancaParaRetirada(lixo, INTEGRACAO_FRETE.retiradaNaLoja)).toBe(false);
      expect(avancaParaRetirada(ESTADO_FRETE.checkFinalizado, lixo)).toBe(false);
    }
  });

  it('is exported by the barrel', () => {
    expect(barrel.avancaParaRetirada).toBe(avancaParaRetirada);
  });
});

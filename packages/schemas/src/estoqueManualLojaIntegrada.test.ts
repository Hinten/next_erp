/**
 * The wire contract of the Loja Integrada stock sync's two operator routes (master plan step 12,
 * PR 12-h): the push's STRICT body and its bound, and the two answers — non-strict at EVERY level
 * (the answer, each row, each entry), with plain-string motivos and modos, so an older browser still
 * reads a newer backend.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
  MODO_ESTOQUE_LI,
  MOTIVO_ENVIO_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  corpoEnvioEstoqueLiSchema,
  modoEstoqueLiSchema,
  motivoEnvioEstoqueLiSchema,
  respostaEnvioEstoqueLiSchema,
  respostaReconcileEstoqueLiSchema,
  resultadoEnvioEstoqueLiSchema,
} from './estoqueManualLojaIntegrada';
import * as barrel from './index';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i)}`);

const LINHA = {
  produtoId: 'filho-1',
  solicitadoId: 'pai-1',
  produtoNome: 'Camiseta P',
  idLi: '123',
  resultado: RESULTADO_ENVIO_ESTOQUE_LI.enfileirado,
  motivo: null,
  mensagem: 'Na fila.',
};

const RESPOSTA = {
  contaId: 'C1',
  modo: MODO_ESTOQUE_LI.on,
  solicitados: 1,
  listings: [LINHA],
  produtosSemEnvio: [],
};

describe('corpoEnvioEstoqueLiSchema — the push body (strict)', () => {
  it('accepts 1 and exactly MAX_PRODUTOS_ENVIO_ESTOQUE_LI ids', () => {
    expect(MAX_PRODUTOS_ENVIO_ESTOQUE_LI).toBe(200);
    expect(corpoEnvioEstoqueLiSchema.parse({ contaId: 'C1', produtoIds: ['p'] })).toEqual({
      contaId: 'C1',
      produtoIds: ['p'],
    });
    expect(
      corpoEnvioEstoqueLiSchema.safeParse({ contaId: 'C1', produtoIds: ids(200) }).success,
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: 0 and 201 ids, a path-shaped id, a reserved id, a dotted conta id and any extra key are refused', () => {
    for (const corpo of [
      { contaId: 'C1', produtoIds: [] },
      { contaId: 'C1', produtoIds: ids(201) },
      { contaId: 'C1', produtoIds: ['a/b'] },
      { contaId: 'C1', produtoIds: ['..'] },
      { contaId: 'C1', produtoIds: ['__x__'] },
      { contaId: '.', produtoIds: ['p'] },
      { contaId: 'a/b', produtoIds: ['p'] },
      // The other channels' bypass flag: this channel has no refusal latch to bypass.
      { contaId: 'C1', produtoIds: ['p'], reenviarComErro: true },
      { contaId: 'C1', produtoIds: ['p'], integracaoId: 'C1' },
      { produtoIds: ['p'] },
    ]) {
      expect(corpoEnvioEstoqueLiSchema.safeParse(corpo).success, JSON.stringify(corpo)).toBe(false);
    }
  });
});

describe('the outcomes', () => {
  it('resultado is EXACTLY enfileirado / pulado / falha — never a "sent"', () => {
    expect(resultadoEnvioEstoqueLiSchema.options).toEqual(['enfileirado', 'pulado', 'falha']);
    expect(Object.values(RESULTADO_ENVIO_ESTOQUE_LI)).toEqual(
      resultadoEnvioEstoqueLiSchema.options,
    );
    expect(resultadoEnvioEstoqueLiSchema.safeParse('enviado').success).toBe(false);
  });

  it('every motivo constant is a member, and the enum holds no other', () => {
    expect(Object.values(MOTIVO_ENVIO_ESTOQUE_LI).sort()).toEqual(
      [...motivoEnvioEstoqueLiSchema.options].sort(),
    );
    expect(Object.values(MODO_ESTOQUE_LI)).toEqual(modoEstoqueLiSchema.options);
    // A route that refuses with the valve off never answers `off`.
    expect(modoEstoqueLiSchema.safeParse('off').success).toBe(false);
  });
});

describe('respostaEnvioEstoqueLiSchema — the push answer (non-strict)', () => {
  it('parses a row, and an unknown motivo (a newer backend) still parses', () => {
    expect(respostaEnvioEstoqueLiSchema.parse(RESPOSTA)).toEqual(RESPOSTA);
    const novo = {
      ...RESPOSTA,
      listings: [{ ...LINHA, resultado: 'pulado', motivo: 'um-motivo-de-amanha' }],
      produtosSemEnvio: [
        { produtoId: 'p9', produtoNome: null, motivo: 'outro-de-amanha', mensagem: 'x' },
      ],
      campoNovo: 1,
    };
    expect(respostaEnvioEstoqueLiSchema.safeParse(novo).success).toBe(true);
  });

  // Each level on its own, so a schema turned strict names the level that broke.
  it.each([
    ['a field on the answer', { ...RESPOSTA, campoNovo: 1 }],
    ['a field on a row', { ...RESPOSTA, listings: [{ ...LINHA, campoDaLinha: 1 }] }],
    [
      'a field on a produtosSemEnvio entry',
      {
        ...RESPOSTA,
        produtosSemEnvio: [
          { produtoId: 'p9', produtoNome: null, motivo: 'sem-vinculo', mensagem: 'x', campo: 'y' },
        ],
      },
    ],
    // A valve mode a later step adds (the web never decides on it).
    ['a valve mode in modo', { ...RESPOSTA, modo: 'um-modo-de-amanha' }],
  ])('%s, added by a newer backend, still parses', (_nivel, novo) => {
    expect(respostaEnvioEstoqueLiSchema.safeParse(novo).success).toBe(true);
  });

  it('⚠️ NEAR-MISS: an unknown RESULTADO is refused — the web decides on it', () => {
    for (const resultado of ['enviado', 'nao-tentado', '']) {
      expect(
        respostaEnvioEstoqueLiSchema.safeParse({
          ...RESPOSTA,
          listings: [{ ...LINHA, resultado }],
        }).success,
        resultado,
      ).toBe(false);
    }
    // …and a MISSING modo is refused: the answer must say which valve it read.
    const { modo: _modo, ...semModo } = RESPOSTA;
    expect(respostaEnvioEstoqueLiSchema.safeParse(semModo).success).toBe(false);
  });
});

describe('respostaReconcileEstoqueLiSchema — the reconcile answer', () => {
  it('parses a run id, the valve and the switch; refuses an id outside the run grammar', () => {
    const r = {
      execucaoId: 'estoque-reconcile-manual-1763500000000',
      modo: MODO_ESTOQUE_LI.dryRun,
      chamadas: false,
      mensagem: 'x',
    };
    expect(respostaReconcileEstoqueLiSchema.parse(r)).toEqual(r);
    expect(respostaReconcileEstoqueLiSchema.safeParse({ ...r, execucaoId: 'a b' }).success).toBe(
      false,
    );
  });

  it('NEAR MISS — a field or a valve mode a newer backend adds still parses (non-strict)', () => {
    const r = {
      execucaoId: 'estoque-reconcile-manual-1763500000000',
      modo: 'um-modo-de-amanha',
      chamadas: true,
      mensagem: 'x',
      campoNovo: 1,
    };
    expect(respostaReconcileEstoqueLiSchema.safeParse(r).success).toBe(true);
  });
});

describe('barrel', () => {
  it('exports the contract', () => {
    expect(barrel.corpoEnvioEstoqueLiSchema).toBe(corpoEnvioEstoqueLiSchema);
    expect(barrel.respostaEnvioEstoqueLiSchema).toBe(respostaEnvioEstoqueLiSchema);
    expect(barrel.respostaReconcileEstoqueLiSchema).toBe(respostaReconcileEstoqueLiSchema);
    expect(barrel.MAX_PRODUTOS_ENVIO_ESTOQUE_LI).toBe(MAX_PRODUTOS_ENVIO_ESTOQUE_LI);
  });
});

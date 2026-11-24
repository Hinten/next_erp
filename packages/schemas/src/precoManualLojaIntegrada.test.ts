/**
 * The wire contract of the Loja Integrada price sync's two operator routes (master plan step 13):
 * the two STRICT bodies, whose lowering flag is `false` when absent, and the two answers —
 * non-strict at EVERY level, with plain-string motivos and modos, so an older browser still reads
 * a newer backend.
 */
import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import * as modulo from './precoManualLojaIntegrada';
import {
  MAX_PRODUTOS_ENVIO_PRECO_LI,
  MODO_PRECO_LI,
  MOTIVO_ENVIO_PRECO_LI,
  RESULTADO_ENVIO_PRECO_LI,
  corpoAtualizacaoPrecoLiSchema,
  corpoEnvioPrecoLiSchema,
  modoPrecoLiSchema,
  motivoEnvioPrecoLiSchema,
  respostaAtualizacaoPrecoLiSchema,
  respostaEnvioPrecoLiSchema,
  resultadoEnvioPrecoLiSchema,
} from './precoManualLojaIntegrada';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i)}`);

const LINHA = {
  produtoId: 'filho-1',
  solicitadoId: 'pai-1',
  produtoNome: 'Camiseta P',
  idLi: '123',
  resultado: RESULTADO_ENVIO_PRECO_LI.enfileirado,
  motivo: null,
  mensagem: 'Na fila.',
};

const RESPOSTA = {
  contaId: 'C1',
  modo: MODO_PRECO_LI.on,
  baixarPreco: false,
  solicitados: 1,
  listings: [LINHA],
  produtosSemEnvio: [],
};

describe('corpoEnvioPrecoLiSchema — the push body (strict)', () => {
  it('accepts 1 and exactly MAX_PRODUTOS_ENVIO_PRECO_LI ids; an absent baixarPreco is FALSE', () => {
    expect(MAX_PRODUTOS_ENVIO_PRECO_LI).toBe(200);
    expect(corpoEnvioPrecoLiSchema.parse({ contaId: 'C1', produtoIds: ['p'] })).toEqual({
      contaId: 'C1',
      produtoIds: ['p'],
      baixarPreco: false,
    });
    expect(
      corpoEnvioPrecoLiSchema.parse({ contaId: 'C1', produtoIds: ['p'], baixarPreco: true }),
    ).toEqual({ contaId: 'C1', produtoIds: ['p'], baixarPreco: true });
    expect(corpoEnvioPrecoLiSchema.safeParse({ contaId: 'C1', produtoIds: ids(200) }).success).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: 0 and 201 ids, a bad id, a price, a custo, any extra key and a non-boolean flag are refused', () => {
    for (const corpo of [
      { contaId: 'C1', produtoIds: [] },
      { contaId: 'C1', produtoIds: ids(201) },
      { contaId: 'C1', produtoIds: ['a/b'] },
      { contaId: 'C1', produtoIds: ['..'] },
      { contaId: 'C1', produtoIds: ['__x__'] },
      { contaId: 'a/b', produtoIds: ['p'] },
      { contaId: 'C1', produtoIds: ['p'], cheio: 50 },
      { contaId: 'C1', produtoIds: ['p'], custo: 12.5 },
      { contaId: 'C1', produtoIds: ['p'], reenviarComErro: true },
      { contaId: 'C1', produtoIds: ['p'], permitirBaixar: true },
      { contaId: 'C1', produtoIds: ['p'], baixarPreco: 'true' },
      { contaId: 'C1', produtoIds: ['p'], baixarPreco: null },
      { produtoIds: ['p'] },
    ]) {
      expect(corpoEnvioPrecoLiSchema.safeParse(corpo).success, JSON.stringify(corpo)).toBe(false);
    }
  });
});

describe('corpoAtualizacaoPrecoLiSchema — "Atualizar preços" (strict)', () => {
  it('an empty body never lowers; an explicit true does', () => {
    expect(corpoAtualizacaoPrecoLiSchema.parse({})).toEqual({ permitirBaixar: false });
    expect(corpoAtualizacaoPrecoLiSchema.parse({ permitirBaixar: true })).toEqual({
      permitirBaixar: true,
    });
  });

  it('⚠️ NEAR-MISS: the push’s flag name, the conta in the body, a text flag and a price are refused', () => {
    for (const corpo of [
      { baixarPreco: true },
      { contaId: 'C1' },
      { permitirBaixar: 'true' },
      { permitirBaixar: 1 },
      { permitirBaixar: null },
      { permitirBaixar: false, cheio: 50 },
    ]) {
      expect(corpoAtualizacaoPrecoLiSchema.safeParse(corpo).success, JSON.stringify(corpo)).toBe(
        false,
      );
    }
  });
});

describe('the outcomes', () => {
  it('resultado is EXACTLY enfileirado / pulado / falha — never a "sent"', () => {
    expect(resultadoEnvioPrecoLiSchema.options).toEqual(['enfileirado', 'pulado', 'falha']);
    expect(Object.values(RESULTADO_ENVIO_PRECO_LI)).toEqual(resultadoEnvioPrecoLiSchema.options);
    expect(resultadoEnvioPrecoLiSchema.safeParse('enviado').success).toBe(false);
  });

  it('every motivo constant is a member, and the enum holds no other — no price motivo is a route skip', () => {
    expect(Object.values(MOTIVO_ENVIO_PRECO_LI).sort()).toEqual(
      [...motivoEnvioPrecoLiSchema.options].sort(),
    );
    for (const precoMotivo of ['sem-preco', 'ilegivel', 'nao-baixado', 'paridade']) {
      expect(motivoEnvioPrecoLiSchema.safeParse(precoMotivo).success, precoMotivo).toBe(false);
    }
    expect(Object.values(MODO_PRECO_LI)).toEqual(modoPrecoLiSchema.options);
    expect(modoPrecoLiSchema.safeParse('off').success).toBe(false);
  });
});

describe('respostaEnvioPrecoLiSchema — the push answer (non-strict)', () => {
  it('parses a row, and an unknown motivo (a newer backend) still parses', () => {
    expect(respostaEnvioPrecoLiSchema.parse(RESPOSTA)).toEqual(RESPOSTA);
    const novo = {
      ...RESPOSTA,
      listings: [{ ...LINHA, resultado: 'pulado', motivo: 'um-motivo-de-amanha' }],
      produtosSemEnvio: [
        { produtoId: 'p9', produtoNome: null, motivo: 'outro-de-amanha', mensagem: 'x' },
      ],
      campoNovo: 1,
    };
    expect(respostaEnvioPrecoLiSchema.safeParse(novo).success).toBe(true);
  });

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
    ['a valve mode in modo', { ...RESPOSTA, modo: 'um-modo-de-amanha' }],
  ])('%s, added by a newer backend, still parses', (_nivel, novo) => {
    expect(respostaEnvioPrecoLiSchema.safeParse(novo).success).toBe(true);
  });

  it('⚠️ NEAR-MISS: an unknown RESULTADO is refused; a missing modo or lowering choice too', () => {
    for (const resultado of ['enviado', 'nao-tentado', '']) {
      expect(
        respostaEnvioPrecoLiSchema.safeParse({ ...RESPOSTA, listings: [{ ...LINHA, resultado }] })
          .success,
        resultado,
      ).toBe(false);
    }
    const { modo: _modo, ...semModo } = RESPOSTA;
    expect(respostaEnvioPrecoLiSchema.safeParse(semModo).success).toBe(false);
    const { baixarPreco: _baixar, ...semBaixar } = RESPOSTA;
    expect(respostaEnvioPrecoLiSchema.safeParse(semBaixar).success).toBe(false);
  });
});

describe('respostaAtualizacaoPrecoLiSchema — "Atualizar preços"’s answer', () => {
  const r = {
    execucaoId: 'estoque-reconcile-preco-1763500000000',
    modo: MODO_PRECO_LI.dryRun,
    permitirBaixar: false,
    chamadas: false,
    mensagem: 'x',
  };

  it('parses a run id, the valve, the lowering choice and the switch; refuses an id outside the run grammar', () => {
    expect(respostaAtualizacaoPrecoLiSchema.parse(r)).toEqual(r);
    expect(respostaAtualizacaoPrecoLiSchema.safeParse({ ...r, execucaoId: 'a b' }).success).toBe(
      false,
    );
  });

  it('NEAR MISS — a field or a valve mode a newer backend adds still parses (non-strict)', () => {
    expect(
      respostaAtualizacaoPrecoLiSchema.safeParse({ ...r, modo: 'um-modo-de-amanha', campoNovo: 1 })
        .success,
    ).toBe(true);
  });
});

describe('barrel', () => {
  it('re-exports every name of the module', () => {
    for (const [nome, valor] of Object.entries(modulo)) {
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});

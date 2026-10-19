/**
 * The label routing route's wire contract (master plan step 15, #1825): the strict body, the
 * three answers, and what the answer must NEVER carry (the target document).
 */
import { describe, expect, it } from 'vitest';
import {
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  corpoRotaEtiquetaLiSchema,
  respostaRotaEtiquetaLiSchema,
  tipoRespostaRotaEtiquetaLiSchema,
} from './rotaEtiquetaLojaIntegrada';
import { ESTADO_FRETE, INTEGRACAO_FRETE } from './shared/frete';
import * as barrel from './index';

const ROTA = {
  integracaoFreteOuterRef: 'documents/int_frete/me-1',
  externalOptionId: '3',
  integracaoTargetOuterRef: null,
  estado: ESTADO_FRETE.despachoAutorizado,
};
const ALVO = { id: 'me-1', tipo: INTEGRACAO_FRETE.melhorEnvios, nome: 'Conta ME' };

describe('corpoRotaEtiquetaLiSchema — the request body (strict)', () => {
  it('accepts a null escolha and a bare document id', () => {
    expect(corpoRotaEtiquetaLiSchema.parse({ escolha: null })).toEqual({ escolha: null });
    expect(corpoRotaEtiquetaLiSchema.parse({ escolha: 'moto-1' })).toEqual({ escolha: 'moto-1' });
  });

  it('refuses an escolha that is not a usable document id', () => {
    for (const escolha of ['', 'int_frete/moto-1', 'a/b', '.', '..', 5, true]) {
      expect(corpoRotaEtiquetaLiSchema.safeParse({ escolha }).success, String(escolha)).toBe(false);
    }
  });

  it('refuses a missing escolha and an unknown key', () => {
    expect(corpoRotaEtiquetaLiSchema.safeParse({}).success).toBe(false);
    expect(corpoRotaEtiquetaLiSchema.safeParse({ escolha: null, pedidoId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('respostaRotaEtiquetaLiSchema — the three answers', () => {
  it('parses `roteado` and `ja-roteado` with the target and the routing fields', () => {
    for (const tipo of [
      TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado,
      TIPO_RESPOSTA_ROTA_ETIQUETA_LI.jaRoteado,
    ]) {
      expect(respostaRotaEtiquetaLiSchema.parse({ tipo, alvo: ALVO, rota: ROTA })).toEqual({
        tipo,
        alvo: ALVO,
        rota: ROTA,
      });
    }
  });

  it('parses `recusado` with a motivo — including one a newer backend adds', () => {
    for (const motivo of ['sem-mapeamento', 'um-motivo-novo']) {
      expect(
        respostaRotaEtiquetaLiSchema.parse({
          tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado,
          motivo,
        }),
      ).toEqual({ tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado, motivo });
    }
    expect(
      respostaRotaEtiquetaLiSchema.safeParse({
        tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado,
        motivo: '',
      }).success,
    ).toBe(false);
  });

  it('⭐ never carries the target document: unknown keys on the answer, the target and the route are stripped', () => {
    const resposta = respostaRotaEtiquetaLiSchema.parse({
      tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado,
      alvo: {
        ...ALVO,
        ativo: true,
        filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
        tokens: 'x',
      },
      rota: { ...ROTA, valorCobrado: 10, externalOptionData: { id: 1 } },
      documento: { tipo: 'melhorEnvios' },
    });
    expect(Object.keys(resposta).sort()).toEqual(['alvo', 'rota', 'tipo']);
    if (resposta.tipo === TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado) throw new Error('unreachable');
    expect(Object.keys(resposta.alvo).sort()).toEqual(['id', 'nome', 'tipo']);
    expect(Object.keys(resposta.rota).sort()).toEqual([
      'estado',
      'externalOptionId',
      'integracaoFreteOuterRef',
      'integracaoTargetOuterRef',
    ]);
  });

  it('the target is one of the five label targets — never the router or a marketplace’s freight', () => {
    for (const tipo of ['lojaIntegrada', 'shopee', 'mercadoLivre', 'Motoboy']) {
      expect(
        respostaRotaEtiquetaLiSchema.safeParse({
          tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado,
          alvo: { ...ALVO, tipo },
          rota: ROTA,
        }).success,
        tipo,
      ).toBe(false);
    }
  });

  it('every ref is canonical: a bare `int_frete/<id>` is refused', () => {
    expect(
      respostaRotaEtiquetaLiSchema.safeParse({
        tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado,
        alvo: ALVO,
        rota: { ...ROTA, integracaoFreteOuterRef: 'int_frete/me-1' },
      }).success,
    ).toBe(false);
  });

  it('a null `nome` and a null `estado` parse (a doc without a name, an unknown stored estado)', () => {
    expect(
      respostaRotaEtiquetaLiSchema.safeParse({
        tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.jaRoteado,
        alvo: { ...ALVO, nome: null },
        rota: { ...ROTA, estado: null },
      }).success,
    ).toBe(true);
  });

  it('an unknown answer tipo is refused', () => {
    expect(respostaRotaEtiquetaLiSchema.safeParse({ tipo: 'outro', motivo: 'x' }).success).toBe(
      false,
    );
  });
});

describe('TIPO_RESPOSTA_ROTA_ETIQUETA_LI', () => {
  it('names every member of the schema, once', () => {
    expect(Object.values(TIPO_RESPOSTA_ROTA_ETIQUETA_LI).sort()).toEqual(
      [...tipoRespostaRotaEtiquetaLiSchema.options].sort(),
    );
  });
});

describe('barrel', () => {
  it('exports the contract', () => {
    expect(barrel.corpoRotaEtiquetaLiSchema).toBe(corpoRotaEtiquetaLiSchema);
    expect(barrel.respostaRotaEtiquetaLiSchema).toBe(respostaRotaEtiquetaLiSchema);
    expect(barrel.TIPO_RESPOSTA_ROTA_ETIQUETA_LI).toBe(TIPO_RESPOSTA_ROTA_ETIQUETA_LI);
  });
});

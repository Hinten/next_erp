import { describe, expect, it } from 'vitest';
import {
  ACAO_ITEM_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  PENDENCIAS_ACIONAVEIS_LI,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
  acaoImportacaoLiSchema,
  acaoItemImportacaoLiSchema,
  alvoImportacaoLiSchema,
  categoriasImportacaoLiSchema,
  faseImportacaoLiSchema,
  fotosImportacaoLiSchema,
  modoImportacaoLiSchema,
  motivoFalhaImportacaoLiSchema,
  motivoRevisaoFiscalLiSchema,
  pendenciaImportacaoLiSchema,
  situacaoErpItemLiSchema,
  statusImportacaoLiSchema,
  tipoProdutoLiSchema,
} from '@delfrance/schemas';

import {
  COR_STATUS_IMPORTACAO_LI,
  MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI,
  ROTULO_ACAO_IMPORTACAO_LI,
  ROTULO_ACAO_ITEM_IMPORTACAO_LI,
  ROTULO_ALVO_IMPORTACAO_LI,
  ROTULO_CATEGORIAS_IMPORTACAO_LI,
  ROTULO_FASE_IMPORTACAO_LI,
  ROTULO_FOTOS_IMPORTACAO_LI,
  ROTULO_MODO_IMPORTACAO_LI,
  ROTULO_MOTIVO_REVISAO_FISCAL_LI,
  ROTULO_SITUACAO_ERP_ITEM_LI,
  ROTULO_STATUS_IMPORTACAO_LI,
  ROTULO_TIPO_PRODUTO_LI,
  TEXTO_PENDENCIA_IMPORTACAO_LI,
  lerAcaoItemImportacaoLi,
  lerFaseImportacaoLi,
  lerMotivoFalhaImportacaoLi,
  lerMotivoRevisaoFiscalLi,
  lerPendenciaLi,
  lerSituacaoErpItemLi,
  lerTipoProdutoLi,
} from './importacaoRotulos';

/**
 * The product import's words. The exhaustive tables fail TYPECHECK on a new
 * enum member; these tests pin what the compiler cannot: that each table holds
 * exactly the contract's members at runtime, that no two codes read alike, that
 * a pendência's class is the contract's own set, and — for the fields the
 * answers carry as plain strings — that a code is known only when it matches
 * EXACTLY (each equal pair has its near miss).
 */

const ordenadas = (xs: readonly string[]) => [...xs].sort();

describe('the exhaustive tables hold exactly the contract’s members', () => {
  it.each([
    ['status', ROTULO_STATUS_IMPORTACAO_LI, statusImportacaoLiSchema.options],
    ['status (cor)', COR_STATUS_IMPORTACAO_LI, statusImportacaoLiSchema.options],
    ['fase', ROTULO_FASE_IMPORTACAO_LI, faseImportacaoLiSchema.options],
    ['motivo', MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI, motivoFalhaImportacaoLiSchema.options],
    ['modo', ROTULO_MODO_IMPORTACAO_LI, modoImportacaoLiSchema.options],
    ['alvo', ROTULO_ALVO_IMPORTACAO_LI, alvoImportacaoLiSchema.options],
    ['acao', ROTULO_ACAO_IMPORTACAO_LI, acaoImportacaoLiSchema.options],
    ['categorias', ROTULO_CATEGORIAS_IMPORTACAO_LI, categoriasImportacaoLiSchema.options],
    ['fotos', ROTULO_FOTOS_IMPORTACAO_LI, fotosImportacaoLiSchema.options],
    ['tipo', ROTULO_TIPO_PRODUTO_LI, tipoProdutoLiSchema.options],
    ['situação', ROTULO_SITUACAO_ERP_ITEM_LI, situacaoErpItemLiSchema.options],
    ['ação do item', ROTULO_ACAO_ITEM_IMPORTACAO_LI, acaoItemImportacaoLiSchema.options],
    ['pendência', TEXTO_PENDENCIA_IMPORTACAO_LI, pendenciaImportacaoLiSchema.options],
    ['motivo de revisão', ROTULO_MOTIVO_REVISAO_FISCAL_LI, motivoRevisaoFiscalLiSchema.options],
  ])('%s', (_nome, tabela, membros) => {
    expect(ordenadas(Object.keys(tabela))).toEqual(ordenadas(membros));
  });

  it('no two codes of one table read alike', () => {
    for (const tabela of [
      ROTULO_STATUS_IMPORTACAO_LI,
      ROTULO_FASE_IMPORTACAO_LI,
      MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI,
      ROTULO_ALVO_IMPORTACAO_LI,
      ROTULO_SITUACAO_ERP_ITEM_LI,
      ROTULO_TIPO_PRODUTO_LI,
      ROTULO_MOTIVO_REVISAO_FISCAL_LI,
    ]) {
      const textos = Object.values(tabela);
      expect(new Set(textos).size).toBe(textos.length);
    }
    const pendencias = Object.values(TEXTO_PENDENCIA_IMPORTACAO_LI);
    expect(new Set(pendencias.map((p) => p.rotulo)).size).toBe(pendencias.length);
    expect(new Set(pendencias.map((p) => p.descricao)).size).toBe(pendencias.length);
  });
});

describe('lerPendenciaLi — the class is the contract’s own set', () => {
  it.each(pendenciaImportacaoLiSchema.options)(
    '%s takes its class from ehPendenciaAcionavelLi, whatever the stored flag says',
    (codigo) => {
      const esperado = PENDENCIAS_ACIONAVEIS_LI.has(codigo);
      expect(lerPendenciaLi({ codigo, acionavel: esperado }).acionavel).toBe(esperado);
      // The stored flag of a KNOWN code is never the source.
      expect(lerPendenciaLi({ codigo, acionavel: !esperado }).acionavel).toBe(esperado);
    },
  );

  it('the codes added after the plan: "nome-cortado" informs, "sku-parecido-na-loja" needs a person', () => {
    const nome = lerPendenciaLi({ codigo: PENDENCIA_IMPORTACAO_LI.nomeCortado, acionavel: false });
    const sku = lerPendenciaLi({
      codigo: PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja,
      acionavel: true,
    });

    expect(nome).toMatchObject({ conhecido: true, acionavel: false, rotulo: 'Nome cortado' });
    expect(sku).toMatchObject({ conhecido: true, acionavel: true, rotulo: 'SKU parecido na loja' });
  });

  it('EQUAL PAIR — the wire’s plain string and the enum member read as one code', () => {
    const doWire = lerPendenciaLi({ codigo: 'nome-cortado', acionavel: false });
    const doEnum = lerPendenciaLi({
      codigo: PENDENCIA_IMPORTACAO_LI.nomeCortado,
      acionavel: false,
    });

    expect(doWire).toEqual(doEnum);
    expect(doWire.conhecido).toBe(true);
  });

  it.each(['nome-cortado ', ' nome-cortado', 'Nome-cortado', 'NOME-CORTADO', 'nome_cortado', ''])(
    'NEAR MISS — %j is an UNKNOWN code, shown generically with the raw code quoted',
    (codigo) => {
      const lida = lerPendenciaLi({ codigo, acionavel: false });

      expect(lida.conhecido).toBe(false);
      expect(lida.rotulo).toBe(`Pendência "${codigo}"`);
      expect(lida.rotulo).not.toBe(
        TEXTO_PENDENCIA_IMPORTACAO_LI[PENDENCIA_IMPORTACAO_LI.nomeCortado].rotulo,
      );
      expect(lida.codigo).toBe(codigo);
    },
  );

  it('an UNKNOWN code takes the backend’s stored flag — the only source there is', () => {
    expect(lerPendenciaLi({ codigo: 'codigo-novo', acionavel: true }).acionavel).toBe(true);
    expect(lerPendenciaLi({ codigo: 'codigo-novo', acionavel: false }).acionavel).toBe(false);
  });
});

describe('the other plain-string readers — equal pair and near miss each', () => {
  it('fase', () => {
    expect(lerFaseImportacaoLi('familias')).toEqual({
      texto: ROTULO_FASE_IMPORTACAO_LI[FASE_IMPORTACAO_LI.familias],
      conhecido: true,
    });
    expect(lerFaseImportacaoLi('Familias')).toEqual({ texto: 'Fase "Familias"', conhecido: false });
    expect(lerFaseImportacaoLi('familias ').conhecido).toBe(false);
  });

  it('motivo de falha — and a `falhou` with no motivo is still copy, never blank', () => {
    expect(lerMotivoFalhaImportacaoLi('chamadas-desligadas')).toEqual({
      texto: MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI[MOTIVO_FALHA_IMPORTACAO_LI.chamadasDesligadas],
      conhecido: true,
    });
    expect(lerMotivoFalhaImportacaoLi('chamadas_desligadas')).toEqual({
      texto: 'A importação falhou (motivo "chamadas_desligadas"). Avise o suporte.',
      conhecido: false,
    });
    const semMotivo = lerMotivoFalhaImportacaoLi(null);
    expect(semMotivo.conhecido).toBe(false);
    expect(semMotivo.texto.length).toBeGreaterThan(0);
  });

  it('situação ERP — `avulso` is known', () => {
    expect(lerSituacaoErpItemLi('avulso')).toEqual({
      texto: ROTULO_SITUACAO_ERP_ITEM_LI[SITUACAO_ERP_ITEM_LI.avulso],
      conhecido: true,
    });
    expect(lerSituacaoErpItemLi('Avulso')).toEqual({
      texto: 'Situação "Avulso"',
      conhecido: false,
    });
  });

  it('tipo — `atributo_opcao` with its underscore, never the hyphen', () => {
    expect(lerTipoProdutoLi('atributo_opcao')).toEqual({
      texto: ROTULO_TIPO_PRODUTO_LI[TIPO_PRODUTO_LI.atributoOpcao],
      conhecido: true,
    });
    expect(lerTipoProdutoLi('atributo-opcao').conhecido).toBe(false);
  });

  it('ação do item — worded as done, or as a Simular’s proposal', () => {
    const rotulos = ROTULO_ACAO_ITEM_IMPORTACAO_LI[ACAO_ITEM_IMPORTACAO_LI.criar];
    expect(lerAcaoItemImportacaoLi('criar', true)).toEqual({
      texto: rotulos.aplicada,
      conhecido: true,
    });
    expect(lerAcaoItemImportacaoLi('criar', false)).toEqual({
      texto: rotulos.simulada,
      conhecido: true,
    });
    expect(rotulos.aplicada).not.toBe(rotulos.simulada);
    expect(lerAcaoItemImportacaoLi('Criar', true)).toEqual({
      texto: 'Ação "Criar"',
      conhecido: false,
    });
  });

  it('motivo de revisão fiscal', () => {
    expect(lerMotivoRevisaoFiscalLi('sem-categoria')).toEqual({
      texto: ROTULO_MOTIVO_REVISAO_FISCAL_LI[MOTIVO_REVISAO_FISCAL_LI.semCategoria],
      conhecido: true,
    });
    expect(lerMotivoRevisaoFiscalLi('sem categoria')).toEqual({
      texto: 'Motivo "sem categoria"',
      conhecido: false,
    });
  });
});

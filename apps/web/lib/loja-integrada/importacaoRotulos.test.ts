import { describe, expect, it } from 'vitest';
import {
  ACAO_ITEM_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  PENDENCIAS_ACIONAVEIS_LI,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_PRODUTO_LI,
  acaoImportacaoLiSchema,
  acaoItemImportacaoLiSchema,
  alvoImportacaoLiSchema,
  categoriasImportacaoLiSchema,
  faseImportacaoLiSchema,
  fotosImportacaoLiSchema,
  modoImportacaoLiSchema,
  motivoFalhaImportacaoLiSchema,
  motivoFotoRecusadaLiSchema,
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
  ROTULO_MOTIVO_FOTO_RECUSADA_LI,
  ROTULO_MOTIVO_REVISAO_FISCAL_LI,
  ROTULO_SITUACAO_ERP_ITEM_LI,
  ROTULO_STATUS_IMPORTACAO_LI,
  ROTULO_TIPO_PRODUTO_LI,
  TEXTO_APRENDIZADO_SIMULADO_LI,
  TEXTO_JOB_AGUARDANDO_LI,
  TEXTO_PENDENCIA_IMPORTACAO_LI,
  lerAcaoItemImportacaoLi,
  lerCampoLi,
  lerFaseImportacaoLi,
  lerMotivoFalhaImportacaoLi,
  lerMotivoRevisaoFiscalLi,
  lerPendenciaLi,
  lerSituacaoErpItemLi,
  lerTipoProdutoLi,
  textoDaFaseDoJobLi,
  textoReferenciasDaPendenciaLi,
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
    ['motivo de foto', ROTULO_MOTIVO_FOTO_RECUSADA_LI, motivoFotoRecusadaLiSchema.options],
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

describe('the actionable sentences send the operator only where a path exists', () => {
  // No screen links an ERP category or produto to a store one by hand: a
  // sentence asking for that would leave the summary aviso open for good.
  it.each([...PENDENCIAS_ACIONAVEIS_LI])('%s', (codigo) => {
    const { descricao } = TEXTO_PENDENCIA_IMPORTACAO_LI[codigo];
    expect(descricao).not.toMatch(/Vincule a categoria/);
    expect(descricao).not.toMatch(/Deixe um vínculo só/);
    expect(descricao).not.toMatch(/Corrija ou remova esse vínculo/);
  });

  it('⭐ "dado-invalido" is true on every path: what depended on the data — create, complete OR link — was not done', () => {
    const { descricao } = TEXTO_PENDENCIA_IMPORTACAO_LI[PENDENCIA_IMPORTACAO_LI.dadoInvalido];
    expect(descricao).toMatch(/o que dependia dele não foi feito: criar, completar ou vincular/);
    // NEAR MISS — the fill path's narrower truth, said as if it were every path's:
    // on a matched produto the code also means a variation neither matched nor linked.
    expect(descricao).not.toMatch(/o restante do produto seguiu/);
    expect(descricao).not.toMatch(/só esse campo ficou de fora/);
    // A detail the store answered off its schema, or a SKU that changed during the
    // read, has nothing to correct in the panel: running again comes first.
    expect(descricao).toMatch(/Rode a importação de novo/);
    expect(descricao).toMatch(/corrija o dado citado no painel da Loja Integrada/);
    expect(descricao).toMatch(/detalhe do produto na loja, avise o suporte/);
  });

  it('"categoria-sem-vinculo" points at the import option that creates and links it', () => {
    expect(
      TEXTO_PENDENCIA_IMPORTACAO_LI[PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo].descricao,
    ).toMatch(/"Completar" e, em categorias, "Criar e vincular as que faltam"/);
  });
});

describe('textoDaFaseDoJobLi — what a running job is doing NOW', () => {
  const base = {
    status: STATUS_IMPORTACAO_LI.executando,
    modo: MODO_IMPORTACAO_LI.aplicar,
    fase: FASE_IMPORTACAO_LI.catalogo,
  };

  it('a queued job waits, whatever phase it will start in', () => {
    expect(textoDaFaseDoJobLi({ ...base, status: STATUS_IMPORTACAO_LI.pendente })).toBe(
      TEXTO_JOB_AGUARDANDO_LI,
    );
    // NEAR MISS — the same stored phase on a job that runs reads as the phase.
    expect(textoDaFaseDoJobLi(base)).toBe(ROTULO_FASE_IMPORTACAO_LI[FASE_IMPORTACAO_LI.catalogo]);
  });

  it('the learning phase links under Importar, and only checks under Simular', () => {
    const aprendizado = { ...base, fase: FASE_IMPORTACAO_LI.aprendizado };
    expect(textoDaFaseDoJobLi(aprendizado)).toBe(
      ROTULO_FASE_IMPORTACAO_LI[FASE_IMPORTACAO_LI.aprendizado],
    );
    expect(textoDaFaseDoJobLi({ ...aprendizado, modo: MODO_IMPORTACAO_LI.simular })).toBe(
      TEXTO_APRENDIZADO_SIMULADO_LI,
    );
    // NEAR MISS — any other phase reads the same in both modes.
    expect(
      textoDaFaseDoJobLi({
        ...base,
        fase: FASE_IMPORTACAO_LI.familias,
        modo: MODO_IMPORTACAO_LI.simular,
      }),
    ).toBe(ROTULO_FASE_IMPORTACAO_LI[FASE_IMPORTACAO_LI.familias]);
  });
});

describe('lerCampoLi — the report’s field names in pt-BR', () => {
  it('EQUAL PAIR — a known name, bare or as a field of something else', () => {
    expect(lerCampoLi('pesoBrutoKg')).toBe('Peso bruto (kg)');
    expect(lerCampoLi('categoriaProdutoOuterRef')).toBe('Categoria');
    expect(lerCampoLi('extraData.marca')).toBe('Marca');
    expect(lerCampoLi('categoria.nome')).toBe('Categoria da loja: Nome');
    expect(lerCampoLi('membro.sku')).toBe('Variação: SKU');
  });

  it('NEAR MISS — a name off by case or unknown is shown as it came', () => {
    expect(lerCampoLi('PesoBrutoKg')).toBe('PesoBrutoKg');
    expect(lerCampoLi('pesoBrutoKg ')).toBe('pesoBrutoKg ');
    expect(lerCampoLi('extraData.cor')).toBe('extraData.cor');
    expect(lerCampoLi('categoria.')).toBe('categoria.');
    expect(lerCampoLi('categoria.campoNovo')).toBe('Categoria da loja: campoNovo');
    // An inherited key of a plain object is not a field name.
    expect(lerCampoLi('constructor')).toBe('constructor');
  });
});

describe('textoReferenciasDaPendenciaLi — what a pendência names', () => {
  it('fields, a length and a picture read in pt-BR', () => {
    expect(
      textoReferenciasDaPendenciaLi({ codigo: 'dado-invalido', referencias: ['nome', 'sku'] }),
    ).toBe('Campos: Nome, SKU');
    expect(
      textoReferenciasDaPendenciaLi({ codigo: 'vinculo-atualizado', referencias: ['ativo'] }),
    ).toBe('Campos: Ativo na loja');
    expect(
      textoReferenciasDaPendenciaLi({ codigo: 'descricao-longa', referencias: ['4123'] }),
    ).toBe('Descrição com 4.123 caracteres');
    expect(
      textoReferenciasDaPendenciaLi({
        codigo: 'foto-recusada',
        referencias: ['77', 'nao-e-imagem'],
      }),
    ).toBe('Imagem 77: não é uma imagem');
  });

  it('NEAR MISS — ids and SKUs, an unknown code, or a reference off its shape are shown as they came', () => {
    expect(
      textoReferenciasDaPendenciaLi({ codigo: 'sku-ja-existe', referencias: ['produto-falso-9'] }),
    ).toBe('Referências: produto-falso-9');
    expect(textoReferenciasDaPendenciaLi({ codigo: 'codigo-novo', referencias: ['nome'] })).toBe(
      'Referências: nome',
    );
    expect(
      textoReferenciasDaPendenciaLi({ codigo: 'descricao-longa', referencias: ['4123 '] }),
    ).toBe('Referências: 4123 ');
    expect(
      textoReferenciasDaPendenciaLi({
        codigo: 'foto-recusada',
        referencias: ['77', 'motivo-novo'],
      }),
    ).toBe('Referências: 77, motivo-novo');
    expect(textoReferenciasDaPendenciaLi({ codigo: 'dado-invalido', referencias: [] })).toBeNull();
  });
});

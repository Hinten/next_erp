import { describe, expect, it } from 'vitest';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  MAX_ITEM_NAME_RASCUNHO_SHOPEE,
  PADRAO_ID_RASCUNHO_SHOPEE,
  camposDoRascunhoShopee,
  corpoAtualizarRascunhoShopeeSchema,
  corpoCriarRascunhoShopeeSchema,
  corpoDescartarRascunhoShopeeSchema,
  pendenciasDoRascunhoShopee,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  type EstadoPublicacaoRascunhoShopee,
  type MarcaDaContaShopee,
} from '@delfrance/schemas';

import {
  FRASE_CATEGORIA_TRAVADA_SHOPEE,
  FRASE_CONTA_NAO_ENCONTRADA_SHOPEE,
  FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
  FRASE_PRODUTO_INEXISTENTE_SHOPEE,
  FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_DE_VARIACAO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE,
  FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_ID_EM_USO_SHOPEE,
  FRASE_RASCUNHO_INCERTO_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_SHOPEE,
  FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_RASCUNHO_NOVO_SHOPEE,
  FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE,
  FRASE_RASCUNHO_SEM_TITULO_SHOPEE,
  fraseDaRespostaIlegivelDoRascunhoShopee,
  fraseDaRespostaIncertaDoRascunhoShopee,
  fraseDoConflitoDeConcorrenciaShopee,
  fraseDoConflitoIlegivelShopee,
  FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE,
  FRASE_MARCA_PODE_NAO_VALER_SHOPEE,
  FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
  FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
  FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
  FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
  FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
  FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
  MOTIVO_ANUNCIO_SHOPEE,
  ROTULO_CAMPO_RASCUNHO_SHOPEE,
  ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
  ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
  avisoDoDescarteComAnuncioSemVinculoShopee,
  fraseDaPublicacaoDoRascunhoEmAndamentoShopee,
  fraseDaPublicacaoExpiradaShopee,
  fraseDaPublicacaoInterrompidaShopee,
  rotuloDaPublicacaoQueAdotaShopee,
} from './anuncioProduto';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
} from './client';
import { CODIGO_FALHA_SHOPEE } from './erros';
import {
  CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE,
  MARCA_SEM_MARCA_RASCUNHO_SHOPEE,
  MARGEM_DA_RELEITURA_DO_ESTADO_SHOPEE_MS,
  algumRascunhoShopeeSujo,
  comCampoRascunhoShopee,
  conciliarEdicaoRascunhoShopee,
  corpoAtualizarRascunhoShopee,
  corpoCriarRascunhoShopee,
  corpoDescartarRascunhoShopee,
  divergenciasDoServidorShopee,
  edicaoDoRascunhoGuardadoShopee,
  edicaoRascunhoShopeeSuja,
  estadoDoBlocoRascunhoShopee,
  existentesDosVinculosShopee,
  falhaDoRascunhoShopee,
  idDeNovoRascunhoShopee,
  marcaDaLinhaParaRascunhoShopee,
  marcarRascunhoShopeeSalvo,
  novaEdicaoRascunhoShopee,
  planoDoRascunhoShopee,
  projecaoGuardadaDoRascunhoShopee,
  rebasearEdicaoRascunhoShopee,
  segundoAnuncioNaContaShopee,
  corpoPublicarRascunhoShopee,
  falhaDaPublicacaoDoRascunhoShopee,
  publicacaoDoRascunhoShopee,
  rotuloDaSuperficieShopee,
  saidasDoProblemaShopee,
  superficieDoCampoShopee,
  type EdicaoRascunhoShopee,
  type EntradaDaPublicacaoDoRascunhoShopee,
  type EntradaDoBlocoRascunhoShopee,
} from './rascunho';
import { DETALHES_ERRO_SHOPEE_VAZIOS, type DetalhesErroShopee, type ProblemaShopee } from './wire';

/**
 * #1911 P10 — the draft's state model. Each rule is pinned from BOTH sides: a
 * pair that must come out equal and a near-miss that must stay distinct (root
 * `CLAUDE.md`'s fold rule — the two draft compares are folds, and this file is
 * their one web caller).
 *
 * Every body is also parsed by the draft route's OWN schema
 * (`corpo…RascunhoShopeeSchema`): "no 400" is asserted, never assumed. The
 * client builds the wire body BY NAME from exactly these inputs (P8), so the
 * input IS the body.
 */

const LIVRE: EstadoPublicacaoRascunhoShopee = { tipo: 'livre' };
const INCERTA: EstadoPublicacaoRascunhoShopee = { tipo: 'incerta', desdeMs: null };
const EM_ANDAMENTO: EstadoPublicacaoRascunhoShopee = {
  tipo: 'em-andamento',
  desdeMs: 1,
  expiraEmMs: 2,
  aguardarMs: 1,
  aposIncerteza: false,
  posExpiracao: false,
};
const PRODUTO = 'p1';
const CONTA = 'int-1';
const NOW = 1_800_000_000_000;
/** A new draft's id as the create requires it: Firestore's auto-id shape. */
const ID_NOVO = 'AbCdEfGhIj0123456789';

/** A stored draft as the snapshot hands it over (raw, unvalidated). */
function guardado(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contaProdutoShopeeOuterRef: `integracao/${CONTA}`,
    item_id: null,
    item_name: 'Camiseta',
    description: null,
    category_id: 100087,
    brand_id: 77,
    original_brand_name: 'Acme',
    ...extra,
  };
}

function edicaoDe(link: Record<string, unknown>, linkDocId = 'R1'): EdicaoRascunhoShopee {
  return edicaoDoRascunhoGuardadoShopee({ linkDocId, contaId: CONTA, link });
}

function linha(brandId: number, nome: string | null): MarcaDaContaShopee {
  return {
    brandId,
    originalBrandName: nome,
    displayBrandName: null,
    rotulo: nome ?? `Marca ${String(brandId)}`,
    docIds: [String(brandId)],
  };
}

/** The update the route would parse — asserts it parses (no 400) and returns it. */
function atualizacaoAceita(edicao: EdicaoRascunhoShopee, estado = LIVRE) {
  const corpo = corpoAtualizarRascunhoShopee(edicao, estado, { produtoId: PRODUTO });
  expect(corpo).not.toBeNull();
  const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(corpo);
  expect(lido.success, JSON.stringify(lido.error?.issues)).toBe(true);
  return corpo!;
}

describe('idDeNovoRascunhoShopee', () => {
  it('mints an auto-id the create accepts — 20 letters or digits, never a UUID — fresh per call', () => {
    const a = idDeNovoRascunhoShopee();
    const b = idDeNovoRascunhoShopee();
    expect(a).toMatch(PADRAO_ID_RASCUNHO_SHOPEE);
    expect(b).toMatch(PADRAO_ID_RASCUNHO_SHOPEE);
    expect(a).not.toBe(b);
  });
});

describe('a NEW draft — "Novo anúncio", nothing sent until Salvar', () => {
  it('prefills the stored produto nome VERBATIM; the create names EVERY field, attributes null', () => {
    const e = novaEdicaoRascunhoShopee({
      linkDocId: ID_NOVO,
      contaId: CONTA,
      nomeProduto: 'Camiseta ',
    });
    expect(e.novo).toBe(true);
    expect(e.atual).toEqual({
      item_name: 'Camiseta ',
      description: null,
      category_id: null,
      marca: null,
    });
    const corpo = corpoCriarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO });
    expect(corpo).toEqual({
      integracaoId: CONTA,
      produtoId: PRODUTO,
      linkDocId: ID_NOVO,
      conteudo: {
        item_name: 'Camiseta ',
        description: null,
        category_id: null,
        marca: null,
        attributes: null,
      },
    });
    expect(edicaoRascunhoShopeeSuja(e)).toBe(true);
  });

  it('confirmarSegundoAnuncio rides ONLY when confirmed (a literal true)', () => {
    const e = novaEdicaoRascunhoShopee({
      linkDocId: ID_NOVO,
      contaId: CONTA,
      nomeProduto: 'Camiseta',
    });
    expect(
      corpoCriarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO, confirmarSegundoAnuncio: true }),
    ).toMatchObject({ confirmarSegundoAnuncio: true });
    expect(
      corpoCriarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO, confirmarSegundoAnuncio: false }),
    ).not.toHaveProperty('confirmarSegundoAnuncio');
  });

  it('the create carries the NORMALISED form: blank description ⇒ null, "Sem marca" ⇒ no name', () => {
    let e = novaEdicaoRascunhoShopee({
      linkDocId: ID_NOVO,
      contaId: CONTA,
      nomeProduto: 'Camiseta',
    });
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.description, '   ');
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.marca, {
      brand_id: 0,
      original_brand_name: 'X',
    });
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.categoryId, 100087);
    const corpo = corpoCriarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO });
    expect(corpo?.conteudo).toEqual({
      item_name: 'Camiseta',
      description: null,
      category_id: 100087,
      marca: MARCA_SEM_MARCA_RASCUNHO_SHOPEE,
      attributes: null,
    });
    expect(corpoCriarRascunhoShopeeSchema.safeParse(corpo).success).toBe(true);
  });

  it('NEAR-MISS: a produto with no usable name gives no create — the blank title blocks Salvar', () => {
    for (const nomeProduto of [undefined, 42, '', '   ']) {
      const e = novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto });
      const plano = planoDoRascunhoShopee(e, LIVRE);
      expect(plano.impedimento).toBe('campo-invalido');
      expect(plano.invalidos).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
      expect(corpoCriarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO })).toBeNull();
    }
  });

  it('a STORED entry never builds a create, and a new one never builds an update', () => {
    const novo = novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto: 'X' });
    expect(corpoAtualizarRascunhoShopee(novo, LIVRE, { produtoId: PRODUTO })).toBeNull();
    const salvo = edicaoDe(guardado());
    expect(corpoCriarRascunhoShopee(salvo, LIVRE, { produtoId: PRODUTO })).toBeNull();
  });
});

describe('dirty and the patch — the WRITE question (rev. 2a #3)', () => {
  it('an untouched stored draft is clean: nothing to save', () => {
    const e = edicaoDe(guardado());
    const plano = planoDoRascunhoShopee(e, LIVRE);
    expect(plano).toMatchObject({ patch: {}, alterados: [], sujo: false });
    expect(plano.impedimento).toBe('nada-a-salvar');
    expect(corpoAtualizarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO })).toBeNull();
  });

  it('a title edit sends exactly {item_name} with the ORIGINAL as its base', () => {
    const e = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Camiseta azul',
    );
    const corpo = atualizacaoAceita(e);
    expect(corpo).toEqual({
      integracaoId: CONTA,
      produtoId: PRODUTO,
      linkDocId: 'R1',
      base: { item_name: 'Camiseta' },
      patch: { item_name: 'Camiseta azul' },
    });
  });

  it('⛔ the same brand id re-picked WITH a name over an id-only legacy brand is DIRTY — the name is the edit', () => {
    const legado = guardado({ brand_id: 77, original_brand_name: undefined });
    const e = comCampoRascunhoShopee(edicaoDe(legado), CAMPO_RASCUNHO_SHOPEE.marca, {
      brand_id: 77,
      original_brand_name: 'Acme',
    });
    expect(edicaoRascunhoShopeeSuja(e)).toBe(true);
    const corpo = atualizacaoAceita(e);
    expect(corpo.patch).toEqual({ marca: { brand_id: 77, original_brand_name: 'Acme' } });
    expect(corpo.base).toEqual({ marca: { brand_id: 77, original_brand_name: null } });
  });

  it('PAIR: the same pair re-picked is clean', () => {
    const e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.marca, {
      brand_id: 77,
      original_brand_name: 'Acme',
    });
    expect(edicaoRascunhoShopeeSuja(e)).toBe(false);
  });

  it('PAIR: a blank description typed over a stored null is clean ⟷ NEAR-MISS "x" is dirty', () => {
    const base = edicaoDe(guardado({ description: null }));
    expect(
      edicaoRascunhoShopeeSuja(
        comCampoRascunhoShopee(base, CAMPO_RASCUNHO_SHOPEE.description, '  '),
      ),
    ).toBe(false);
    const x = comCampoRascunhoShopee(base, CAMPO_RASCUNHO_SHOPEE.description, 'x');
    expect(edicaoRascunhoShopeeSuja(x)).toBe(true);
    expect(atualizacaoAceita(x).patch).toEqual({ description: 'x' });
  });

  it('an UNTOUCHED legacy value the write would normalise is never re-written (a stored "  " description)', () => {
    const e = comCampoRascunhoShopee(
      edicaoDe(guardado({ description: '  ' })),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Outro título',
    );
    const corpo = atualizacaoAceita(e);
    expect(corpo.patch).toEqual({ item_name: 'Outro título' });
    expect(edicaoRascunhoShopeeSuja(edicaoDe(guardado({ description: '  ' })))).toBe(false);
  });

  it('⛔ a draft storing attribute_id 0 and an untrimmed custom name: a title edit sends {item_name} and parses (no 400)', () => {
    const legado = guardado({
      attributes: [
        {
          attribute_id: 0,
          attribute_value_list: [{ value_id: 0, original_value_name: ' Algodão ' }],
        },
      ],
      category_id: 0,
    });
    const e = comCampoRascunhoShopee(edicaoDe(legado), CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo');
    const corpo = atualizacaoAceita(e);
    expect(corpo.patch).toEqual({ item_name: 'Novo' });
    expect(corpo.base).toEqual({ item_name: 'Camiseta' });
    expect(corpo.patch).not.toHaveProperty('attributes');
  });

  it('a real category change sends base.attributes beside it (K1-12) — the route parses it', () => {
    const atributos = [{ attribute_id: 10, attribute_value_list: [{ value_id: 5 }] }];
    const e = comCampoRascunhoShopee(
      edicaoDe(guardado({ attributes: atributos })),
      CAMPO_RASCUNHO_SHOPEE.categoryId,
      100088,
    );
    const corpo = atualizacaoAceita(e);
    expect(corpo.patch).toEqual({ category_id: 100088 });
    expect(Object.keys(corpo.base)).toEqual([
      CAMPO_RASCUNHO_SHOPEE.categoryId,
      CAMPO_RASCUNHO_SHOPEE.attributes,
    ]);
    expect(corpo.base.attributes).toEqual(atributos);
  });

  it('…and with NO stored attributes the base still names them, as null', () => {
    const e = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.categoryId,
      100088,
    );
    expect(atualizacaoAceita(e).base).toEqual({ category_id: 100087, attributes: null });
  });

  it('a changed field no write accepts is INVALID: dirty (the guard keeps it) but not sendable', () => {
    for (const titulo of ['', '   ', 'x'.repeat(MAX_ITEM_NAME_RASCUNHO_SHOPEE + 1)]) {
      const e = comCampoRascunhoShopee(
        edicaoDe(guardado()),
        CAMPO_RASCUNHO_SHOPEE.itemName,
        titulo,
      );
      const plano = planoDoRascunhoShopee(e, LIVRE);
      expect(plano.invalidos).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
      expect(plano.sujo).toBe(true);
      expect(plano.impedimento).toBe('campo-invalido');
      expect(corpoAtualizarRascunhoShopee(e, LIVRE, { produtoId: PRODUTO })).toBeNull();
    }
  });

  it('only the four P10 fields ever enter a patch, in canonical order', () => {
    expect(CAMPOS_DO_FORMULARIO_RASCUNHO_SHOPEE).toEqual([
      'item_name',
      'description',
      'category_id',
      'marca',
    ]);
    let e = edicaoDe(guardado());
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.marca, {
      brand_id: 88,
      original_brand_name: 'B',
    });
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo');
    expect(planoDoRascunhoShopee(e, LIVRE).alterados).toEqual(['item_name', 'marca']);
  });

  it('algumRascunhoShopeeSujo: any dirty entry, a new one included', () => {
    const limpo = edicaoDe(guardado());
    expect(algumRascunhoShopeeSujo([limpo])).toBe(false);
    expect(algumRascunhoShopeeSujo([])).toBe(false);
    expect(
      algumRascunhoShopeeSujo([
        limpo,
        novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto: 'X' }),
      ]),
    ).toBe(true);
  });
});

describe('the publish reading gates the save', () => {
  it('⛔ incerta: a title edit with a category picked and put BACK sends no category_id', () => {
    let e = edicaoDe(guardado());
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.categoryId, 100088);
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.categoryId, 100087);
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo');
    const corpo = atualizacaoAceita(e, INCERTA);
    expect(corpo.patch).toEqual({ item_name: 'Novo' });
    expect(corpo.base).toEqual({ item_name: 'Camiseta' });
  });

  it('NEAR-MISS: incerta + a real category change is blocked here (never a 409 round trip)', () => {
    const e = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.categoryId,
      100088,
    );
    expect(planoDoRascunhoShopee(e, INCERTA).impedimento).toBe('categoria-travada');
    expect(corpoAtualizarRascunhoShopee(e, INCERTA, { produtoId: PRODUTO })).toBeNull();
    expect(planoDoRascunhoShopee(e, LIVRE).impedimento).toBeNull();
  });

  it('em-andamento: nothing is sent (every draft route answers 409), but the work stays dirty', () => {
    const e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo');
    const plano = planoDoRascunhoShopee(e, EM_ANDAMENTO);
    expect(plano.impedimento).toBe('publicacao-em-andamento');
    expect(plano.sujo).toBe(true);
    expect(corpoAtualizarRascunhoShopee(e, EM_ANDAMENTO, { produtoId: PRODUTO })).toBeNull();
  });
});

describe('§H Q1 — a nameless shortlist row re-picked over the stored brand keeps the STORED name', () => {
  const armazenada = { brand_id: 77, original_brand_name: 'Acme' };

  it('same id + nameless row ⇒ the stored name — so the pick changes nothing and no patch carries a null name', () => {
    const marca = marcaDaLinhaParaRascunhoShopee(linha(77, null), armazenada);
    expect(marca).toEqual(armazenada);
    let e = edicaoDe(guardado());
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.marca, marca);
    expect(edicaoRascunhoShopeeSuja(e)).toBe(false);
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo');
    const corpo = atualizacaoAceita(e);
    expect(corpo.patch).toEqual({ item_name: 'Novo' });
    expect(corpo.patch.marca).toBeUndefined();
  });

  it('NEAR-MISS: a DIFFERENT id + nameless row ⇒ the pair as picked (null name), and it is sent', () => {
    const marca = marcaDaLinhaParaRascunhoShopee(linha(88, null), armazenada);
    expect(marca).toEqual({ brand_id: 88, original_brand_name: null });
    const e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.marca, marca);
    expect(atualizacaoAceita(e).patch).toEqual({
      marca: { brand_id: 88, original_brand_name: null },
    });
  });

  it('same id + a NAMED row ⇒ that row’s name (a re-pick is how a name arrives)', () => {
    const marca = marcaDaLinhaParaRascunhoShopee(linha(77, 'Acme Ltda'), armazenada);
    expect(marca).toEqual({ brand_id: 77, original_brand_name: 'Acme Ltda' });
    const e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.marca, marca);
    expect(atualizacaoAceita(e).patch).toEqual({ marca });
  });

  it('no stored brand (a new draft, or none chosen) ⇒ the row’s pair as is', () => {
    expect(marcaDaLinhaParaRascunhoShopee(linha(77, null), null)).toEqual({
      brand_id: 77,
      original_brand_name: null,
    });
  });

  it('"Sem marca" is the explicit choice brand_id 0, never null', () => {
    expect(MARCA_SEM_MARCA_RASCUNHO_SHOPEE).toEqual({ brand_id: 0, original_brand_name: null });
  });
});

describe('discard — base = the HELD projection, all five keys', () => {
  it('sends every projected field verbatim, attributes included (null) — never logistic_info', () => {
    const link = guardado({ item_name: '' });
    const corpo = corpoDescartarRascunhoShopee({
      contaId: CONTA,
      linkDocId: 'R1',
      produtoId: PRODUTO,
      projecao: projecaoGuardadaDoRascunhoShopee(null, link),
    });
    expect(corpo).toEqual({
      integracaoId: CONTA,
      produtoId: PRODUTO,
      linkDocId: 'R1',
      base: {
        item_name: '',
        description: null,
        category_id: 100087,
        marca: { brand_id: 77, original_brand_name: 'Acme' },
        attributes: null,
      },
    });
    expect(corpo.base).not.toHaveProperty('logistic_info');
    expect(corpoDescartarRascunhoShopeeSchema.safeParse(corpo).success).toBe(true);
  });

  it('⛔ a draft STORING attributes sends them as its base — the projection’s reading, never null (a null would 409 every discard)', () => {
    const link = guardado({
      attributes: [
        {
          attribute_id: 0,
          attribute_value_list: [{ value_id: 0, original_value_name: ' Algodão ' }],
        },
      ],
    });
    const corpo = corpoDescartarRascunhoShopee({
      contaId: CONTA,
      linkDocId: 'R1',
      produtoId: PRODUTO,
      projecao: projecaoGuardadaDoRascunhoShopee(null, link),
    });
    // THE projection decodes the stored list (the route compares against the same reading).
    expect(corpo.base.attributes).toEqual(camposDoRascunhoShopee(link).attributes);
    expect(corpo.base.attributes).toHaveLength(1);
    expect(corpoDescartarRascunhoShopeeSchema.safeParse(corpo).success).toBe(true);
  });

  it('the attestation rides only as a literal true, and changes NOTHING else (the dialog’s (a) and (b) both send it)', () => {
    const args = {
      contaId: CONTA,
      linkDocId: 'R1',
      produtoId: PRODUTO,
      projecao: projecaoGuardadaDoRascunhoShopee(null, guardado()),
    };
    const semAtestar = corpoDescartarRascunhoShopee(args);
    expect(semAtestar).not.toHaveProperty('confirmarCriacaoIncerta');
    // The attested re-send is the SAME discard (same base) plus the flag — the
    // operator attests, and still discards only what they saw.
    expect(corpoDescartarRascunhoShopee({ ...args, confirmarCriacaoIncerta: true })).toEqual({
      ...semAtestar,
      confirmarCriacaoIncerta: true,
    });
    expect(
      corpoDescartarRascunhoShopee({ ...args, confirmarCriacaoIncerta: false }),
    ).not.toHaveProperty('confirmarCriacaoIncerta');
    expect(
      corpoDescartarRascunhoShopeeSchema.safeParse(
        corpoDescartarRascunhoShopee({ ...args, confirmarCriacaoIncerta: true }),
      ).success,
    ).toBe(true);
  });

  it('the held projection is the dirty entry’s base, never the newer snapshot ⟷ no entry ⇒ the snapshot', () => {
    const v1 = guardado();
    const v2 = guardado({ item_name: 'Mudado em outra aba' });
    const sujo = comCampoRascunhoShopee(edicaoDe(v1), CAMPO_RASCUNHO_SHOPEE.description, 'x');
    expect(projecaoGuardadaDoRascunhoShopee(sujo, v2).item_name).toBe('Camiseta');
    expect(projecaoGuardadaDoRascunhoShopee(null, v2).item_name).toBe('Mudado em outra aba');
  });
});

describe('the entry over time (rev. 2a #7, DC §2.2)', () => {
  it('base: edited, then a snapshot with another stored title arrives ⇒ the save still names the ORIGINAL', () => {
    const v1 = guardado();
    const v2 = guardado({ item_name: 'Mudado em outra aba' });
    const e = comCampoRascunhoShopee(edicaoDe(v1), CAMPO_RASCUNHO_SHOPEE.itemName, 'Meu título');
    expect(
      conciliarEdicaoRascunhoShopee(e, { link: v2, snapshot: {}, servidorConfirmado: true }),
    ).toEqual({
      acao: 'manter',
    });
    expect(atualizacaoAceita(e).base).toEqual({ item_name: 'Camiseta' });
    // The stale check (the CONFLICT question) says the save will 409.
    expect(divergenciasDoServidorShopee(e, v2)).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
  });

  it('the stale check follows the id, not the name — another writer renaming the SAME brand is no conflict ⟷ a new id is', () => {
    const e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.marca, {
      brand_id: 99,
      original_brand_name: 'Outra',
    });
    expect(divergenciasDoServidorShopee(e, guardado({ original_brand_name: 'ACME' }))).toEqual([]);
    expect(divergenciasDoServidorShopee(e, guardado({ brand_id: 78 }))).toEqual([
      CAMPO_RASCUNHO_SHOPEE.marca,
    ]);
  });

  it('after a 2xx the entry shows what was SAVED (normalised), read-only, until the snapshot moves', () => {
    const snapshot = [{ id: 'R1' }];
    let e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.description, '   ');
    e = comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo');
    const salvo = marcarRascunhoShopeeSalvo(e, snapshot);
    expect(salvo.novo).toBe(false);
    expect(salvo.atual.description).toBeNull();
    expect(edicaoRascunhoShopeeSuja(salvo)).toBe(false);
    expect(planoDoRascunhoShopee(salvo, LIVRE).impedimento).toBe('aguardando-servidor');
    expect(
      conciliarEdicaoRascunhoShopee(salvo, {
        link: guardado(),
        snapshot,
        servidorConfirmado: true,
      }),
    ).toEqual({ acao: 'manter' });
    // ANY newer snapshot drops it — the held projection is re-read, never rebuilt from the patch.
    expect(
      conciliarEdicaoRascunhoShopee(salvo, {
        link: guardado({ item_name: 'Novo' }),
        snapshot: [{ id: 'R1' }],
        servidorConfirmado: true,
      }),
    ).toEqual({ acao: 'largar', aviso: null });
  });

  it('typing into a just-saved entry ends its bridge (the save then compares against the PRE-save base)', () => {
    const salvo = marcarRascunhoShopeeSalvo(
      comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo'),
      [],
    );
    const depois = comCampoRascunhoShopee(salvo, CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo 2');
    expect(depois.salvo).toBeNull();
    expect(edicaoRascunhoShopeeSuja(depois)).toBe(true);
  });

  it('a dirty entry whose draft became a listing is dropped WITH a notice ⟷ a clean one silently', () => {
    const publicado = guardado({ item_id: 1000001 });
    const sujo = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.itemName, 'X');
    expect(
      conciliarEdicaoRascunhoShopee(sujo, {
        link: publicado,
        snapshot: [],
        servidorConfirmado: true,
      }),
    ).toEqual({ acao: 'largar', aviso: FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE });
    expect(
      conciliarEdicaoRascunhoShopee(edicaoDe(guardado()), {
        link: publicado,
        snapshot: [],
        servidorConfirmado: true,
      }),
    ).toEqual({ acao: 'largar', aviso: null });
  });

  it('a dirty entry whose draft vanished from a SERVER snapshot is dropped with a notice ⟷ a cached one proves nothing', () => {
    const sujo = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.itemName, 'X');
    expect(
      conciliarEdicaoRascunhoShopee(sujo, {
        link: undefined,
        snapshot: [],
        servidorConfirmado: true,
      }),
    ).toEqual({ acao: 'largar', aviso: FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE });
    expect(
      conciliarEdicaoRascunhoShopee(sujo, {
        link: undefined,
        snapshot: [],
        servidorConfirmado: false,
      }),
    ).toEqual({ acao: 'manter' });
  });

  it('a CLEAN stored entry is dropped (the snapshot renders, always current) ⟷ a new one is kept', () => {
    expect(
      conciliarEdicaoRascunhoShopee(edicaoDe(guardado()), {
        link: guardado({ item_name: 'Outro' }),
        snapshot: [],
        servidorConfirmado: true,
      }),
    ).toEqual({ acao: 'largar', aviso: null });
    const novo = novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto: 'X' });
    for (const link of [undefined, guardado()]) {
      expect(
        conciliarEdicaoRascunhoShopee(novo, { link, snapshot: [], servidorConfirmado: true }),
      ).toEqual({ acao: 'manter' });
    }
  });
});

describe('rev. 2a #19 — the create retry’s «Salvar mesmo assim» is an ordinary update against the STORED draft', () => {
  const novo = (nome: string, categoria: number | null) =>
    comCampoRascunhoShopee(
      novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto: nome }),
      CAMPO_RASCUNHO_SHOPEE.categoryId,
      categoria,
    );

  it('⛔ differing only in category_id ⇒ the base carries attributes (never a 400)', () => {
    const armazenado = guardado({ category_id: null, brand_id: null, original_brand_name: null });
    const e = rebasearEdicaoRascunhoShopee(novo('Camiseta', 100087), armazenado);
    expect(e.novo).toBe(false);
    const corpo = atualizacaoAceita(e);
    expect(corpo.patch).toEqual({ category_id: 100087 });
    expect(corpo.base).toEqual({ category_id: null, attributes: null });
  });

  it('NEAR-MISS: differing only in item_name ⇒ base {item_name}', () => {
    const armazenado = guardado({ item_name: 'Outro', category_id: null, brand_id: null });
    const corpo = atualizacaoAceita(
      rebasearEdicaoRascunhoShopee(novo('Camiseta', null), armazenado),
    );
    expect(corpo.patch).toEqual({ item_name: 'Camiseta' });
    expect(corpo.base).toEqual({ item_name: 'Outro' });
  });

  it('«Usar o que está salvo» takes the stored values for the named fields only', () => {
    const e = comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.itemName, 'Meu');
    const usado = rebasearEdicaoRascunhoShopee(
      comCampoRascunhoShopee(e, CAMPO_RASCUNHO_SHOPEE.description, 'Minha'),
      guardado({ item_name: 'Deles', description: 'Deles também' }),
      [CAMPO_RASCUNHO_SHOPEE.itemName],
    );
    expect(usado.atual.item_name).toBe('Deles');
    expect(usado.atual.description).toBe('Minha');
    expect(usado.base.item_name).toBe('Deles');
  });
});

describe('the second listing (D15) — the SAME set the route refuses with', () => {
  const vivo = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    data: { contaProdutoShopeeOuterRef: `integracao/${CONTA}`, item_id: 1000001, ...extra },
  });

  it('NEAR-MISS: a conta holding only a REMOVED listing asks nothing ⟷ a superseded-but-live one asks', () => {
    expect(
      segundoAnuncioNaContaShopee([vivo('L1', { estadoAnuncio: 'removido' })], CONTA, []),
    ).toBeNull();
    expect(
      segundoAnuncioNaContaShopee([vivo('L1', { substituidoPorLinkDocId: 'L2' })], CONTA, []),
    ).toEqual({ quantidade: 1, comRascunho: false });
  });

  it('a stored draft counts (comRascunho); another conta’s link does not; an empty conta asks nothing', () => {
    expect(segundoAnuncioNaContaShopee([{ id: 'R1', data: guardado() }], CONTA, [])).toEqual({
      quantidade: 1,
      comRascunho: true,
    });
    expect(segundoAnuncioNaContaShopee([vivo('L1')], 'int-2', [])).toBeNull();
    expect(segundoAnuncioNaContaShopee([], CONTA, [])).toBeNull();
  });

  it('this screen’s LOCAL new drafts of the conta count once — never twice once their doc exists', () => {
    const local = novaEdicaoRascunhoShopee({
      linkDocId: ID_NOVO,
      contaId: CONTA,
      nomeProduto: 'X',
    });
    const deOutraConta = novaEdicaoRascunhoShopee({
      linkDocId: 'N2',
      contaId: 'int-2',
      nomeProduto: 'X',
    });
    expect(segundoAnuncioNaContaShopee([], CONTA, [local, deOutraConta])).toEqual({
      quantidade: 1,
      comRascunho: true,
    });
    expect(
      segundoAnuncioNaContaShopee([{ id: ID_NOVO, data: guardado() }], CONTA, [local]),
    ).toEqual({ quantidade: 1, comRascunho: true });
  });

  it('a JUST-created local draft (saved, its echo not arrived) still counts ⟷ NEAR-MISS: once its doc is in the snapshot it counts once', () => {
    const criado = marcarRascunhoShopeeSalvo(
      novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto: 'X' }),
      {},
    );
    expect(criado.novo).toBe(false);
    expect(segundoAnuncioNaContaShopee([], CONTA, [criado])).toEqual({
      quantidade: 1,
      comRascunho: true,
    });
    expect(
      segundoAnuncioNaContaShopee([{ id: ID_NOVO, data: guardado() }], CONTA, [criado]),
    ).toEqual({ quantidade: 1, comRascunho: true });
    // A clean STORED draft's entry (not saved, not new) never counts twice either.
    const guardadaLimpa = edicaoDoRascunhoGuardadoShopee({
      linkDocId: 'R1',
      contaId: CONTA,
      link: guardado(),
    });
    expect(segundoAnuncioNaContaShopee([], CONTA, [guardadaLimpa])).toBeNull();
  });

  it('a 409 rascunhoContaJaTemAnuncio’s vinculos give the same numbers', () => {
    expect(
      existentesDosVinculosShopee([
        { linkDocId: 'L1', itemId: 1000001, rascunho: false },
        { linkDocId: 'R1', itemId: null, rascunho: true },
      ]),
    ).toEqual({ quantidade: 2, comRascunho: true });
  });
});

describe('falhaDoRascunhoShopee — §C.2, by CLASS then by code', () => {
  const http = (
    status: number,
    code: string | null,
    detalhes: Partial<DetalhesErroShopee> = {},
    message = 'frase do servidor',
  ) =>
    new ShopeeClientHttpError(message, status, code, null, null, {
      ...DETALHES_ERRO_SHOPEE_VAZIOS,
      ...detalhes,
    });
  const F = CODIGO_FALHA_SHOPEE;

  it('CONFLITO: a field list opens the modal; [] is the retry sentence; null (deploy skew) the reload one', () => {
    const conflitos = [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Deles' }];
    expect(
      falhaDoRascunhoShopee(http(409, F.rascunhoConflito, { conflitos }), 'atualizar'),
    ).toEqual({
      tipo: 'conflito',
      conflitos,
    });
    expect(falhaDoRascunhoShopee(http(409, F.rascunhoConflito, { conflitos }), 'criar')).toEqual({
      tipo: 'conflito',
      conflitos,
    });
    expect(
      falhaDoRascunhoShopee(http(409, F.rascunhoConflito, { conflitos: [] }), 'atualizar'),
    ).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDoConflitoDeConcorrenciaShopee('atualizar'),
      incerto: false,
    });
    const nulo = falhaDoRascunhoShopee(
      http(409, F.rascunhoConflito, { conflitos: null }),
      'atualizar',
    );
    expect(nulo).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDoConflitoIlegivelShopee('atualizar'),
      incerto: false,
    });
  });

  it('CONFLITO on a discard is never a modal: the draft changed since it was opened', () => {
    const conflitos = [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Deles' }];
    expect(
      falhaDoRascunhoShopee(http(409, F.rascunhoConflito, { conflitos }), 'descartar'),
    ).toEqual({
      tipo: 'mensagem',
      mensagem: FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
      incerto: false,
    });
  });

  it('INEXISTENTE: the PRODUTO on a create (entry kept) ⟷ the DRAFT on an edit or a discard (entry dropped)', () => {
    const err = http(404, F.rascunhoInexistente);
    expect(falhaDoRascunhoShopee(err, 'criar')).toEqual({
      tipo: 'mensagem',
      mensagem: FRASE_PRODUTO_INEXISTENTE_SHOPEE,
      incerto: false,
    });
    for (const op of ['atualizar', 'descartar'] as const) {
      expect(falhaDoRascunhoShopee(err, op)).toEqual({
        tipo: 'largar',
        mensagem: FRASE_RASCUNHO_INEXISTENTE_SHOPEE,
      });
    }
  });

  it('JA_PUBLICADO drops the entry; CONTA_JA_TEM_ANUNCIO on a create asks for the second listing', () => {
    expect(falhaDoRascunhoShopee(http(409, F.rascunhoJaPublicado), 'atualizar')).toEqual({
      tipo: 'largar',
      mensagem: FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
    });
    const vinculos = [{ linkDocId: 'L1', itemId: 1000001, rascunho: false }];
    expect(
      falhaDoRascunhoShopee(http(409, F.rascunhoContaJaTemAnuncio, { vinculos }), 'criar'),
    ).toEqual({ tipo: 'segundo-anuncio', vinculos });
  });

  it('CONTA_JA_TEM_ANUNCIO whose vinculos could not be read still asks (an empty list, never a crash) ⟷ NEAR-MISS: off a create it is only the sentence — the confirmation re-sends a CREATE', () => {
    expect(
      falhaDoRascunhoShopee(http(409, F.rascunhoContaJaTemAnuncio, { vinculos: null }), 'criar'),
    ).toEqual({ tipo: 'segundo-anuncio', vinculos: [] });
    const vinculos = [{ linkDocId: 'L1', itemId: 1000001, rascunho: false }];
    for (const op of ['atualizar', 'descartar'] as const) {
      expect(
        falhaDoRascunhoShopee(http(409, F.rascunhoContaJaTemAnuncio, { vinculos }), op),
      ).toEqual({ tipo: 'mensagem', mensagem: 'frase do servidor', incerto: false });
    }
  });

  it('CRIACAO_INCERTA on a discard opens the three-case dialog ⟷ NEAR-MISS: on an edit it is only the sentence', () => {
    expect(falhaDoRascunhoShopee(http(409, F.rascunhoCriacaoIncerta), 'descartar')).toEqual({
      tipo: 'criacao-incerta',
    });
    expect(falhaDoRascunhoShopee(http(409, F.rascunhoCriacaoIncerta), 'atualizar')).toEqual({
      tipo: 'mensagem',
      mensagem: 'frase do servidor',
      incerto: false,
    });
  });

  it('EM_ANDAMENTO waits the seconds sent; the other codes read their own copy', () => {
    const em = falhaDoRascunhoShopee(
      http(409, F.publicacaoEmAndamento, { aguardarMs: 30_500 }),
      'atualizar',
    );
    expect(em).toMatchObject({ tipo: 'mensagem', incerto: false });
    expect(em.tipo === 'mensagem' ? em.mensagem : '').toContain('aguarde 31 s');
    expect(falhaDoRascunhoShopee(http(409, F.rascunhoCategoriaTravada), 'atualizar')).toMatchObject(
      {
        mensagem: FRASE_CATEGORIA_TRAVADA_SHOPEE,
      },
    );
    expect(falhaDoRascunhoShopee(http(409, F.rascunhoIdEmUso), 'criar')).toMatchObject({
      mensagem: FRASE_RASCUNHO_ID_EM_USO_SHOPEE,
    });
  });

  it('PRODUTO_INVALIDO narrows its motivo ⟷ NEAR-MISS: an unknown motivo keeps the server sentence', () => {
    expect(
      falhaDoRascunhoShopee(http(422, F.rascunhoProdutoInvalido, { motivo: 'filho' }), 'criar'),
    ).toMatchObject({ mensagem: FRASE_RASCUNHO_DE_VARIACAO_SHOPEE });
    expect(
      falhaDoRascunhoShopee(
        http(422, F.rascunhoProdutoInvalido, { motivo: 'kit-virtual' }),
        'criar',
      ),
    ).toMatchObject({ mensagem: FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE });
    expect(
      falhaDoRascunhoShopee(http(422, F.rascunhoProdutoInvalido, { motivo: 'novo' }), 'criar'),
    ).toMatchObject({ mensagem: 'frase do servidor' });
  });

  it('⛔ an UNREADABLE 2xx MAY have happened — never a success, read before its code', () => {
    for (const op of ['criar', 'atualizar', 'descartar'] as const) {
      const err = new ShopeeClientRespostaInvalidaError('faça o deploy', 200, ['gravados.0']);
      expect(falhaDoRascunhoShopee(err, op)).toEqual({
        tipo: 'mensagem',
        mensagem: fraseDaRespostaIlegivelDoRascunhoShopee(op),
        incerto: true,
      });
    }
  });

  it('no answer, or a 5xx after which the route may have written, is UNCERTAIN ⟷ a 501 is definite', () => {
    expect(falhaDoRascunhoShopee(new ShopeeClientNetworkError('rede'), 'atualizar')).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDaRespostaIncertaDoRascunhoShopee('atualizar'),
      incerto: true,
    });
    expect(falhaDoRascunhoShopee(http(504, null), 'criar')).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDaRespostaIncertaDoRascunhoShopee('criar'),
      incerto: true,
    });
    expect(falhaDoRascunhoShopee(http(501, null), 'criar')).toMatchObject({ incerto: false });
  });

  it('the CODELESS answers: the conta 404; the create’s no-title 400 names its draft ⟷ a schema 400 names nothing', () => {
    expect(falhaDoRascunhoShopee(http(404, null), 'atualizar')).toMatchObject({
      mensagem: FRASE_CONTA_NAO_ENCONTRADA_SHOPEE,
    });
    expect(falhaDoRascunhoShopee(http(400, null, { linkDocId: ID_NOVO }), 'criar')).toMatchObject({
      mensagem: FRASE_RASCUNHO_SEM_TITULO_SHOPEE,
    });
    expect(
      falhaDoRascunhoShopee(http(400, null, {}, '✖ linkDocId inválido'), 'criar'),
    ).toMatchObject({
      mensagem: '✖ linkDocId inválido',
    });
  });

  it('a publish-only code (P11’s) keeps the server sentence here', () => {
    expect(
      falhaDoRascunhoShopee(http(409, CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada), 'atualizar'),
    ).toMatchObject({ mensagem: 'frase do servidor' });
  });
});

describe('estadoDoBlocoRascunhoShopee — THE decision of a draft block', () => {
  const entrada = (
    over: Partial<EntradaDoBlocoRascunhoShopee> = {},
  ): EntradaDoBlocoRascunhoShopee => ({
    link: guardado(),
    edicao: null,
    nowMs: NOW,
    kitVirtual: false,
    servidorConfirmado: true,
    podeEditar: true,
    ocupado: false,
    ...over,
  });
  /** A lock as the publish writes it; `sku` stamped ⇔ a string (the pre-send stamp). */
  const trava = (desde: number, expiraEm: number, sku?: string) => ({
    desde,
    expiraEm,
    token: 't1',
    ...(sku === undefined ? {} : { sku }),
  });

  it('a saved draft reading livre: editable, nothing to save, Descartar with ONE confirmation', () => {
    const b = estadoDoBlocoRascunhoShopee(entrada());
    expect(b).toMatchObject({
      publicacao: { tipo: 'livre' },
      releituraEmMs: null,
      camposEditaveis: true,
      categoriaEditavel: true,
      podeSalvar: false,
      impedimento: 'nada-a-salvar',
      podeDescartar: true,
      descarte: 'confirmar',
      avisos: [],
    });
    expect(b.valores.item_name).toBe('Camiseta');
  });

  it('rev. 2a #16: a P5-minted draft (brand 0, no lock, no record) reads livre ⇒ Descartar with NO attestation dialog', () => {
    const b = estadoDoBlocoRascunhoShopee(
      entrada({
        link: guardado({ brand_id: 0, original_brand_name: null, publicacaoEmCurso: null }),
      }),
    );
    expect(b.publicacao.tipo).toBe('livre');
    expect(b.descarte).toBe('confirmar');
  });

  it('server truth: no entry + a cached snapshot ⇒ read-only, "Carregando…" ⟷ an entry keeps editing through a re-listen', () => {
    const b = estadoDoBlocoRascunhoShopee(entrada({ servidorConfirmado: false }));
    expect(b.camposEditaveis).toBe(false);
    expect(b.podeDescartar).toBe(false);
    expect(b.avisos).toEqual([FRASE_RASCUNHO_CARREGANDO_SHOPEE]);
    const comEntrada = estadoDoBlocoRascunhoShopee(
      entrada({
        servidorConfirmado: false,
        edicao: comCampoRascunhoShopee(
          edicaoDe(guardado()),
          CAMPO_RASCUNHO_SHOPEE.itemName,
          'Novo',
        ),
      }),
    );
    expect(comEntrada.camposEditaveis).toBe(true);
    expect(comEntrada.podeSalvar).toBe(true);
    expect(comEntrada.valores.item_name).toBe('Novo');
  });

  it('em-andamento (a live lock): nothing editable, nothing sent, one clock re-read at aguardarMs + 1 s', () => {
    const link = guardado({ publicacaoEmCurso: trava(NOW - 1_000, NOW + 5_000) });
    const sujo = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Novo',
    );
    const b = estadoDoBlocoRascunhoShopee(entrada({ link, edicao: sujo }));
    expect(b.publicacao.tipo).toBe('em-andamento');
    expect(b.releituraEmMs).toBe(5_000 + MARGEM_DA_RELEITURA_DO_ESTADO_SHOPEE_MS);
    expect(b).toMatchObject({
      camposEditaveis: false,
      podeSalvar: false,
      impedimento: 'publicacao-em-andamento',
      podeDescartar: false,
      podeDesfazer: true,
      sujo: true,
    });
    expect(b.avisos[0]).toContain('está sendo publicado');
  });

  it('⛔ the clock is a parameter: a STAMPED lock in its grace turns incerta once re-read ⟷ the frozen instant stays em-andamento', () => {
    // Stamped (`sku`), expired, 1 s of grace left.
    const expiraEm = NOW - (AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1_000);
    const link = guardado({ publicacaoEmCurso: trava(expiraEm - 300_000, expiraEm, 'X') });
    const agora = estadoDoBlocoRascunhoShopee(entrada({ link }));
    expect(agora.publicacao).toMatchObject({
      tipo: 'em-andamento',
      posExpiracao: true,
      aguardarMs: 1_000,
    });
    expect(agora.releituraEmMs).toBe(2_000);
    const relida = estadoDoBlocoRascunhoShopee(
      entrada({ link, nowMs: NOW + (agora.releituraEmMs ?? 0) }),
    );
    expect(relida.publicacao.tipo).toBe('incerta');
    expect(relida.avisos).toEqual([FRASE_RASCUNHO_INCERTO_SHOPEE]);
    expect(relida.releituraEmMs).toBeNull();
    // The same instant, read again, says the same thing — only a NEW clock moves it.
    expect(estadoDoBlocoRascunhoShopee(entrada({ link })).publicacao.tipo).toBe('em-andamento');
  });

  it('§H Q3: an EXPIRED lock never stamped (no sku), no record ⇒ livre at once ⟷ stamped with "" ⇒ still em-andamento', () => {
    const expirada = trava(NOW - 400_000, NOW - 100_000);
    expect(
      estadoDoBlocoRascunhoShopee(entrada({ link: guardado({ publicacaoEmCurso: expirada }) }))
        .publicacao,
    ).toEqual({ tipo: 'livre' });
    const carimbadaVazia = trava(NOW - 400_000, NOW - 100_000, '');
    expect(
      estadoDoBlocoRascunhoShopee(
        entrada({ link: guardado({ publicacaoEmCurso: carimbadaVazia }) }),
      ).publicacao.tipo,
    ).toBe('em-andamento');
  });

  it('incerta: editable except the category; Descartar asks for the Seller-Centre attestation', () => {
    const link = guardado({ criacaoIncertaDesde: NOW - 600_000 });
    const b = estadoDoBlocoRascunhoShopee(entrada({ link }));
    expect(b).toMatchObject({
      publicacao: { tipo: 'incerta' },
      camposEditaveis: true,
      categoriaEditavel: false,
      descarte: 'atestar',
      podeDescartar: true,
    });
    expect(b.avisos).toEqual([FRASE_RASCUNHO_INCERTO_SHOPEE]);
  });

  it('kit virtual: no editor, the refusal notice, Descartar only — even with typed work', () => {
    const sujo = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Novo',
    );
    const b = estadoDoBlocoRascunhoShopee(entrada({ kitVirtual: true, edicao: sujo }));
    expect(b).toMatchObject({ camposEditaveis: false, podeSalvar: false, podeDescartar: true });
    expect(b.avisos[0]).toBe(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE);
  });

  it('a LOCAL new draft: its notice, Salvar once the title is usable, a local discard', () => {
    const novo = novaEdicaoRascunhoShopee({
      linkDocId: ID_NOVO,
      contaId: CONTA,
      nomeProduto: 'Camiseta',
    });
    const b = estadoDoBlocoRascunhoShopee(
      entrada({ link: null, edicao: novo, servidorConfirmado: false }),
    );
    expect(b).toMatchObject({
      novo: true,
      camposEditaveis: true,
      podeSalvar: true,
      podeDesfazer: false,
      podeDescartar: true,
      descarte: 'local',
    });
    expect(b.avisos).toEqual([FRASE_RASCUNHO_NOVO_SHOPEE]);
  });

  it('just saved: read-only and waiting for the server; nothing to save or discard', () => {
    const salvo = marcarRascunhoShopeeSalvo(
      comCampoRascunhoShopee(edicaoDe(guardado()), CAMPO_RASCUNHO_SHOPEE.itemName, 'Novo'),
      [],
    );
    const b = estadoDoBlocoRascunhoShopee(entrada({ edicao: salvo }));
    expect(b).toMatchObject({
      camposEditaveis: false,
      podeSalvar: false,
      podeDescartar: false,
      sujo: false,
      impedimento: 'aguardando-servidor',
    });
    expect(b.valores.item_name).toBe('Novo');
    expect(b.avisos).toEqual([FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE]);
  });

  it('who may author: without the write bits (or while a write runs) nothing is offered', () => {
    const sujo = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Novo',
    );
    for (const over of [{ podeEditar: false }, { ocupado: true }]) {
      const b = estadoDoBlocoRascunhoShopee(entrada({ edicao: sujo, ...over }));
      expect(b).toMatchObject({
        camposEditaveis: false,
        podeSalvar: false,
        podeDesfazer: false,
        podeDescartar: false,
      });
    }
  });

  it('campos = the form values over the HELD projection — what the pendências read', () => {
    const atributos = [{ attribute_id: 10, attribute_value_list: [{ value_id: 5 }] }];
    const link = guardado({ attributes: atributos, brand_id: null, original_brand_name: null });
    const sujo = comCampoRascunhoShopee(edicaoDe(link), CAMPO_RASCUNHO_SHOPEE.itemName, '   ');
    const b = estadoDoBlocoRascunhoShopee(entrada({ link, edicao: sujo }));
    expect(b.campos).toMatchObject({
      item_name: '   ',
      category_id: 100087,
      attributes: atributos,
    });
    const tipos = pendenciasDoRascunhoShopee(b.campos, {
      nomeProduto: null,
      descricaoProduto: 'Descrição do produto',
      limites: null,
    }).map((p) => p.tipo);
    expect(tipos).toEqual(['sem-nome', 'marca-nao-escolhida']);
    // NEAR-MISS: the stored produto's nome fills a blank title, as the publish does.
    expect(
      pendenciasDoRascunhoShopee(b.campos, {
        nomeProduto: 'Camiseta',
        descricaoProduto: 'Descrição do produto',
        limites: null,
      }).map((p) => p.tipo),
    ).toEqual(['marca-nao-escolhida']);
  });

  it('warns before a category change only when the HELD projection stores attributes ⟷ null or []', () => {
    const com = guardado({
      attributes: [{ attribute_id: 10, attribute_value_list: [{ value_id: 5 }] }],
    });
    expect(estadoDoBlocoRascunhoShopee(entrada({ link: com })).atributosGravados).toBe(true);
    expect(estadoDoBlocoRascunhoShopee(entrada()).atributosGravados).toBe(false);
    expect(
      estadoDoBlocoRascunhoShopee(entrada({ link: guardado({ attributes: [] }) }))
        .atributosGravados,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                     #1911 P11 — Publicar on a draft                         */
/* -------------------------------------------------------------------------- */

describe('publicacaoDoRascunhoShopee — THE decision of a draft’s Publicar (rev. 2a §D P11)', () => {
  const LIMITES = {
    itemNameLengthLimit: { min: 1, max: 120 },
    itemDescriptionLengthLimit: { min: 1, max: 3000 },
  };
  const TEXTOS = { nomeProduto: 'Camiseta', descricaoProduto: 'Algodão' };
  const blocoDe = (over: Partial<EntradaDoBlocoRascunhoShopee> = {}) =>
    estadoDoBlocoRascunhoShopee({
      link: guardado(),
      edicao: null,
      nowMs: NOW,
      kitVirtual: false,
      servidorConfirmado: true,
      podeEditar: true,
      ocupado: false,
      ...over,
    });
  const decidir = (
    over: Partial<EntradaDaPublicacaoDoRascunhoShopee> = {},
    bloco: Partial<EntradaDoBlocoRascunhoShopee> = {},
  ) =>
    publicacaoDoRascunhoShopee({
      bloco: blocoDe(bloco),
      podeEditar: true,
      ocupado: false,
      servidorConfirmado: true,
      produtoSujo: false,
      textosDoProduto: TEXTOS,
      limites: LIMITES,
      ...over,
    });
  /** A lock as the publish writes it; `sku` stamped ⇔ a string (the pre-send stamp). */
  const trava = (desde: number, expiraEm: number, sku?: string) => ({
    desde,
    expiraEm,
    token: 't1',
    ...(sku === undefined ? {} : { sku }),
  });

  it('⭐ a saved, clean, complete draft with its bands loaded ⇒ Publicar acts', () => {
    expect(decidir()).toEqual({
      podePublicar: true,
      impedimento: null,
      pendencias: [],
      aviso: null,
    });
  });

  it('(e) the bands must be LOADED: `limites: null` lists no band pendência, so it is an impediment of its own', () => {
    const semFaixas = decidir({ limites: null });
    expect(semFaixas).toMatchObject({
      podePublicar: false,
      impedimento: 'faixas-desconhecidas',
      pendencias: [],
      aviso: FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
    });
    // NEAR-MISS: loaded bands that the title breaks are a PENDÊNCIA (the list says why).
    const longo = decidir({}, { link: guardado({ item_name: 'x'.repeat(121) }) });
    expect(longo.impedimento).toBe('pendencias');
    expect(longo.pendencias.map((p) => p.tipo)).toEqual(['titulo-fora-da-faixa']);
  });

  it('a draft with no category (and no bands): the categoria pendência speaks first', () => {
    const r = decidir({ limites: null }, { link: guardado({ category_id: null }) });
    expect(r.impedimento).toBe('pendencias');
    expect(r.pendencias.map((p) => p.tipo)).toEqual(['categoria-ausente']);
    expect(r.aviso).toBeNull();
  });

  it('pendências read the STORED produto texts: a brand not chosen blocks ⟷ «Sem marca» (0) does not', () => {
    const semMarca = decidir({}, { link: guardado({ brand_id: null, original_brand_name: null }) });
    expect(semMarca.impedimento).toBe('pendencias');
    expect(semMarca.pendencias.map((p) => p.tipo)).toEqual(['marca-nao-escolhida']);
    expect(
      decidir({}, { link: guardado({ brand_id: 0, original_brand_name: null }) }).podePublicar,
    ).toBe(true);
  });

  it('saved ∧ clean: a local draft ⇒ «Salve o rascunho»; a dirty one ⇒ «Salve as alterações»', () => {
    const novo = novaEdicaoRascunhoShopee({ linkDocId: ID_NOVO, contaId: CONTA, nomeProduto: 'X' });
    expect(decidir({}, { link: null, edicao: novo })).toMatchObject({
      impedimento: 'rascunho-novo',
      aviso: FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
    });
    const sujo = comCampoRascunhoShopee(
      edicaoDe(guardado()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Outro título',
    );
    expect(decidir({}, { edicao: sujo })).toMatchObject({
      impedimento: 'alteracoes-nao-salvas',
      aviso: FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
    });
    // NEAR-MISS: an entry typed back to the stored value is clean.
    const devolta = comCampoRascunhoShopee(sujo, CAMPO_RASCUNHO_SHOPEE.itemName, 'Camiseta');
    expect(decidir({}, { edicao: devolta }).podePublicar).toBe(true);
    // Just saved: waiting for the listener, read-only, no Publicar yet.
    const salvo = marcarRascunhoShopeeSalvo(sujo, {});
    expect(decidir({}, { edicao: salvo }).impedimento).toBe('aguardando-servidor');
  });

  it('K2-7: the produto form must be clean — the publish reads the STORED produto', () => {
    expect(decidir({ produtoSujo: true })).toMatchObject({
      impedimento: 'produto-nao-salvo',
      aviso: FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
    });
  });

  it('em-andamento blocks ⟷ `incerta` does NOT (its publish is a real one: ENSURE first)', () => {
    const vivo = decidir(
      {},
      { link: guardado({ publicacaoEmCurso: trava(NOW - 1, NOW + 60_000) }) },
    );
    expect(vivo.impedimento).toBe('publicacao-em-andamento');
    const incerta = decidir({}, { link: guardado({ criacaoIncertaDesde: NOW - 600_000 }) });
    expect(incerta.podePublicar).toBe(true);
  });

  it("§H Q3: an expired UNSTAMPED lock with no record reads livre ⇒ Publicar ⟷ the same lock STAMPED (`X` or `''`) is still in its grace", () => {
    const expirada = trava(NOW - 400_000, NOW - 1);
    expect(decidir({}, { link: guardado({ publicacaoEmCurso: expirada }) }).podePublicar).toBe(
      true,
    );
    for (const sku of ['X', '']) {
      expect(
        decidir({}, { link: guardado({ publicacaoEmCurso: trava(NOW - 400_000, NOW - 1, sku) }) })
          .impedimento,
        sku,
      ).toBe('publicacao-em-andamento');
    }
  });

  it('server truth, the produto texts, the write in flight, the virtual kit and the permission each block', () => {
    expect(decidir({ servidorConfirmado: false }).impedimento).toBe('carregando');
    expect(decidir({ textosDoProduto: null })).toMatchObject({
      impedimento: 'carregando',
      pendencias: [],
    });
    expect(decidir({ ocupado: true }).impedimento).toBe('ocupado');
    expect(decidir({}, { kitVirtual: true })).toMatchObject({
      impedimento: 'kit-virtual',
      pendencias: [],
    });
    expect(decidir({ podeEditar: false }).impedimento).toBe('sem-permissao');
  });
});

describe('corpoPublicarRascunhoShopee — a draft is published by its link ALONE', () => {
  it('⭐ the plain publish: the three ids and nothing else — no categoryId, no kit flag, no status', () => {
    expect(
      corpoPublicarRascunhoShopee({
        contaId: CONTA,
        produtoId: PRODUTO,
        linkDocId: 'R1',
        pausado: false,
      }),
    ).toStrictEqual({ integracaoId: CONTA, produtoId: PRODUTO, linkDocId: 'R1' });
  });

  it('«Criar pausado» ⇒ UNLIST; each confirmation only when given — never `false`', () => {
    expect(
      corpoPublicarRascunhoShopee({
        contaId: CONTA,
        produtoId: PRODUTO,
        linkDocId: 'R1',
        pausado: true,
        confirmarSegundoAnuncio: true,
        confirmarCriacaoIncerta: true,
      }),
    ).toStrictEqual({
      integracaoId: CONTA,
      produtoId: PRODUTO,
      linkDocId: 'R1',
      status: 'UNLIST',
      confirmarSegundoAnuncio: true,
      confirmarCriacaoIncerta: true,
    });
    const semFlags = corpoPublicarRascunhoShopee({
      contaId: CONTA,
      produtoId: PRODUTO,
      linkDocId: 'R1',
      pausado: false,
      confirmarSegundoAnuncio: false,
      confirmarCriacaoIncerta: false,
    });
    expect(Object.keys(semFlags).sort()).toEqual(['integracaoId', 'linkDocId', 'produtoId']);
  });
});

describe('segundoAnuncioNaContaShopee for a PUBLISH — the draft itself is left out (g)', () => {
  const vivo = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    data: { contaProdutoShopeeOuterRef: `integracao/${CONTA}`, item_id: 1000001, ...extra },
  });

  it('a conta holding only the draft being published asks nothing ⟷ WITHOUT the exclusion it counts itself', () => {
    const links = [{ id: 'R1', data: guardado() }];
    expect(segundoAnuncioNaContaShopee(links, CONTA, [], 'R1')).toBeNull();
    expect(segundoAnuncioNaContaShopee(links, CONTA, [])).toEqual({
      quantidade: 1,
      comRascunho: true,
    });
  });

  it('a live sibling listing asks ⟷ a REMOVED-only sibling asks nothing', () => {
    expect(
      segundoAnuncioNaContaShopee([{ id: 'R1', data: guardado() }, vivo('L1')], CONTA, [], 'R1'),
    ).toEqual({ quantidade: 1, comRascunho: false });
    expect(
      segundoAnuncioNaContaShopee(
        [{ id: 'R1', data: guardado() }, vivo('L1', { estadoAnuncio: 'removido' })],
        CONTA,
        [],
        'R1',
      ),
    ).toBeNull();
  });

  it('an entry OF the excluded draft never counts as a local one', () => {
    const salvo = marcarRascunhoShopeeSalvo(
      novaEdicaoRascunhoShopee({ linkDocId: 'R1', contaId: CONTA, nomeProduto: 'X' }),
      {},
    );
    expect(segundoAnuncioNaContaShopee([], CONTA, [salvo], 'R1')).toBeNull();
    expect(segundoAnuncioNaContaShopee([], CONTA, [salvo])).toEqual({
      quantidade: 1,
      comRascunho: true,
    });
  });
});

describe('falhaDaPublicacaoDoRascunhoShopee — §C.2 for a DRAFT’s Publicar, by CLASS then by code', () => {
  const http = (
    status: number,
    code: string | null,
    detalhes: Partial<DetalhesErroShopee> = {},
    message = 'frase do servidor',
    kind: string | null = null,
  ) =>
    new ShopeeClientHttpError(message, status, code, null, kind, {
      ...DETALHES_ERRO_SHOPEE_VAZIOS,
      ...detalhes,
    });
  const F = CODIGO_FALHA_SHOPEE;

  it('#15: no trustworthy answer — network, an unreadable 2xx, a codeless 5xx (the 504) — is `sem-resposta`, never a failure', () => {
    expect(
      falhaDaPublicacaoDoRascunhoShopee(new ShopeeClientNetworkError('rede', new TypeError('x'))),
    ).toEqual({ tipo: 'sem-resposta' });
    expect(
      falhaDaPublicacaoDoRascunhoShopee(
        new ShopeeClientRespostaInvalidaError('ilegível', 202, ['recusa']),
      ),
    ).toEqual({ tipo: 'sem-resposta' });
    for (const status of [500, 502, 503, 504]) {
      expect(falhaDaPublicacaoDoRascunhoShopee(http(status, null)), String(status)).toEqual({
        tipo: 'sem-resposta',
      });
    }
    // A coded 5xx other than 502 too (the route may have written before it failed).
    expect(falhaDaPublicacaoDoRascunhoShopee(http(503, 'SHOPEE_NETWORK_ERROR'))).toEqual({
      tipo: 'sem-resposta',
    });
    // NEAR-MISS: 501 is a fact about the deployment — the publish's own reading.
    expect(falhaDaPublicacaoDoRascunhoShopee(http(501, null))).toBeNull();
  });

  it('§H Q2: a CODED 502 is definite — the rate limit its own copy, any other the server sentence + the exit', () => {
    // Both of Shopee's rate limits — the burst and the daily quota.
    for (const kind of ['burst', 'daily']) {
      expect(
        falhaDaPublicacaoDoRascunhoShopee(http(502, 'SHOPEE_HTTP_ERROR', {}, 'x', kind)),
        kind,
      ).toEqual({ tipo: 'mensagem', mensagem: FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE });
    }
    // NEAR-MISS: a transient Shopee hiccup is no rate limit — the interrupted-publish copy.
    expect(
      falhaDaPublicacaoDoRascunhoShopee(http(502, 'SHOPEE_HTTP_ERROR', {}, 'x', 'transient')),
    ).toEqual({ tipo: 'mensagem', mensagem: fraseDaPublicacaoInterrompidaShopee('x') });
    const outro = falhaDaPublicacaoDoRascunhoShopee(
      http(502, 'SHOPEE_HTTP_ERROR', {}, 'offset fora do limite'),
    );
    expect(outro).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDaPublicacaoInterrompidaShopee('offset fora do limite'),
    });
  });

  it('#6 EM_ANDAMENTO: a sibling (vinculos) vs the own lock — never keyed on aguardarMs alone', () => {
    const vinculos = [{ linkDocId: 'R2', itemId: null, rascunho: true }];
    expect(
      falhaDaPublicacaoDoRascunhoShopee(
        http(409, F.publicacaoEmAndamento, { aguardarMs: 9_000, vinculos }),
      ),
    ).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDaPublicacaoDoRascunhoEmAndamentoShopee({ aguardarMs: 9_000, vinculos }),
    });
    const proprio = falhaDaPublicacaoDoRascunhoShopee(
      http(409, F.publicacaoEmAndamento, { aguardarMs: 9_000 }),
    );
    expect(proprio).toMatchObject({ tipo: 'mensagem' });
    expect(proprio?.tipo === 'mensagem' ? proprio.mensagem : '').not.toContain('Outro vínculo');
  });

  it('EXPIRADA, CONTENCAO, CRIACAO_INCERTA (no window) and JA_PUBLICADO: the publish’s own copy', () => {
    expect(
      falhaDaPublicacaoDoRascunhoShopee(
        http(409, F.publicacaoExpirada, {}, 'a busca não coube no tempo desta requisição'),
      ),
    ).toEqual({
      tipo: 'mensagem',
      mensagem: fraseDaPublicacaoExpiradaShopee('a busca não coube no tempo desta requisição'),
    });
    expect(falhaDaPublicacaoDoRascunhoShopee(http(409, F.rascunhoContencao))).toEqual({
      tipo: 'mensagem',
      mensagem: FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
    });
    expect(falhaDaPublicacaoDoRascunhoShopee(http(409, F.rascunhoCriacaoIncerta))).toEqual({
      tipo: 'mensagem',
      mensagem: FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
    });
    expect(falhaDaPublicacaoDoRascunhoShopee(http(409, F.rascunhoJaPublicado))).toEqual({
      tipo: 'mensagem',
      mensagem: FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
    });
  });

  it('K1-4: CONTA_JA_TEM_ANUNCIO re-asks the second-listing warning from `vinculos` (unreadable ⇒ [])', () => {
    const vinculos = [{ linkDocId: 'L1', itemId: 1000001, rascunho: false }];
    expect(
      falhaDaPublicacaoDoRascunhoShopee(http(409, F.rascunhoContaJaTemAnuncio, { vinculos })),
    ).toEqual({ tipo: 'segundo-anuncio', vinculos });
    expect(falhaDaPublicacaoDoRascunhoShopee(http(409, F.rascunhoContaJaTemAnuncio))).toEqual({
      tipo: 'segundo-anuncio',
      vinculos: [],
    });
  });

  it('#14: a 404 on a draft is «o rascunho não existe mais» ⟷ NEAR-MISS: the 422 rows, the quota pause and other 4xx keep the publish’s reading', () => {
    expect(falhaDaPublicacaoDoRascunhoShopee(http(404, F.anuncioNaoEncontrado))).toEqual({
      tipo: 'mensagem',
      mensagem: FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
    });
    for (const [status, code] of [
      [422, F.publicacaoBloqueada],
      [422, F.publicacaoRecusada],
      [409, F.contaPausada],
      [404, F.anuncioSemVinculo],
      [400, null],
      [403, null],
    ] as const) {
      expect(falhaDaPublicacaoDoRascunhoShopee(http(status, code)), `${status} ${code}`).toBeNull();
    }
  });
});

describe('saidasDoProblemaShopee — the Seller-Centre exits, keyed on the slug EXACTLY (§C #7, #8)', () => {
  const T = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;
  const M = MOTIVO_ANUNCIO_SHOPEE;
  const RASCUNHO = { ehRascunho: true } as const;
  const importar = (itemIds: number[], vinculados?: { itemId: number; produtoId: string }[]) => ({
    tipo: T.importar,
    itemIds,
    ...(vinculados === undefined ? {} : { vinculados }),
  });

  it('#7 sem-sku ⇒ ONE exit: the attested publish (it creates — adopts nothing)', () => {
    expect(
      saidasDoProblemaShopee({ motivo: M.criacaoIncertaSemSku, acao: null }, RASCUNHO),
    ).toEqual([
      { tipo: 'publicar-atestando', rotulo: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE, adota: [] },
    ]);
  });

  it('#8 ja-vinculada, every candidate linked ⇒ TWO exits: discard (no warning) and «segundo anúncio, de propósito»', () => {
    const saidas = saidasDoProblemaShopee(
      {
        motivo: M.criacaoIncertaJaVinculada,
        acao: importar([1000009], [{ itemId: 1000009, produtoId: PRODUTO }]),
      },
      RASCUNHO,
    );
    expect(saidas).toEqual([
      {
        tipo: 'descartar-atestando',
        rotulo: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
        aviso: null,
      },
      {
        tipo: 'publicar-atestando',
        rotulo: ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
        adota: [],
      },
    ]);
  });

  it('#8 MIXED (one linked + one UNLINKED definitivo): the publish promises ADOPTION, the discard warns the free id stays', () => {
    const saidas = saidasDoProblemaShopee(
      {
        motivo: M.criacaoIncertaJaVinculada,
        acao: importar([1000009, 1000011], [{ itemId: 1000009, produtoId: PRODUTO }]),
      },
      RASCUNHO,
    );
    expect(saidas).toEqual([
      {
        tipo: 'descartar-atestando',
        rotulo: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
        aviso: avisoDoDescarteComAnuncioSemVinculoShopee([1000011]),
      },
      {
        tipo: 'publicar-atestando',
        rotulo: rotuloDaPublicacaoQueAdotaShopee([1000011]),
        adota: [1000011],
      },
    ]);
    // Never «o anúncio não existe» on a ja-vinculada exit.
    for (const s of saidas) expect(s.rotulo).not.toContain('não existe');
  });

  it('both exits send the right route WITH the flag', () => {
    expect(
      corpoPublicarRascunhoShopee({
        contaId: CONTA,
        produtoId: PRODUTO,
        linkDocId: 'R1',
        pausado: false,
        confirmarCriacaoIncerta: true,
      }),
    ).toStrictEqual({
      integracaoId: CONTA,
      produtoId: PRODUTO,
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
    });
    const descarte = corpoDescartarRascunhoShopee({
      contaId: CONTA,
      linkDocId: 'R1',
      produtoId: PRODUTO,
      projecao: camposDoRascunhoShopee(guardado()),
      confirmarCriacaoIncerta: true,
    });
    expect(descarte.confirmarCriacaoIncerta).toBe(true);
    expect(corpoDescartarRascunhoShopeeSchema.safeParse(descarte).success).toBe(true);
  });

  it('NEAR-MISS: ambígua (both shapes), the two busca-*, the P5b look-up refusals ⇒ NO exit — the flag would not be honoured', () => {
    for (const problema of [
      { motivo: M.criacaoIncertaAmbigua, acao: importar([1000009], []) },
      { motivo: M.criacaoIncertaAmbigua, acao: null },
      { motivo: M.buscaDeAnuncioIncompleta, acao: null },
      { motivo: M.buscaDeAnuncioExistenteIncompleta, acao: null },
      { motivo: M.anuncioExistenteSemVinculo, acao: importar([1000009], []) },
      {
        motivo: M.anuncioExistenteDeOutroProduto,
        acao: importar([1000009], [{ itemId: 1000009, produtoId: 'p9' }]),
      },
    ]) {
      expect(saidasDoProblemaShopee(problema, RASCUNHO), problema.motivo).toEqual([]);
    }
  });

  it('NEAR-MISS: a renamed or merely similar slug ⇒ no exit (never a prefix match)', () => {
    for (const motivo of [
      'criacao-incerta',
      'criacao-incerta-sem-sku-v2',
      'Criacao-incerta-sem-sku',
    ]) {
      expect(saidasDoProblemaShopee({ motivo, acao: null }, RASCUNHO), motivo).toEqual([]);
    }
    // ja-vinculada renamed, WITH the importar it carries — `acao: null` alone
    // would be refused by the fail-closed branch and prove nothing about the slug.
    for (const motivo of [`${M.criacaoIncertaJaVinculada}-v2`, 'criacao-incerta-ja-vinculad']) {
      expect(
        saidasDoProblemaShopee(
          {
            motivo,
            acao: importar([1000009, 1000011], [{ itemId: 1000009, produtoId: PRODUTO }]),
          },
          RASCUNHO,
        ),
        motivo,
      ).toEqual([]);
    }
  });

  it('fail closed: ja-vinculada whose acao does not say which are linked ⇒ no exit; a live listing’s row ⇒ none', () => {
    expect(
      saidasDoProblemaShopee(
        { motivo: M.criacaoIncertaJaVinculada, acao: importar([1000009]) },
        RASCUNHO,
      ),
    ).toEqual([]);
    expect(
      saidasDoProblemaShopee({ motivo: M.criacaoIncertaJaVinculada, acao: null }, RASCUNHO),
    ).toEqual([]);
    expect(
      saidasDoProblemaShopee({ motivo: M.criacaoIncertaSemSku, acao: null }, { ehRascunho: false }),
    ).toEqual([]);
  });
});

describe('superficieDoCampoShopee — campo → the surface that fixes it (D17, DC §2.9)', () => {
  const M = MOTIVO_ANUNCIO_SHOPEE;
  const RASCUNHO = { ehRascunho: true, descricaoPropria: false } as const;
  const ANUNCIO = { ehRascunho: false, descricaoPropria: false } as const;
  const linha = (
    campo: string | null,
    motivo = 'qualquer',
    acao: ProblemaShopee['acao'] = null,
  ) => ({
    campo,
    motivo,
    acao,
  });

  it('the draft’s own fields route to the draft ⟷ a published listing’s go to Seller Centre (D8)', () => {
    expect(superficieDoCampoShopee(linha('item_name'), RASCUNHO)).toEqual({
      tipo: 'rascunho',
      campo: 'item_name',
      aviso: null,
    });
    expect(superficieDoCampoShopee(linha('category_id'), RASCUNHO)).toMatchObject({
      tipo: 'rascunho',
      campo: 'category_id',
    });
    expect(superficieDoCampoShopee(linha('item_name'), ANUNCIO)).toEqual({ tipo: 'seller-centre' });
    expect(superficieDoCampoShopee(linha('category_id'), ANUNCIO)).toEqual({
      tipo: 'seller-centre',
    });
  });

  it('description: the draft’s own text ⇒ the draft; none ⇒ the produto’s Descrição — on a listing likewise', () => {
    expect(
      superficieDoCampoShopee(linha('description'), { ehRascunho: true, descricaoPropria: true }),
    ).toMatchObject({ tipo: 'rascunho', campo: 'description' });
    expect(superficieDoCampoShopee(linha('description'), RASCUNHO)).toEqual({
      tipo: 'produto',
      campo: 'extraData',
    });
    expect(
      superficieDoCampoShopee(linha('description'), { ehRascunho: false, descricaoPropria: true }),
    ).toEqual({ tipo: 'seller-centre' });
    expect(superficieDoCampoShopee(linha('description'), ANUNCIO)).toEqual({
      tipo: 'produto',
      campo: 'extraData',
    });
  });

  it('brand: a Shopee REJECTION warns «a marca pode não valer» ⟷ `marca-nao-escolhida` never does (R-N-P11-5)', () => {
    expect(superficieDoCampoShopee(linha('brand', 'marca-invalida'), RASCUNHO)).toEqual({
      tipo: 'rascunho',
      campo: 'marca',
      aviso: FRASE_MARCA_PODE_NAO_VALER_SHOPEE,
    });
    expect(superficieDoCampoShopee(linha('brand', M.marcaNaoEscolhida), RASCUNHO)).toEqual({
      tipo: 'rascunho',
      campo: 'marca',
      aviso: null,
    });
    expect(superficieDoCampoShopee(linha('brand'), ANUNCIO)).toEqual({ tipo: 'seller-centre' });
  });

  it('⭐ item_sku is an ALLOW-LIST: the SKU only for de-outro-produto and an acao-less ambígua', () => {
    const SKU = { tipo: 'produto', campo: 'sku' };
    expect(
      superficieDoCampoShopee(linha('item_sku', M.anuncioExistenteDeOutroProduto), RASCUNHO),
    ).toEqual(SKU);
    expect(superficieDoCampoShopee(linha('item_sku', M.criacaoIncertaAmbigua), RASCUNHO)).toEqual(
      SKU,
    );
    // NEAR-MISS: the same ambígua WITH its importar is not the SKU's to fix.
    expect(
      superficieDoCampoShopee(
        linha('item_sku', M.criacaoIncertaAmbigua, {
          tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
          itemIds: [1000009],
        }),
        RASCUNHO,
      ),
    ).toBeNull();
    for (const motivo of [
      M.criacaoIncertaSemSku,
      M.criacaoIncertaJaVinculada,
      M.buscaDeAnuncioIncompleta,
      M.anuncioExistenteSemVinculo,
      M.buscaDeAnuncioExistenteIncompleta,
      M.anuncioSemelhanteExistente,
      // A renamed slug: the deny-list mutant would route it.
      'anuncio-existente-de-outro-produto-v2',
      'sku-invalido',
    ]) {
      expect(superficieDoCampoShopee(linha('item_sku', motivo), RASCUNHO), motivo).toBeNull();
      expect(superficieDoCampoShopee(linha('sku', motivo), RASCUNHO), motivo).toBeNull();
    }
    // The bare `sku` root reads the SAME allow-list (DC §2.9 names both roots) …
    expect(
      superficieDoCampoShopee(linha('sku', M.anuncioExistenteDeOutroProduto), RASCUNHO),
    ).toEqual(SKU);
    // … and its one real producer — the native kit's «já existe na Shopee» row
    // (campo `sku`, an `importar` acao) — is fixed by importing, never by the SKU.
    expect(
      superficieDoCampoShopee(
        linha('sku', 'kit-ja-existe-na-shopee', {
          tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
          itemIds: [1000009],
        }),
        ANUNCIO,
      ),
    ).toBeNull();
  });

  it('the produto’s fields, the size chart and the variations — on a draft and a listing alike', () => {
    for (const [campo, alvo] of [
      ['weight', 'pesoBrutoKg'],
      ['logistic_info', 'pesoBrutoKg'],
      ['dimension', 'alturaCm'],
      ['image', 'fotos'],
      ['gtin_code', 'gtin'],
      ['original_price', 'precos'],
      ['seller_stock', 'estoques'],
      ['tax_info', 'impostos'],
      ['pre_order', 'crossdocking'],
    ] as const) {
      for (const contexto of [RASCUNHO, ANUNCIO]) {
        expect(superficieDoCampoShopee(linha(campo), contexto), campo).toEqual({
          tipo: 'produto',
          campo: alvo,
        });
      }
    }
    // DC §2.9: the size chart and the variations are the PRODUTO's — the same
    // surface under a published listing as under a draft (never Seller Centre).
    for (const contexto of [RASCUNHO, ANUNCIO]) {
      expect(superficieDoCampoShopee(linha('size_chart_info'), contexto)).toEqual({
        tipo: 'medidas',
      });
      for (const campo of [
        'standardise_tier_variation',
        'standardise_tier_variation[0].variation_option_list',
        'tier_variation',
        'model_list',
        'model',
        'grupoDeVariacoesUid',
      ]) {
        expect(superficieDoCampoShopee(linha(campo), contexto), campo).toEqual({
          tipo: 'variacoes',
        });
      }
    }
  });

  it('the ROOT is cut at the first `[` or `.` and matched EXACTLY — never a prefix', () => {
    expect(superficieDoCampoShopee(linha('item_name.0'), RASCUNHO)).toMatchObject({
      campo: 'item_name',
    });
    expect(superficieDoCampoShopee(linha('attribute_list[COLOR]'), ANUNCIO)).toEqual({
      tipo: 'seller-centre',
    });
    for (const campo of ['item_names', 'item_name_x', 'weights', 'image_list2']) {
      expect(superficieDoCampoShopee(linha(campo), RASCUNHO), campo).toBeNull();
    }
  });

  it('UNMAPPED ⇒ null (the sentence, no button): attributes on a draft before P13, the kit’s tier, the link keys, unknowns', () => {
    for (const campo of [
      'attribute_list',
      'attribute_list[COLOR]',
      // §H: the native kit's tier-name band (`opcoes-demais`) — no surface owns it.
      'tier_variation_list',
      'filhos.prod-2',
      'linkDocId',
      'recriar',
      'principal',
      'kitNativo',
      'ehKitVirtual',
      'paiId',
      'item_id',
      'shop',
      'constructor',
      '',
      null,
    ]) {
      expect(
        superficieDoCampoShopee(linha(campo, 'opcoes-demais'), RASCUNHO),
        String(campo),
      ).toBeNull();
    }
  });

  it('the button of each surface', () => {
    expect(
      rotuloDaSuperficieShopee({ tipo: 'rascunho', campo: 'item_name', aviso: null }, null),
    ).toBe(`Corrigir no rascunho: ${ROTULO_CAMPO_RASCUNHO_SHOPEE.item_name}`);
    expect(
      rotuloDaSuperficieShopee({ tipo: 'produto', campo: 'pesoBrutoKg' }, 'Dimensões e peso'),
    ).toBe('Abrir no produto: Dimensões e peso');
    expect(rotuloDaSuperficieShopee({ tipo: 'produto', campo: 'sku' }, null)).toBe(
      'Abrir no produto',
    );
    expect(rotuloDaSuperficieShopee({ tipo: 'variacoes' }, null)).toBe('Abrir Variações');
    expect(rotuloDaSuperficieShopee({ tipo: 'medidas' }, null)).toBe('Abrir a tabela de medidas');
    expect(rotuloDaSuperficieShopee({ tipo: 'seller-centre' }, null)).toBe(
      'Corrigir no Seller Centre',
    );
  });
});

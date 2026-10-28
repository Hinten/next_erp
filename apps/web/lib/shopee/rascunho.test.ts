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
  type EdicaoRascunhoShopee,
  type EntradaDoBlocoRascunhoShopee,
} from './rascunho';
import { DETALHES_ERRO_SHOPEE_VAZIOS, type DetalhesErroShopee } from './wire';

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

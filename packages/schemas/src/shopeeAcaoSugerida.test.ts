import { describe, expect, it } from 'vitest';

import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  acaoSugeridaPublicacaoShopeeSchema,
  tipoAcaoSugeridaPublicacaoShopeeSchema,
  type AcaoSugeridaPublicacaoShopee,
  type TipoAcaoSugeridaPublicacaoShopee,
} from './shopeeAcaoSugerida';

// Fixture ids only: link docs `link-1`/`link-2`, item 1000001.

/** One VALID `acao` per `tipo` — the record makes a missing member a compile error. */
const VALIDA_POR_TIPO: Record<TipoAcaoSugeridaPublicacaoShopee, AcaoSugeridaPublicacaoShopee> = {
  recriar: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar, linkDocId: 'link-1' },
  republicar: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar, linkDocId: 'link-1' },
  'sem-opcoes-de-kit': { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit },
  'informar-principal': { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal },
  importar: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar, itemIds: [1000001] },
  'escolher-vinculo': {
    tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.escolherVinculo,
    linkDocIds: ['link-1', 'link-2'],
  },
};

describe('the vocabulary — ONE list, three spellings that must agree (L10)', () => {
  it('⭐ the named constant holds EXACTLY the enum’s members, in order', () => {
    expect(Object.values(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE)).toEqual(
      tipoAcaoSugeridaPublicacaoShopeeSchema.options,
    );
  });

  it.each(tipoAcaoSugeridaPublicacaoShopeeSchema.options)(
    '⭐ `%s` parses through the union, unchanged',
    (tipo) => {
      const acao = VALIDA_POR_TIPO[tipo];
      expect(acaoSugeridaPublicacaoShopeeSchema.parse(acao)).toEqual(acao);
    },
  );

  it('a `tipo` outside the vocabulary is refused — the per-row fallback lives in the READER', () => {
    expect(acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo: 'novo-tipo' }).success).toBe(false);
  });
});

describe('each member’s payload is checked, not just its tag', () => {
  it('⭐ `importar` with NO item id is refused — an import of nothing is not a next step', () => {
    expect(
      acaoSugeridaPublicacaoShopeeSchema.safeParse({
        tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
        itemIds: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a quoted number', '1000001'],
  ])('NEAR-MISS: an `importar` item id that is %s is refused', (_n, itemId) => {
    expect(
      acaoSugeridaPublicacaoShopeeSchema.safeParse({
        tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
        itemIds: [itemId],
      }).success,
    ).toBe(false);
  });

  it('⭐ `escolher-vinculo` needs TWO links — one is not a choice; two is', () => {
    const tipo = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.escolherVinculo;
    expect(
      acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo, linkDocIds: ['link-1'] }).success,
    ).toBe(false);
    expect(
      acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo, linkDocIds: ['link-1', 'link-2'] })
        .success,
    ).toBe(true);
  });

  it('`recriar` names its link — absent, `null` and empty are all refused', () => {
    const tipo = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar;
    expect(acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo }).success).toBe(false);
    expect(acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo, linkDocId: null }).success).toBe(
      false,
    );
    expect(acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo, linkDocId: '' }).success).toBe(
      false,
    );
  });

  it('NEAR-MISS: `republicar` takes `null` (no link named) — but never an absent key or ""', () => {
    const tipo = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar;
    expect(acaoSugeridaPublicacaoShopeeSchema.parse({ tipo, linkDocId: null })).toEqual({
      tipo,
      linkDocId: null,
    });
    expect(acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo }).success).toBe(false);
    expect(acaoSugeridaPublicacaoShopeeSchema.safeParse({ tipo, linkDocId: '' }).success).toBe(
      false,
    );
  });
});

describe('AGUARDAR_KIT_INCERTO_SHOPEE_MS', () => {
  it('is four whole minutes — the number both apps/shopee sentences interpolate', () => {
    expect(AGUARDAR_KIT_INCERTO_SHOPEE_MS).toBe(4 * 60_000);
    expect(Number.isInteger(AGUARDAR_KIT_INCERTO_SHOPEE_MS / 60_000)).toBe(true);
  });
});

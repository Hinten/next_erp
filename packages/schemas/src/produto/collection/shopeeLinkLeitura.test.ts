import { describe, expect, it } from 'vitest';

import {
  ESTADO_ANUNCIO_SHOPEE,
  produtoShopeeLinkSchema,
  type ProdutoShopeeLink,
} from './shopeeLink';
import {
  anuncioShopeeVivo,
  ehRascunhoShopee,
  mecanismosDaRecusaAnterior,
  pularPorRecusaAnterior,
  recusaEstoqueDoAnuncioShopeeLegivel,
  recusaEstoqueDoModeloShopeeLegivel,
  recusaPrecoDoAnuncioShopeeLegivel,
  recusaPrecoDoModeloShopeeLegivel,
  recusaShopeeLegivel,
  type LeituraRecusaEstoqueShopee,
} from './shopeeLinkLeitura';

/* ---------------------------------- fixtures ------------------------------ */

const AGORA = 1_757_000_000_000;
const ITEM_ID = 2500139861;

/* -------------------------------------------------------------------------- */
/*            (1) recusaShopeeLegivel — the ONE comparison (register 177)      */
/* -------------------------------------------------------------------------- */

describe('recusaShopeeLegivel — a comparação única', () => {
  it('⚠️ PAR (L1): um EMPATE mostra a recusa — `>=`, nunca `>`', () => {
    expect(recusaShopeeLegivel(AGORA, [AGORA])).toBe(true);
    expect(recusaShopeeLegivel(AGORA, [AGORA, AGORA])).toBe(true);
  });

  it('⚠️ NEAR-MISS: um sucesso UM milissegundo mais novo esconde a recusa', () => {
    expect(recusaShopeeLegivel(AGORA, [AGORA + 1])).toBe(false);
    expect(recusaShopeeLegivel(AGORA + 1, [AGORA])).toBe(true);
  });

  it('basta UM sucesso mais novo para esconder — todos têm de ser mais velhos ou iguais', () => {
    expect(recusaShopeeLegivel(AGORA, [AGORA - 5, AGORA + 5])).toBe(false);
    expect(recusaShopeeLegivel(AGORA, [AGORA + 5, AGORA - 5])).toBe(false);
    expect(recusaShopeeLegivel(AGORA, [AGORA - 5, AGORA - 1])).toBe(true);
  });

  it('(L3) um sucesso que não é número não é mais novo que nada: null, ausente, string', () => {
    expect(recusaShopeeLegivel(AGORA, [null])).toBe(true);
    expect(recusaShopeeLegivel(AGORA, [undefined])).toBe(true);
    expect(recusaShopeeLegivel(AGORA, [])).toBe(true);
    // A legacy STRING stamp later than the refusal still hides nothing — nothing
    // is coerced.
    expect(recusaShopeeLegivel(AGORA, [String(AGORA + 1_000)])).toBe(true);
  });

  it('⚠️ (L3) uma recusa que não é um número FINITO não é recusa nenhuma', () => {
    expect(recusaShopeeLegivel(null, [])).toBe(false);
    expect(recusaShopeeLegivel(undefined, [null])).toBe(false);
    // NEAR-MISS of the `?? 0` mutant: a null refusal against a null success.
    expect(recusaShopeeLegivel(null, [null])).toBe(false);
    // NEAR-MISS of the `typeof` mutant: a numeric STRING compares >= in JS.
    expect(recusaShopeeLegivel(String(AGORA), [AGORA - 1])).toBe(false);
    expect(recusaShopeeLegivel(Number.NaN, [])).toBe(false);
    expect(recusaShopeeLegivel(Number.POSITIVE_INFINITY, [AGORA])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (2) the four readers, by stamp                     */
/* -------------------------------------------------------------------------- */

describe('recusaPrecoDoAnuncioShopeeLegivel — o item, contra o seu precoEnviadoEm', () => {
  it('um empate mostra; um envio limpo mais novo esconde; sem envio limpo, mostra', () => {
    expect(recusaPrecoDoAnuncioShopeeLegivel({ precoRecusaEm: AGORA, precoEnviadoEm: AGORA })).toBe(
      true,
    );
    expect(
      recusaPrecoDoAnuncioShopeeLegivel({ precoRecusaEm: AGORA, precoEnviadoEm: AGORA + 1 }),
    ).toBe(false);
    expect(recusaPrecoDoAnuncioShopeeLegivel({ precoRecusaEm: AGORA, precoEnviadoEm: null })).toBe(
      true,
    );
    expect(recusaPrecoDoAnuncioShopeeLegivel({ precoRecusaEm: null, precoEnviadoEm: null })).toBe(
      false,
    );
  });
});

describe('recusaPrecoDoModeloShopeeLegivel — o modelo, contra o SEU carimbo E o do item', () => {
  it('⚠️ (L2) mais nova que o próprio sucesso, mais VELHA que o envio limpo do item ⇒ escondida', () => {
    // The `preco-igual` case: the model was refused in a partial send, then read
    // equal (never re-stamped) while the item later synced cleanly.
    expect(
      recusaPrecoDoModeloShopeeLegivel(
        { precoRecusaEm: AGORA, precoEnviadoEm: AGORA - 10_000 },
        { precoEnviadoEm: AGORA + 1 },
      ),
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS (L2): mais nova que os DOIS carimbos ⇒ visível; empate com o item ⇒ visível', () => {
    expect(
      recusaPrecoDoModeloShopeeLegivel(
        { precoRecusaEm: AGORA, precoEnviadoEm: AGORA - 10_000 },
        { precoEnviadoEm: AGORA - 1 },
      ),
    ).toBe(true);
    expect(
      recusaPrecoDoModeloShopeeLegivel(
        { precoRecusaEm: AGORA, precoEnviadoEm: null },
        { precoEnviadoEm: AGORA },
      ),
    ).toBe(true);
  });

  it('o próprio sucesso do modelo continua escondendo, com o item sem envio limpo', () => {
    expect(
      recusaPrecoDoModeloShopeeLegivel(
        { precoRecusaEm: AGORA, precoEnviadoEm: AGORA + 1 },
        { precoEnviadoEm: null },
      ),
    ).toBe(false);
    expect(recusaPrecoDoModeloShopeeLegivel({ precoRecusaEm: AGORA }, {})).toBe(true);
  });
});

describe('recusaEstoqueDoAnuncioShopeeLegivel — o item, contra o seu estoqueEnviadoEm', () => {
  it('a mesma regra do preço: empate mostra, envio limpo mais novo esconde', () => {
    expect(
      recusaEstoqueDoAnuncioShopeeLegivel({ estoqueRecusaEm: AGORA, estoqueEnviadoEm: AGORA }),
    ).toBe(true);
    expect(
      recusaEstoqueDoAnuncioShopeeLegivel({ estoqueRecusaEm: AGORA, estoqueEnviadoEm: AGORA + 1 }),
    ).toBe(false);
    expect(recusaEstoqueDoAnuncioShopeeLegivel({ estoqueRecusaEm: AGORA })).toBe(true);
    expect(recusaEstoqueDoAnuncioShopeeLegivel({ estoqueEnviadoEm: AGORA })).toBe(false);
  });
});

describe('recusaEstoqueDoModeloShopeeLegivel — o modelo, contra o carimbo do PAI', () => {
  it('⚠️ (L4) o envio limpo do PAI mais novo esconde a recusa do modelo', () => {
    expect(
      recusaEstoqueDoModeloShopeeLegivel(
        { estoqueRecusaEm: AGORA },
        { estoqueEnviadoEm: AGORA + 1 },
      ),
    ).toBe(false);
    expect(
      recusaEstoqueDoModeloShopeeLegivel({ estoqueRecusaEm: AGORA }, { estoqueEnviadoEm: AGORA }),
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS (L4): um carimbo no PRÓPRIO modelo não esconde nada — só o do pai conta', () => {
    // A `variashopee` has no stock success stamp; a stray field there (a
    // hand-built or legacy row) must not be read as one.
    const modeloComCarimboProprio = { estoqueRecusaEm: AGORA, estoqueEnviadoEm: AGORA + 60_000 };
    expect(
      recusaEstoqueDoModeloShopeeLegivel(modeloComCarimboProprio, { estoqueEnviadoEm: AGORA - 1 }),
    ).toBe(true);
    expect(recusaEstoqueDoModeloShopeeLegivel(modeloComCarimboProprio, {})).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) pularPorRecusaAnterior — MOVED with the function (L5); the gate's own  */
/*      rung-4 verdicts stay in `apps/shopee/.../podeEnviarEstoque.test.ts`    */
/* -------------------------------------------------------------------------- */

function link(parcial: LeituraRecusaEstoqueShopee = {}): LeituraRecusaEstoqueShopee {
  return { item_id: ITEM_ID, ...parcial };
}

describe('pularPorRecusaAnterior — o mecanismo de ESTADO', () => {
  it('⚠️ PAR: as DUAS metades batendo ⇒ pula', () => {
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          item_status: 'NORMAL',
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
          estoqueRecusaItemStatus: 'NORMAL',
        }),
        AGORA,
      ),
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: só UMA das metades batendo ⇒ não pula — qualquer metade que se mexa LEVANTA', () => {
    const base = {
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
    };
    expect(
      pularPorRecusaAnterior(
        link({ ...base, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, item_status: 'UNLIST' }),
        AGORA,
      ),
    ).toBe(false);
    expect(
      pularPorRecusaAnterior(
        link({ ...base, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado, item_status: 'NORMAL' }),
        AGORA,
      ),
    ).toBe(false);
  });

  it('sem estoqueRecusaEm não há mecanismo de estado — nem com o fingerprint inteiro batendo', () => {
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          item_status: 'NORMAL',
          estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
          estoqueRecusaItemStatus: 'NORMAL',
        }),
        AGORA,
      ),
    ).toBe(false);
  });

  it('⚠️ PAR (L5): um campo AUSENTE e um carimbo null são o MESMO estado ⇒ pula', () => {
    // One RECORDED half is non-null on purpose: the fold makes ABSENCE comparable
    // (this pair); the "at least one recorded reading" clause stops it comparing
    // TWO absences (the near-miss below). Neither implies the other.
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          // `item_status` deliberately never written.
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
          estoqueRecusaItemStatus: null,
        }),
        AGORA,
      ),
    ).toBe(true);
    // ...and the mirror image: a written null against an absent stamp.
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          item_status: null,
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
        }),
        AGORA,
      ),
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS (L5): as DUAS metades GRAVADAS nulas NÃO armam nada', () => {
    expect(
      pularPorRecusaAnterior(
        link({
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: null,
          estoqueRecusaItemStatus: null,
        }),
        AGORA,
      ),
    ).toBe(false);
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          item_status: null,
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: null,
          estoqueRecusaItemStatus: null,
        }),
        AGORA,
      ),
    ).toBe(false);
    // ...and the stamp with both halves ABSENT is the same case (the fold).
    expect(
      pularPorRecusaAnterior(link({ estadoAnuncio: null, estoqueRecusaEm: AGORA - 1_000 }), AGORA),
    ).toBe(false);
  });

  it("⚠️ NEAR-MISS (L5): null ≠ '' e null ≠ 'null' — nada é aparado nem coagido", () => {
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          item_status: '',
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
          estoqueRecusaItemStatus: null,
        }),
        AGORA,
      ),
    ).toBe(false);
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: 'null',
          item_status: 'NORMAL',
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaEstado: null,
          estoqueRecusaItemStatus: 'NORMAL',
        }),
        AGORA,
      ),
    ).toBe(false);
  });
});

describe('pularPorRecusaAnterior — o mecanismo de TEMPO', () => {
  it('⚠️ PAR (L5): estoqueRecusaAte no futuro pula; o INSTANTE EXATO já libera (< estrito)', () => {
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: AGORA + 1 }), AGORA)).toBe(true);
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: AGORA }), AGORA)).toBe(false);
  });

  it('⚠️ NEAR-MISS: uma espera VENCIDA (um milissegundo atrás) não pula', () => {
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: AGORA - 1 }), AGORA)).toBe(false);
  });

  it('o mecanismo de TEMPO pula sozinho — sem nenhum fingerprint gravado', () => {
    expect(
      pularPorRecusaAnterior(
        link({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
          item_status: 'NORMAL',
          estoqueRecusaAte: AGORA + 60_000,
        }),
        AGORA,
      ),
    ).toBe(true);
  });

  it('um estoqueRecusaAte NaN ou texto não pula — a comparação já responde false', () => {
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: Number.NaN }), AGORA)).toBe(false);
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: 'amanhã' }), AGORA)).toBe(false);
  });

  it('um documento ilegível não LANÇA', () => {
    const lixo: LeituraRecusaEstoqueShopee[] = [
      {},
      { estoqueRecusaEm: 'ontem', estoqueRecusaEstado: [] },
      { estoqueRecusaAte: {} },
      { item_status: 7, estoqueRecusaItemStatus: 7, estoqueRecusaEm: AGORA - 1 },
    ];
    for (const doc of lixo) {
      expect(() => pularPorRecusaAnterior(doc, AGORA)).not.toThrow();
    }
  });
});

describe('mecanismosDaRecusaAnterior — QUAL metade está armada (a aba diz por quê)', () => {
  const lendo = { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, item_status: 'NORMAL' } as const;
  const impressao = {
    estoqueRecusaEm: AGORA - 1_000,
    estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
    estoqueRecusaItemStatus: 'NORMAL',
  } as const;

  it('separa as duas metades: só TEMPO, só ESTADO, as duas, nenhuma', () => {
    expect(
      mecanismosDaRecusaAnterior(link({ ...lendo, estoqueRecusaAte: AGORA + 60_000 }), AGORA),
    ).toStrictEqual({ tempo: true, estado: false });
    expect(mecanismosDaRecusaAnterior(link({ ...lendo, ...impressao }), AGORA)).toStrictEqual({
      tempo: false,
      estado: true,
    });
    expect(
      mecanismosDaRecusaAnterior(
        link({ ...lendo, ...impressao, estoqueRecusaAte: AGORA + 60_000 }),
        AGORA,
      ),
    ).toStrictEqual({ tempo: true, estado: true });
    // NEAR-MISS: o prazo no INSTANTE exato já não arma (< estrito), e a leitura movida
    // desarma o ESTADO.
    expect(
      mecanismosDaRecusaAnterior(
        link({
          ...impressao,
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
          item_status: 'UNLIST',
          estoqueRecusaAte: AGORA,
        }),
        AGORA,
      ),
    ).toStrictEqual({ tempo: false, estado: false });
  });

  it('pularPorRecusaAnterior é exatamente tempo || estado', () => {
    for (const extra of [
      {},
      { estoqueRecusaAte: AGORA + 1 },
      impressao,
      { ...impressao, estoqueRecusaAte: AGORA + 1 },
      { ...impressao, estoqueRecusaAte: AGORA - 1 },
    ]) {
      const l = link({ ...lendo, ...extra });
      const { tempo, estado } = mecanismosDaRecusaAnterior(l, AGORA);
      expect(pularPorRecusaAnterior(l, AGORA)).toBe(tempo || estado);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*         (4) anuncioShopeeVivo — MOVED with the function (L13 twin)          */
/* -------------------------------------------------------------------------- */

describe('anuncioShopeeVivo', () => {
  it('estadoAnuncio null ou ausente é VIVO; removido não é (NEAR-MISS)', () => {
    expect(anuncioShopeeVivo({ item_id: ITEM_ID })).toBe(true);
    expect(anuncioShopeeVivo({ item_id: ITEM_ID, estadoAnuncio: null })).toBe(true);
    expect(
      anuncioShopeeVivo({ item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    ).toBe(false);
  });

  it('um link sem item_id publicável não é vivo — incluindo um id STRING', () => {
    expect(anuncioShopeeVivo({ item_id: null })).toBe(false);
    expect(anuncioShopeeVivo({ item_id: 0 })).toBe(false);
    expect(anuncioShopeeVivo({ item_id: String(ITEM_ID) })).toBe(false);
    expect(anuncioShopeeVivo(null)).toBe(false);
  });

  it('⚠️ a regra é `isFinite`, não `isSafeInteger` — uma "arrumação" muda quem é vivo', () => {
    // Pinned so the move stays VERBATIM: a finite id above the safe-integer
    // range reads alive here, while the kit predicates (`isSafeInteger`) would
    // refuse it.
    expect(anuncioShopeeVivo({ item_id: Number.MAX_SAFE_INTEGER + 2 })).toBe(true);
    expect(anuncioShopeeVivo({ item_id: 1.5 })).toBe(true);
    expect(anuncioShopeeVivo({ item_id: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*               (5) ehRascunhoShopee — the draft (#1911, D3)                  */
/* -------------------------------------------------------------------------- */

describe('ehRascunhoShopee — o rascunho nunca é um anúncio', () => {
  it('PAR: `item_id: null` e `item_id` AUSENTE (uma projeção que omite a chave) são rascunho', () => {
    expect(ehRascunhoShopee({ item_id: null })).toBe(true);
    expect(ehRascunhoShopee({})).toBe(true);
    expect(ehRascunhoShopee({ item_id: undefined })).toBe(true);
  });

  it('PAR: qualquer estadoAnuncio — um anúncio nunca criado não tem estado que a Shopee tenha dado', () => {
    for (const estado of [...Object.values(ESTADO_ANUNCIO_SHOPEE), null, undefined]) {
      const link: Record<string, unknown> = { item_id: null, estadoAnuncio: estado };
      expect(ehRascunhoShopee(link), String(estado)).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: um item_id PRESENTE mas inutilizável é um link CORROMPIDO, não um rascunho', () => {
    // The "widen to no usable item_id" mutant reads every one of these as a
    // draft — and a draft is publishable, so a corrupt link would become an
    // `add_item` target.
    for (const itemId of [0, -1, Number.NaN, '', '123', String(ITEM_ID), false]) {
      expect(ehRascunhoShopee({ item_id: itemId }), String(itemId)).toBe(false);
    }
  });

  it('⚠️ NEAR-MISS: um item_id positivo é um ANÚNCIO, mesmo `removido` (rascunho ≠ "não vivo")', () => {
    // `removido` kills the "widen to NOT vivo" mutant: a removed listing is
    // not vivo, and it is still not a draft.
    const removido: Record<string, unknown> = {
      item_id: ITEM_ID,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    };
    expect(anuncioShopeeVivo(removido)).toBe(false);
    expect(ehRascunhoShopee(removido)).toBe(false);
    expect(ehRascunhoShopee({ item_id: ITEM_ID })).toBe(false);
    expect(ehRascunhoShopee({ item_id: ITEM_ID, kitNativo: true })).toBe(false);
    expect(ehRascunhoShopee({ item_id: 1.5 })).toBe(false);
  });

  it('`kitNativo: true` sem item_id é resíduo de kit nativo (a classe X), nunca rascunho', () => {
    expect(ehRascunhoShopee({ item_id: null, kitNativo: true })).toBe(false);
    expect(ehRascunhoShopee({ kitNativo: true })).toBe(false);
  });

  it("⚠️ NEAR-MISS: só `true` exclui — `false`, `null`, ausente ou um `'true'` solto deixam o rascunho rascunho", () => {
    expect(ehRascunhoShopee({ item_id: null, kitNativo: false })).toBe(true);
    expect(ehRascunhoShopee({ item_id: null, kitNativo: null })).toBe(true);
    expect(ehRascunhoShopee({ item_id: null, kitNativo: undefined })).toBe(true);
    expect(ehRascunhoShopee({ item_id: null, kitNativo: 'true' })).toBe(true);
    expect(ehRascunhoShopee({ item_id: null, kitNativo: 1 })).toBe(true);
  });

  it('`null` (nenhum documento) não é rascunho', () => {
    expect(ehRascunhoShopee(null)).toBe(false);
  });

  it('um link PARSEADO sem item_id (o default do schema é `null`) é rascunho; com item_id, não', () => {
    // Also a COMPILE-time pin: the parsed `ProdutoShopeeLink` is accepted as-is.
    const rascunho: ProdutoShopeeLink = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_name: 'Camiseta Básica Azul',
    });
    expect(rascunho.item_id).toBeNull();
    expect(ehRascunhoShopee(rascunho)).toBe(true);

    const publicado: ProdutoShopeeLink = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_name: 'Camiseta Básica Azul',
      item_id: ITEM_ID,
    });
    expect(ehRascunhoShopee(publicado)).toBe(false);
  });
});

describe('ehRascunhoShopee × anuncioShopeeVivo — classes DISJUNTAS sobre uma tabela', () => {
  // One table, both predicates: `vivo` and `rascunho` must never both hold,
  // and the corrupt rows must be NEITHER (the recorded residual — they are not
  // silently promoted into either class).
  const TABELA: readonly {
    readonly caso: string;
    readonly link: Record<string, unknown> | null;
    readonly classe: 'vivo' | 'rascunho' | 'nenhum';
  }[] = [
    { caso: 'publicado', link: { item_id: ITEM_ID }, classe: 'vivo' },
    {
      caso: 'publicado, estado nunca dobrado',
      link: { item_id: ITEM_ID, estadoAnuncio: null },
      classe: 'vivo',
    },
    {
      caso: 'publicado, pausado',
      link: { item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado },
      classe: 'vivo',
    },
    { caso: 'kit nativo publicado', link: { item_id: ITEM_ID, kitNativo: true }, classe: 'vivo' },
    { caso: 'id fracionário (isFinite)', link: { item_id: 1.5 }, classe: 'vivo' },
    {
      caso: 'publicado, removido',
      link: { item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido },
      classe: 'nenhum',
    },
    { caso: 'rascunho', link: { item_id: null }, classe: 'rascunho' },
    { caso: 'rascunho, chave ausente', link: {}, classe: 'rascunho' },
    {
      caso: 'rascunho, estado removido',
      link: { item_id: null, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido },
      classe: 'rascunho',
    },
    {
      caso: 'rascunho, kitNativo false',
      link: { item_id: null, kitNativo: false },
      classe: 'rascunho',
    },
    { caso: 'resíduo de kit nativo', link: { item_id: null, kitNativo: true }, classe: 'nenhum' },
    { caso: 'item_id 0', link: { item_id: 0 }, classe: 'nenhum' },
    { caso: 'item_id negativo', link: { item_id: -1 }, classe: 'nenhum' },
    { caso: 'item_id NaN', link: { item_id: Number.NaN }, classe: 'nenhum' },
    { caso: 'item_id string', link: { item_id: String(ITEM_ID) }, classe: 'nenhum' },
    { caso: 'item_id string vazia', link: { item_id: '' }, classe: 'nenhum' },
    { caso: 'sem documento', link: null, classe: 'nenhum' },
  ];

  it.each(TABELA)('$caso ⇒ $classe', ({ link, classe }) => {
    const vivo = anuncioShopeeVivo(link);
    const rascunho = ehRascunhoShopee(link);
    expect(vivo && rascunho).toBe(false);
    expect({ vivo, rascunho }).toEqual({
      vivo: classe === 'vivo',
      rascunho: classe === 'rascunho',
    });
  });

  it('a tabela cobre as três classes (não é vacuamente disjunta)', () => {
    expect(new Set(TABELA.map((l) => l.classe))).toEqual(new Set(['vivo', 'rascunho', 'nenhum']));
  });
});

import { describe, expect, it } from 'vitest';

import {
  ESTADO_ANUNCIO_SHOPEE,
  produtoShopeeLinkSchema,
  type ProdutoShopeeLink,
} from './shopeeLink';
import {
  anuncioShopeeVivo,
  contaDoLinkShopee,
  ehRascunhoShopee,
  lerLogisticaArmazenadaShopee,
  logisticaGravadaPeloErpShopee,
  mecanismosDaRecusaAnterior,
  pularPorRecusaAnterior,
  recusaEstoqueDoAnuncioShopeeLegivel,
  recusaEstoqueDoModeloShopeeLegivel,
  recusaPrecoDoAnuncioShopeeLegivel,
  recusaPrecoDoModeloShopeeLegivel,
  recusaShopeeLegivel,
  type EntradaLogisticaArmazenadaShopee,
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
/*     (4b) contaDoLinkShopee — MOVED from the app's anchor binding            */
/* -------------------------------------------------------------------------- */

describe('contaDoLinkShopee — o leitor da conta da âncora (contaProdutoShopeeOuterRef, e só ele)', () => {
  it.each([
    ['a forma canônica', 'documents/integracao/C1'],
    ['a forma nua', 'integracao/C1'],
    ['uma barra inicial', '/documents/integracao/C1'],
  ])('PAR: %s lê a MESMA conta, C1', (_caso, ref) => {
    expect(contaDoLinkShopee({ contaProdutoShopeeOuterRef: ref, item_id: ITEM_ID })).toBe('C1');
  });

  it('⚠️ QUASE-PAR: o ref de outra conta lê ESSA conta — nunca C1, e sem dobrar caixa', () => {
    expect(
      contaDoLinkShopee({
        contaProdutoShopeeOuterRef: 'documents/integracao/C2',
        item_id: ITEM_ID,
      }),
    ).toBe('C2');
    expect(
      contaDoLinkShopee({
        contaProdutoShopeeOuterRef: 'documents/integracao/c1',
        item_id: ITEM_ID,
      }),
    ).toBe('c1');
  });

  it.each([
    ['o ref de OUTRA coleção', 'documents/produtos/C1'],
    ['um id nu (não é ref)', 'C1'],
    ['a coleção sozinha', 'integracao'],
    ['uma string vazia', ''],
    ['null', null],
    ['um número', 42],
    // A reader that stringified before it parsed would read this as C1: `String([ref])` is the ref.
    ['o ref DENTRO de um array', ['documents/integracao/C1']],
  ])('⚠️ QUASE-PAR: %s lê null — nunca C1', (_caso, ref) => {
    expect(contaDoLinkShopee({ contaProdutoShopeeOuterRef: ref, item_id: ITEM_ID })).toBeNull();
  });

  it.each([['contaOuterRef'], ['contaLojaIntegrada'], ['contaAmazonOuterRef']])(
    '⛔ QUASE-PAR: um doc carregando SÓ %s (o campo de conta de outro canal) lê null',
    (campo) => {
      // The copy-paste trap: one identifier apart, it compiles, and the trigger goes silent.
      expect(
        contaDoLinkShopee({ [campo]: 'documents/integracao/C1', item_id: ITEM_ID }),
      ).toBeNull();
      // ÂNCORA: the same body under the right field does read C1.
      expect(
        contaDoLinkShopee({
          contaProdutoShopeeOuterRef: 'documents/integracao/C1',
          item_id: ITEM_ID,
        }),
      ).toBe('C1');
    },
  );

  it('lê a conta seja qual for a vitalidade do link — vitalidade é do anuncioShopeeVivo', () => {
    expect(
      contaDoLinkShopee({
        contaProdutoShopeeOuterRef: 'documents/integracao/C1',
        item_id: null,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      }),
    ).toBe('C1');
  });

  it('⛔ um documento cru nunca a faz LANÇAR', () => {
    for (const bruto of [
      {},
      { contaProdutoShopeeOuterRef: undefined },
      { contaProdutoShopeeOuterRef: { caminho: 'integracao/C1' } },
      { contaProdutoShopeeOuterRef: 'documents/integracao/C1', item_id: 'nao-e-numero' },
    ]) {
      expect(() => contaDoLinkShopee(bruto)).not.toThrow();
    }
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

/* -------------------------------------------------------------------------- */
/*     (6) logisticaGravadaPeloErpShopee — the provenance stamp (#2015, D1)    */
/* -------------------------------------------------------------------------- */

describe('logisticaGravadaPeloErpShopee — só o carimbo decide (#2015, D1)', () => {
  const CARIMBO = 1_730_000_000_000;
  /** A legacy list, exactly the shape a migrated row carries — no stamp. */
  const LISTA_LEGADA = [{ logistic_id: 90001, enabled: true, is_free: true }];
  const ULTIMA = { em: CARIMBO, etapa: 'updateItem', itemId: ITEM_ID };

  it('PAR: um carimbo inteiro em ms é confiável — `0` inclusive (o sinal é PRESENÇA, não relógio)', () => {
    expect(logisticaGravadaPeloErpShopee({ logisticaGravadaEm: CARIMBO })).toBe(true);
    expect(logisticaGravadaPeloErpShopee({ logisticaGravadaEm: 0 })).toBe(true);
    expect(logisticaGravadaPeloErpShopee({ logisticaGravadaEm: Number.MAX_SAFE_INTEGER })).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: chave AUSENTE (toda linha migrada) e `null` NÃO são confiáveis', () => {
    // `null` kills the "`'logisticaGravadaEm' in link`" mutant: the key is
    // PRESENT and still vouches for nothing.
    expect(logisticaGravadaPeloErpShopee({})).toBe(false);
    expect(logisticaGravadaPeloErpShopee({ logisticaGravadaEm: undefined })).toBe(false);
    expect(logisticaGravadaPeloErpShopee({ logisticaGravadaEm: null })).toBe(false);
  });

  it('⛔ NEAR-MISS: texto numérico, fração, negativo, NaN, ±Infinity, inteiro inseguro, booleano e objeto NÃO são carimbo', () => {
    // The string kills the "`v != null`" mutant; `1.5` the "`Number.isFinite`"
    // one; `-1` the dropped `>= 0`.
    for (const ruim of [
      String(CARIMBO),
      '0',
      1.5,
      CARIMBO + 0.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      true,
      { em: CARIMBO },
      [CARIMBO],
    ]) {
      expect(logisticaGravadaPeloErpShopee({ logisticaGravadaEm: ruim }), String(ruim)).toBe(false);
    }
  });

  it('`null` (nenhum documento) não é confiável', () => {
    expect(logisticaGravadaPeloErpShopee(null)).toBe(false);
  });

  it('⚠️ NEAR-MISS (D1): `ultimaPublicacao` PRESENTE sem carimbo NÃO é confiável — PAR: o mesmo link carimbado é', () => {
    // Kills the "also accept `ultimaPublicacao`" mutant: write-back #1 stamps
    // `ultimaPublicacao` unconditionally while the list is conditional, so it
    // never proved who wrote the list.
    const semCarimbo: Record<string, unknown> = {
      item_id: ITEM_ID,
      logistic_info: LISTA_LEGADA,
      ultimaPublicacao: ULTIMA,
    };
    expect(logisticaGravadaPeloErpShopee(semCarimbo)).toBe(false);
    expect(logisticaGravadaPeloErpShopee({ ...semCarimbo, logisticaGravadaEm: null })).toBe(false);
    expect(logisticaGravadaPeloErpShopee({ ...semCarimbo, logisticaGravadaEm: CARIMBO })).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: a forma ADOTADA pelo ENSURE (item_id gravado, lista legada, sem carimbo) NÃO é confiável — PAR: carimbada é', () => {
    // ENSURE's adoption writes `item_id` and keeps the legacy draft's list, and
    // the run then resumes as an UPDATE. Kills every "keyed on item_id /
    // !ehRascunho / anuncioShopeeVivo" mutant: this row is a vivo listing.
    const adotado: Record<string, unknown> = {
      item_id: ITEM_ID,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'NORMAL',
      logistic_info: LISTA_LEGADA,
      publicacaoEmCurso: null,
      criacaoIncertaDesde: null,
    };
    expect(anuncioShopeeVivo(adotado)).toBe(true);
    expect(ehRascunhoShopee(adotado)).toBe(false);
    expect(logisticaGravadaPeloErpShopee(adotado)).toBe(false);
    expect(logisticaGravadaPeloErpShopee({ ...adotado, logisticaGravadaEm: CARIMBO })).toBe(true);
  });

  it('PAR: um RASCUNHO carimbado é confiável; o mesmo rascunho sem carimbo não — o rascunho não decide', () => {
    // Kills the "`!ehRascunhoShopee(link) && …`" mutant from the other side.
    const rascunho: Record<string, unknown> = { item_id: null, logistic_info: LISTA_LEGADA };
    expect(ehRascunhoShopee(rascunho)).toBe(true);
    expect(logisticaGravadaPeloErpShopee(rascunho)).toBe(false);
    expect(logisticaGravadaPeloErpShopee({ ...rascunho, logisticaGravadaEm: CARIMBO })).toBe(true);
  });

  it('nem `estadoAnuncio` nem a própria lista decidem: `removido`, lista vazia ou `null` seguem o carimbo', () => {
    for (const extra of [
      { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido },
      { logistic_info: [] },
      { logistic_info: null },
      { kitNativo: true },
    ]) {
      const link: Record<string, unknown> = { item_id: ITEM_ID, ...extra };
      expect(logisticaGravadaPeloErpShopee(link), JSON.stringify(extra)).toBe(false);
      expect(
        logisticaGravadaPeloErpShopee({ ...link, logisticaGravadaEm: CARIMBO }),
        JSON.stringify(extra),
      ).toBe(true);
    }
  });

  it('um link PARSEADO: sem a chave fica distrusted, com o carimbo fica trusted (pin de COMPILAÇÃO também)', () => {
    // The parsed `ProdutoShopeeLink` is accepted as-is (compile pin), and the
    // server-stamped `.optional()` leaves the key ABSENT on a link that never
    // carried it — the migrated corpus.
    const migrado: ProdutoShopeeLink = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_name: 'Camiseta Básica Azul',
      item_id: ITEM_ID,
      logistic_info: LISTA_LEGADA,
    });
    expect(migrado).not.toHaveProperty('logisticaGravadaEm');
    expect(logisticaGravadaPeloErpShopee(migrado)).toBe(false);

    const carimbado: ProdutoShopeeLink = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_name: 'Camiseta Básica Azul',
      item_id: ITEM_ID,
      logistic_info: LISTA_LEGADA,
      logisticaGravadaEm: CARIMBO,
    });
    expect(logisticaGravadaPeloErpShopee(carimbado)).toBe(true);
  });

  it('pin de COMPILAÇÃO: um objeto TIPADO sem a chave (uma projeção) não compila — só o documento cru ou parseado', () => {
    // The parameter is a weak type, so TypeScript refuses an object type that
    // shares none of its keys: a caller that hands over a projection built
    // without the stamp (instead of the raw link) fails `tsc`, not a test.
    const projecao = { item_id: ITEM_ID, logistic_info: LISTA_LEGADA };
    // @ts-expect-error — a typed projection with no `logisticaGravadaEm` key.
    expect(logisticaGravadaPeloErpShopee(projecao)).toBe(false);
    const cru: Record<string, unknown> = projecao;
    expect(logisticaGravadaPeloErpShopee(cru)).toBe(false);
  });

  it('a tabela cruza as QUATRO combinações carimbo × rascunho — o predicado é ortogonal a item_id', () => {
    // One table, anti-vacuity: every (stamped, draft) pair occurs, and the
    // answer follows the stamp column alone.
    const TABELA: readonly {
      readonly link: Record<string, unknown>;
      readonly carimbado: boolean;
      readonly rascunho: boolean;
    }[] = [
      { link: { item_id: null }, carimbado: false, rascunho: true },
      { link: { item_id: null, logisticaGravadaEm: CARIMBO }, carimbado: true, rascunho: true },
      { link: { item_id: ITEM_ID }, carimbado: false, rascunho: false },
      { link: { item_id: ITEM_ID, logisticaGravadaEm: CARIMBO }, carimbado: true, rascunho: false },
    ];
    const pares = new Set<string>();
    for (const { link, carimbado, rascunho } of TABELA) {
      expect(ehRascunhoShopee(link)).toBe(rascunho);
      expect(logisticaGravadaPeloErpShopee(link)).toBe(carimbado);
      pares.add(`${String(carimbado)}|${String(rascunho)}`);
    }
    expect(pares.size).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/*   (7) lerLogisticaArmazenadaShopee — the stored list reader (#1911 P15)     */
/*       MOVED from `apps/shopee/.../logisticaPublicacao.ts`; the publisher's  */
/*       own pins of it stay there (P24–P29)                                   */
/* -------------------------------------------------------------------------- */

describe('lerLogisticaArmazenadaShopee — o leitor ÚNICO da lista armazenada (#1911 P15, #1369)', () => {
  /** Two channel ids of the plan's synthetic range — never a real shop's. */
  const A = 90003;
  const B = 90005;
  /** Marks a row whose key is ABSENT from the stored entry — not a stored `undefined`. */
  const AUSENTE = Symbol('ausente');
  const ler = lerLogisticaArmazenadaShopee;

  /** A stored entry: `base` with `chave` set to `valor`, or WITHOUT the key for {@link AUSENTE}. */
  function comCampo(
    chave: string,
    valor: unknown,
    base: Record<string, unknown> = { logistic_id: A },
  ): Record<string, unknown> {
    if (valor === AUSENTE)
      return Object.fromEntries(Object.entries(base).filter(([k]) => k !== chave));
    return { ...base, [chave]: valor };
  }

  /** Channel A's reading with every optional field empty, overridden by `sobre`. */
  function lida(
    sobre: Partial<EntradaLogisticaArmazenadaShopee> = {},
  ): EntradaLogisticaArmazenadaShopee {
    return { logisticId: A, ligado: true, isFree: null, sizeId: null, shippingFee: null, ...sobre };
  }

  it("não é uma lista ⇒ null (null, undefined, {}, 'x', 7); [] ⇒ []", () => {
    // The array-like object is the near-miss for an `Object.values` reader.
    for (const bruto of [null, undefined, {}, 'x', 7, { 0: { logistic_id: A } }]) {
      expect(ler(bruto), String(JSON.stringify(bruto))).toBeNull();
    }
    expect(ler([])).toEqual([]);
  });

  it("⚠️ PAR: logistic_id 90003, '90003' e '090003' são a MESMA entrada (o zero à esquerda é a regra do main, declarada)", () => {
    // Kills the "numbers only" mutant: a digits-only STRING id is a real id.
    for (const id of [A, String(A), `0${String(A)}`]) {
      expect(ler([{ logistic_id: id, enabled: true }]), String(id)).toEqual([lida()]);
    }
  });

  it.each<[string, unknown]>([
    ["''", ''],
    ["' 90003'", ' 90003'],
    ["'90003 '", '90003 '],
    ["'90003.0'", '90003.0'],
    ["'+90003'", '+90003'],
    ["'1e5'", '1e5'],
    ['0', 0],
    ["'0'", '0'],
    ['-1', -1],
    ['1.5', 1.5],
    ['Number.MAX_SAFE_INTEGER + 2', Number.MAX_SAFE_INTEGER + 2],
    ["'9007199254740993' (dígitos, inseguro)", '9007199254740993'],
    ['true', true],
    ['null', null],
    ['ausente', AUSENTE],
  ])('⛔ QUASE: logistic_id %s não é legível ⇒ a entrada SAI', (_, valor) => {
    // The readable neighbour is the anti-vacuity control: a reader answering
    // `[]` for everything would pass the drop alone.
    const vizinha = { logistic_id: B, enabled: true };
    expect(ler([comCampo('logistic_id', valor, { enabled: true }), vizinha])).toEqual([
      lida({ logisticId: B }),
    ]);
  });

  it("⛔ QUASE: uma entrada que não é objeto (null, 7, 'x', []) sai, e a vizinha legível fica", () => {
    // A bare id (number or digits) is not an entry either — only an OBJECT's
    // `logistic_id` is read.
    expect(ler([null, 7, 'x', [], A, String(A), [A], { logistic_id: A }])).toEqual([lida()]);
  });

  it.each<[string, unknown]>([
    ['true', true],
    ['null', null],
    ['ausente', AUSENTE],
    ["'false'", 'false'],
    ['0', 0],
  ])('ligado: SÓ o booleano false desliga ⟷ QUASE: enabled %s fica LIGADO', (_, valor) => {
    expect(ler([comCampo('enabled', false)])).toEqual([lida({ ligado: false })]);
    expect(ler([comCampo('enabled', valor)])).toEqual([lida({ ligado: true })]);
  });

  it.each<[string, unknown]>([
    ["'true'", 'true'],
    ['1', 1],
    ['null', null],
    ['ausente', AUSENTE],
  ])('isFree: true e false ficam ⟷ QUASE: is_free %s ⇒ null', (_, valor) => {
    expect(ler([comCampo('is_free', true)])).toEqual([lida({ isFree: true })]);
    expect(ler([comCampo('is_free', false)])).toEqual([lida({ isFree: false })]);
    expect(ler([comCampo('is_free', valor)])).toEqual([lida({ isFree: null })]);
  });

  it.each<[string, unknown]>([
    ['0', 0],
    ["'0'", '0'],
    ["''", ''],
    ["'12.5'", '12.5'],
    ['12.5', 12.5],
    ["' 12 '", ' 12 '],
  ])("sizeId: 7 e '7' ⇒ 7 ⟷ QUASE: size_id %s ⇒ null (C32)", (_, valor) => {
    expect(ler([comCampo('size_id', 7)])).toEqual([lida({ sizeId: 7 })]);
    expect(ler([comCampo('size_id', '7')])).toEqual([lida({ sizeId: 7 })]);
    expect(ler([comCampo('size_id', valor)])).toEqual([lida({ sizeId: null })]);
  });

  it.each<[string, unknown]>([
    ["'12,90'", '12,90'],
    ["''", ''],
    ["'grátis'", 'grátis'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ["'-5'", '-5'],
  ])("shippingFee: 12.9 e '12.90' ⇒ 12.9 ⟷ QUASE: shipping_fee %s ⇒ null", (_, valor) => {
    expect(ler([comCampo('shipping_fee', 12.9)])).toEqual([lida({ shippingFee: 12.9 })]);
    expect(ler([comCampo('shipping_fee', '12.90')])).toEqual([lida({ shippingFee: 12.9 })]);
    expect(ler([comCampo('shipping_fee', valor)])).toEqual([lida({ shippingFee: null })]);
  });

  it('RESÍDUO (o ramo numérico do main): os NÚMEROS 0 e -5 ficam como tarifa — declarado, não mudado', () => {
    // The STRING '-5' is refused above; the NUMBER is kept. The asymmetry is
    // main's, moved verbatim — a change here is a decision, not a move.
    expect(ler([comCampo('shipping_fee', 0)])).toEqual([lida({ shippingFee: 0 })]);
    expect(ler([comCampo('shipping_fee', -5)])).toEqual([lida({ shippingFee: -5 })]);
  });

  it('⛔ QUASE: estimated_shipping_fee NUNCA é a tarifa (shippingFee null) ⟷ PAR: shipping_fee 7.18 é', () => {
    // Kills the `shipping_fee ?? estimated_shipping_fee` mutant from both sides.
    expect(ler([{ logistic_id: A, estimated_shipping_fee: 7.18 }])).toEqual([lida()]);
    expect(ler([{ logistic_id: A, estimated_shipping_fee: '7.18' }])).toEqual([lida()]);
    expect(ler([{ logistic_id: A, shipping_fee: 7.18 }])).toEqual([lida({ shippingFee: 7.18 })]);
    expect(ler([{ logistic_id: A, shipping_fee: 7.18, estimated_shipping_fee: 99 }])).toEqual([
      lida({ shippingFee: 7.18 }),
    ]);
  });

  it('uma entrada no formato do retorno do BR sai com EXATAMENTE as cinco chaves — logistic_name, include_pickup e estimated_shipping_fee nunca passam', () => {
    // The read-back shape (`get_item_base_info.logistic_info[]`), synthetic
    // values. Kills the "spread the raw entry" mutant.
    const retorno = {
      logistic_id: A,
      logistic_name: 'Entrega Padrão',
      enabled: true,
      is_free: false,
      estimated_shipping_fee: 12.9,
      include_pickup: false,
    };
    const [entrada, ...resto] = ler([retorno]) ?? [];
    expect(resto).toEqual([]);
    expect(Object.keys(entrada ?? {}).sort()).toEqual([
      'isFree',
      'ligado',
      'logisticId',
      'shippingFee',
      'sizeId',
    ]);
    expect(entrada).toEqual(lida({ isFree: false }));
  });

  it('a ordem GUARDADA e as duplicatas ficam — o leitor nunca deduplica', () => {
    // B (90005) is stored BEFORE A (90003), so a sorting reader fails too.
    expect(
      ler([{ logistic_id: B, size_id: '' }, { logistic_id: B, size_id: '7' }, { logistic_id: A }]),
    ).toEqual([lida({ logisticId: B }), lida({ logisticId: B, sizeId: 7 }), lida()]);
  });
});

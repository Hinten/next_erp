import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  toOuterRef,
  varianteFakePath,
  type EstadoAnuncioShopee,
} from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import { publicarShopee } from '../anuncios/publicarShopee';
import { idDoVinculoDeKit } from '../kits/idsKit';
import type { KitDeps } from '../kits/resultadoKit';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';
import {
  podeEnviarEstoqueShopee,
  pularPorRecusaAnterior,
  type LinkParaEstoque,
  type VereditoEnvioEstoque,
} from './podeEnviarEstoque';

/* ---------------------------------- fixtures ------------------------------ */

const AGORA = 1_757_000_000_000;
const ITEM_ID = 2500139861;

/** A link that SENDS: published, live, no kit flag, no refusal on record. */
function link(parcial: LinkParaEstoque = {}): LinkParaEstoque {
  return { item_id: ITEM_ID, ...parcial };
}

/**
 * The produto side. Typed through a variable rather than an inline literal so a
 * test can hand over fields the parameter type does not name — `ehKit` above
 * all, which is the whole point of the legacy-catalogue case below.
 */
function produto(campos: Record<string, unknown> = {}): { ehKitVirtual?: unknown } {
  return campos;
}

function veredito(
  parcial: LinkParaEstoque,
  opcoes: { nowMs?: number; ignorarRecusa?: boolean } = {},
  produtoDoLink: Record<string, unknown> = {},
): VereditoEnvioEstoque {
  return podeEnviarEstoqueShopee(link(parcial), produto(produtoDoLink), {
    nowMs: opcoes.nowMs ?? AGORA,
    ...(opcoes.ignorarRecusa === undefined ? {} : { ignorarRecusa: opcoes.ignorarRecusa }),
  });
}

/* -------------------------------------------------------------------------- */
/*                    (1) the estado table — the whole fold                    */
/* -------------------------------------------------------------------------- */

interface LinhaDeEstado {
  readonly rotulo: string;
  readonly estado: EstadoAnuncioShopee | null | undefined;
  readonly esperado: VereditoEnvioEstoque;
}

const TABELA_ESTADO: readonly LinhaDeEstado[] = [
  { rotulo: '1 — ativo', estado: ESTADO_ANUNCIO_SHOPEE.ativo, esperado: { enviar: true } },
  {
    rotulo: '2 — pausado (UNLIST) ENVIA — um número velho na re-listagem vende a mais',
    estado: ESTADO_ANUNCIO_SHOPEE.pausado,
    esperado: { enviar: true },
  },
  {
    rotulo: '3 — agendado ENVIA — o anúncio sobe carregando a quantidade que tiver',
    estado: ESTADO_ANUNCIO_SHOPEE.agendado,
    esperado: { enviar: true },
  },
  {
    rotulo: '4 — desconhecido ENVIA — um desconhecido foldado é uma LEITURA, não um estado',
    estado: ESTADO_ANUNCIO_SHOPEE.desconhecido,
    esperado: { enviar: true },
  },
  {
    rotulo: '5 — null ENVIA — nunca foldado, todo link importado no passo 9 é um',
    estado: null,
    esperado: { enviar: true },
  },
  {
    rotulo: '6 — ausente ENVIA — a mesma coisa que null',
    estado: undefined,
    esperado: { enviar: true },
  },
  {
    rotulo: '7 — removido RECUSA',
    estado: ESTADO_ANUNCIO_SHOPEE.removido,
    esperado: { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido },
  },
  {
    rotulo: '8 — banido RECUSA',
    estado: ESTADO_ANUNCIO_SHOPEE.banido,
    esperado: { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioBanido },
  },
  {
    rotulo: '9 — em_revisao RECUSA',
    estado: ESTADO_ANUNCIO_SHOPEE.emRevisao,
    esperado: { enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioEmRevisao },
  },
];

describe('podeEnviarEstoqueShopee — o estadoAnuncio', () => {
  it.each(TABELA_ESTADO)('a tabela inteira: $rotulo', ({ estado, esperado }) => {
    const alvo: LinkParaEstoque = estado === undefined ? {} : { estadoAnuncio: estado };
    expect(veredito(alvo)).toEqual(esperado);
  });

  it('⚠️ PAR: pausado e agendado ENVIAM os dois — duas leituras de UNLIST que têm de concordar', () => {
    const pausado = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const agendado = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.agendado });
    expect(pausado).toEqual({ enviar: true });
    expect(agendado).toEqual(pausado);
  });

  it('⚠️ NEAR-MISS: em_revisao e pausado respondem o OPOSTO — só um dos dois é uma pendência', () => {
    const pausado = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const emRevisao = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.emRevisao });
    expect(pausado).toEqual({ enviar: true });
    expect(emRevisao).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioEmRevisao,
    });
  });

  it('⚠️ PAR: null e desconhecido ENVIAM os dois — "nunca foldado" e "não reconhecido" colapsam', () => {
    const nulo = veredito({ estadoAnuncio: null });
    const desconhecido = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.desconhecido });
    expect(nulo).toEqual({ enviar: true });
    expect(desconhecido).toEqual(nulo);
  });

  it('⚠️ NEAR-MISS: removido e desconhecido são ambos "sem leitura viva" — só um recusa', () => {
    const removido = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    const desconhecido = veredito({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.desconhecido });
    expect(removido).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido,
    });
    expect(desconhecido).toEqual({ enviar: true });
  });

  it('um estado que a Shopee inventar amanhã ENVIA — nunca um apagão de catálogo', () => {
    for (const bruto of ['', 'NORMAL', 'unlisted', 'REMOVIDO', 'pending']) {
      expect(veredito({ estadoAnuncio: bruto })).toEqual({ enviar: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         (2) rung 1 — o item_id                              */
/* -------------------------------------------------------------------------- */

describe('podeEnviarEstoqueShopee — o item_id', () => {
  it('⚠️ PAR: item_id 0 e item_id null respondem os dois sem-item-id', () => {
    const zero = veredito({ item_id: 0 });
    const nulo = veredito({ item_id: null });
    expect(zero).toEqual({ enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId });
    expect(nulo).toEqual(zero);
    // ...e o campo AUSENTE é a mesma coisa.
    expect(podeEnviarEstoqueShopee({}, produto(), { nowMs: AGORA })).toEqual(zero);
    expect(veredito({ item_id: -1 })).toEqual(zero);
  });

  it("⚠️ NEAR-MISS: um item_id STRING '2500139861' também é sem-item-id — a direção do falso negativo", () => {
    // The field is a typed `z.number().int()` and nothing in this repo writes it
    // as a string; a corpus row that did takes the false-negative direction, and
    // that is RECORDED rather than guessed around.
    expect(veredito({ item_id: String(ITEM_ID) })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId,
    });
    // ...while the NUMBER sends.
    expect(veredito({ item_id: ITEM_ID })).toEqual({ enviar: true });
  });

  it('um item_id não finito é sem-item-id', () => {
    expect(veredito({ item_id: Number.NaN })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId,
    });
    expect(veredito({ item_id: Number.POSITIVE_INFINITY })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                       (3) rung 3 — o kit, e o apagão                        */
/* -------------------------------------------------------------------------- */

describe('podeEnviarEstoqueShopee — o kit', () => {
  it('kitNativo true ⇒ kit-derivado', () => {
    expect(veredito({ kitNativo: true })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
    });
  });

  it('⚠️ O APAGÃO DO CATÁLOGO LEGADO: um produto ehKit com kitNativo false ENVIA', () => {
    // The ERP holds THOUSANDS of `ehKit` produtos that are ordinary Shopee
    // listings. Reading the produto's own flag here would be a total, silent
    // stock outage for every one of them.
    expect(veredito({ kitNativo: false }, {}, { ehKit: true })).toEqual({ enviar: true });
    expect(veredito({ kitNativo: null }, {}, { ehKit: true })).toEqual({ enviar: true });
    expect(veredito({}, {}, { ehKit: true })).toEqual({ enviar: true });
  });

  it('⚠️ PAR: false, null e ausente ENVIAM os três — só true recusa', () => {
    const falso = veredito({ kitNativo: false });
    const nulo = veredito({ kitNativo: null });
    const ausente = veredito({});
    expect(falso).toEqual({ enviar: true });
    expect(nulo).toEqual(falso);
    expect(ausente).toEqual(falso);
  });

  it('⚠️ NEAR-MISS: um kitNativo "true" (string) ou 1 NÃO recusa — a comparação é === true', () => {
    expect(veredito({ kitNativo: 'true' })).toEqual({ enviar: true });
    expect(veredito({ kitNativo: 1 })).toEqual({ enviar: true });
  });

  it('com link resolvido, SÓ kitNativo decide — ehKitVirtual no produto não é fallback', () => {
    // The publish-side predicate falls back to `ehKitVirtual` on a CREATE, where
    // there is no link to read. Here a link always exists, so a fallback would
    // re-open the same outage through a second door.
    expect(veredito({ kitNativo: false }, {}, { ehKitVirtual: true })).toEqual({ enviar: true });
    expect(veredito({ kitNativo: null }, {}, { ehKitVirtual: true })).toEqual({ enviar: true });
    expect(veredito({}, {}, { ehKitVirtual: true, ehKit: true })).toEqual({ enviar: true });
  });
});

/* -------------------------------------------------------------------------- */
/*               (4) rung 4 — o conjunto de pulo (o fingerprint)               */
/* -------------------------------------------------------------------------- */

describe('pularPorRecusaAnterior — o mecanismo de ESTADO', () => {
  it('⚠️ PAR: as DUAS metades batendo ⇒ recusa-anterior', () => {
    const alvo = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'NORMAL',
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
    };
    expect(pularPorRecusaAnterior(link(alvo), AGORA)).toBe(true);
    expect(veredito(alvo)).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.recusaAnterior,
    });
  });

  it('⚠️ NEAR-MISS: só o estadoAnuncio batendo ⇒ ENVIA — qualquer metade que se mexa LEVANTA o pulo', () => {
    const alvo = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'UNLIST',
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
    };
    expect(pularPorRecusaAnterior(link(alvo), AGORA)).toBe(false);
    expect(veredito(alvo)).toEqual({ enviar: true });
  });

  it('⚠️ NEAR-MISS: só o item_status batendo ⇒ ENVIA — a outra metade do mesmo &&', () => {
    const alvo = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      item_status: 'NORMAL',
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
    };
    expect(pularPorRecusaAnterior(link(alvo), AGORA)).toBe(false);
    expect(veredito(alvo)).toEqual({ enviar: true });
  });

  it('sem estoqueRecusaEm não há mecanismo de estado — nem com o fingerprint inteiro batendo', () => {
    const alvo = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'NORMAL',
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
    };
    expect(pularPorRecusaAnterior(link(alvo), AGORA)).toBe(false);
    expect(veredito(alvo)).toEqual({ enviar: true });
  });

  it('⚠️ PAR: um campo AUSENTE e um carimbo null são o MESMO estado ⇒ pula', () => {
    // A `.nullable().default(null)` column before its first write looks exactly
    // like an absent key. Both sides are normalised, so the two agree.
    //
    // ⚠️ Uma das metades GRAVADAS é não-nula de propósito. São DUAS regras
    // diferentes e nenhuma implica a outra: o fold é o que torna a AUSÊNCIA
    // comparável (este par), e a cláusula da "pelo menos uma leitura gravada"
    // é o que impede o fold de comparar DUAS ausências (o near-miss abaixo).
    const alvo = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      // `item_status` é deliberadamente não escrito.
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: null,
    };
    expect(pularPorRecusaAnterior(link(alvo), AGORA)).toBe(true);
    expect(veredito(alvo)).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.recusaAnterior,
    });
    // ...and the mirror image: a written null against an absent stamp.
    const espelho = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: null,
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      // `estoqueRecusaItemStatus` ausente — a outra ponta do mesmo fold.
    };
    expect(pularPorRecusaAnterior(link(espelho), AGORA)).toBe(true);
  });

  it('⚠️ NEAR-MISS (este teste foi INVERTIDO): as DUAS metades GRAVADAS nulas NÃO pulam', () => {
    // ⚠️ INVERTIDO por decisão do dono (L2-1, 2026-09-22). Antes este caso
    // vinha junto do par acima e afirmava `true`. Ele afirmava um DEFEITO: um
    // carimbo sem nenhuma leitura gravada — o que `registrarEnvioParcial`
    // escreve, e o que uma recusa terminal num link sem leituras escreve —
    // encontrava `null === null` nas duas metades e travava `recusa-anterior`
    // PARA SEMPRE, porque nenhuma das metades tem para onde se mexer.
    // O mecanismo de ESTADO só arma quando ao menos UMA leitura foi gravada.
    const semLeituraNenhuma = {
      // `estadoAnuncio` e `item_status` nunca foram escritos no vínculo.
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: null,
      estoqueRecusaItemStatus: null,
    };
    expect(pularPorRecusaAnterior(link(semLeituraNenhuma), AGORA)).toBe(false);
    expect(veredito(semLeituraNenhuma)).toEqual({ enviar: true });

    // ...e a mesma impressão vazia contra um vínculo que JÁ LÊ ('ativo', null)
    // também envia: quem não gravou leitura nenhuma não tem o que comparar.
    const lendoAtivo = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: null,
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: null,
      estoqueRecusaItemStatus: null,
    };
    expect(pularPorRecusaAnterior(link(lendoAtivo), AGORA)).toBe(false);
    expect(veredito(lendoAtivo)).toEqual({ enviar: true });

    // ...e o carimbo com as duas metades AUSENTES é o mesmo caso (o fold).
    expect(
      pularPorRecusaAnterior(link({ estadoAnuncio: null, estoqueRecusaEm: AGORA - 1_000 }), AGORA),
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: null e a string vazia NÃO são o mesmo estado ⇒ ENVIA', () => {
    // Nothing is trimmed, lower-cased or coerced: two RECORDED READINGS are
    // compared for identity, never for likeness.
    // ⚠️ `estoqueRecusaEstado` é não-nulo e BATE, de modo que a decisão fica
    // inteiramente na outra metade — `'' !== null`. Com as duas metades
    // gravadas nulas o veredito seria `false` pela cláusula da leitura
    // gravada, e esta linha não provaria nada sobre o fold.
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
    // ...and neither is the STRING 'null'.
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
  it('⚠️ PAR: estoqueRecusaAte no futuro pula; o INSTANTE EXATO já libera (< estrito)', () => {
    const futuro = link({ estoqueRecusaAte: AGORA + 1 });
    const exato = link({ estoqueRecusaAte: AGORA });
    expect(pularPorRecusaAnterior(futuro, AGORA)).toBe(true);
    expect(pularPorRecusaAnterior(exato, AGORA)).toBe(false);
    expect(veredito({ estoqueRecusaAte: AGORA + 1 })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.recusaAnterior,
    });
    expect(veredito({ estoqueRecusaAte: AGORA })).toEqual({ enviar: true });
  });

  it('⚠️ NEAR-MISS: uma espera VENCIDA (um milissegundo atrás) envia', () => {
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: AGORA - 1 }), AGORA)).toBe(false);
    expect(veredito({ estoqueRecusaAte: AGORA - 1 })).toEqual({ enviar: true });
  });

  it('o mecanismo de TEMPO pula sozinho — sem nenhum fingerprint gravado', () => {
    // A promotion ending moves no `item_status`, so this mechanism has to work
    // with the state half completely empty or it would latch for ever.
    const alvo = link({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'NORMAL',
      estoqueRecusaAte: AGORA + 60_000,
    });
    expect(pularPorRecusaAnterior(alvo, AGORA)).toBe(true);
  });

  it('um estoqueRecusaAte NaN não pula — a comparação já responde false', () => {
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: Number.NaN }), AGORA)).toBe(false);
    expect(pularPorRecusaAnterior(link({ estoqueRecusaAte: 'amanhã' }), AGORA)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (5) a ORDEM das travas, e o único bypass                  */
/* -------------------------------------------------------------------------- */

describe('podeEnviarEstoqueShopee — a ordem e o bypass', () => {
  it('ignorarRecusa true dispensa o conjunto de pulo — as duas metades e o tempo', () => {
    const porEstado = {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'NORMAL',
      estoqueRecusaEm: AGORA - 1_000,
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
    };
    expect(veredito(porEstado)).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.recusaAnterior,
    });
    expect(veredito(porEstado, { ignorarRecusa: true })).toEqual({ enviar: true });
    expect(veredito({ estoqueRecusaAte: AGORA + 60_000 }, { ignorarRecusa: true })).toEqual({
      enviar: true,
    });
  });

  it('⚠️ ...e dispensa SÓ essa trava: um anúncio removido continua recusando', () => {
    expect(
      veredito(
        { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido, estoqueRecusaAte: AGORA + 60_000 },
        { ignorarRecusa: true },
      ),
    ).toEqual({ enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido });
    expect(veredito({ item_id: null }, { ignorarRecusa: true })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId,
    });
    expect(veredito({ kitNativo: true }, { ignorarRecusa: true })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
    });
  });

  it('⚠️ A ORDEM: um removido com pulo vivo responde anuncio-removido, nunca recusa-anterior', () => {
    // The operator must read the TERMINAL cause, not the latch sitting on it.
    expect(
      veredito({
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
        estoqueRecusaAte: AGORA + 60_000,
        estoqueRecusaEm: AGORA - 1_000,
        estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.removido,
        estoqueRecusaItemStatus: 'SELLER_DELETE',
        item_status: 'SELLER_DELETE',
      }),
    ).toEqual({ enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido });
  });

  it('a ORDEM, continuação: sem item_id vem antes de tudo; o kit vem antes do pulo', () => {
    expect(
      veredito({
        item_id: 0,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.banido,
        kitNativo: true,
        estoqueRecusaAte: AGORA + 60_000,
      }),
    ).toEqual({ enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semItemId });
    expect(veredito({ kitNativo: true, estoqueRecusaAte: AGORA + 60_000 })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
    });
  });

  it('omitir ignorarRecusa é exatamente o mesmo que passá-lo false', () => {
    const alvo = { estoqueRecusaAte: AGORA + 60_000 };
    expect(veredito(alvo)).toEqual(veredito(alvo, { ignorarRecusa: false }));
  });
});

/* -------------------------------------------------------------------------- */
/*                 (6) total e não-lançante sobre um doc cru                   */
/* -------------------------------------------------------------------------- */

describe('podeEnviarEstoqueShopee — um documento ilegível', () => {
  it('um documento ilegível não LANÇA — ele responde um veredito', () => {
    const lixo: LinkParaEstoque[] = [
      {},
      { item_id: {} },
      { item_id: [ITEM_ID] },
      { item_id: ITEM_ID, estadoAnuncio: 42 },
      { item_id: ITEM_ID, estadoAnuncio: { removido: true } },
      { item_id: ITEM_ID, kitNativo: {} },
      { item_id: ITEM_ID, estoqueRecusaEm: 'ontem', estoqueRecusaEstado: [] },
      { item_id: ITEM_ID, estoqueRecusaAte: {} },
      { item_id: ITEM_ID, item_status: 7, estoqueRecusaItemStatus: 7, estoqueRecusaEm: AGORA - 1 },
    ];
    for (const doc of lixo) {
      expect(() => podeEnviarEstoqueShopee(doc, produto(), { nowMs: AGORA })).not.toThrow();
      const resposta = podeEnviarEstoqueShopee(doc, produto(), { nowMs: AGORA });
      expect(typeof resposta.enviar).toBe('boolean');
      expect(() => pularPorRecusaAnterior(doc, AGORA)).not.toThrow();
    }
  });

  it('um estadoAnuncio 42 ENVIA — nada nele é um dos três estados que recusam', () => {
    expect(veredito({ estadoAnuncio: 42 })).toEqual({ enviar: true });
  });
});

/* -------------------------------------------------------------------------- */
/*          (7) a proibição, em texto cru: a trava do kit lê o VÍNCULO         */
/* -------------------------------------------------------------------------- */

describe('a disciplina do módulo', () => {
  it('o módulo NUNCA lê a flag de kit do produto — só o vínculo', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./podeEnviarEstoque.ts', import.meta.url)),
      'utf8',
    );

    // ÂNCORA: the file really was read and really does hold the rung.
    expect(fonte).toContain('link.kitNativo === true');
    // ...and the docblock really does state the prohibition in words.
    expect(fonte).toContain('ehKit');

    // The banned ACCESS, verbatim — a raw-text grep, so not even a comment may
    // spell it as code.
    expect(fonte).not.toContain('produto.ehKit');

    // Stronger: outside the comments, `ehKit` appears NOWHERE on its own.
    // `ehKitVirtual` is a different word and survives the word boundary — it is
    // the parameter type, carried for symmetry and never consulted.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(codigo).toMatch(/ehKitVirtual/);
    expect(codigo).not.toMatch(/\behKit\b/);
  });
});

/* -------------------------------------------------------------------------- */
/*   (8) T5 — passo 19, PR 7: o vínculo que a ROTA grava ao criar um kit nativo  */
/* -------------------------------------------------------------------------- */

/*
 * RT3's PR 7 half (reconcile §2.5.3 "T5", §4.2): until PR 7 nothing reached the
 * kit create, and "no native Shopee kit exists in this catalogue" was TRUE. From
 * PR 7 on the publish ENTRY POINT (`publicarShopee` — the route's and the CLI's
 * one function) creates one, so the link IT writes must be the one rung 3
 * skips. Every document here is written by the REAL writers, through the REAL
 * dispatcher: no link is hand-built.
 */

type Json = Record<string, unknown>;

const T5_INTEGRACAO = 'int-1';
const T5_REF_CONTA = toOuterRef(integracaoCollection.docPath({}, T5_INTEGRACAO));
const T5_AGORA = 1_757_000_000_000;
const T5_KIT = 2500139870;
const T5_MODELOS_DO_KIT = [2000458820, 2000458823] as const;
const T5_COMP_A = 2500139871;
const T5_COMP_A_MODELO = 2000458821;
const T5_COMP_B = 2500139872;
const T5_COMP_B_OCULTO = 2000458829;
const T5_CATEGORIA = 107290;
const T5_K = 'kit-k';
const T5_GRUPO = 'grupo-cor';
const T5_VINCULO = idDoVinculoDeKit(T5_INTEGRACAO, T5_KIT);

/** Components A (a 2-tier listing; the ERP component is its child) and plain B (a família de um). */
function t5SemearComponentes(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Camiseta', sku: 'CAM', paiId: null });
  db.seed('produtos/comp-a/prodshopee/link-comp-a', {
    item_id: T5_COMP_A,
    contaProdutoShopeeOuterRef: T5_REF_CONTA,
    category_id: T5_CATEGORIA,
  });
  db.seed('produtos/comp-a-filho', { nome: 'Camiseta P', sku: 'CAM-P', paiId: 'comp-a' });
  db.seed('produtos/comp-a-filho/variashopee/var-comp-a', {
    model_id: T5_COMP_A_MODELO,
    contaVariacaoShopeeOuterRef: T5_REF_CONTA,
    produtoShopeeOuterRef: 'documents/produtos/comp-a/prodshopee/link-comp-a',
  });
  db.seed('produtos/comp-b', {
    nome: 'Boné',
    sku: 'BONE',
    paiId: null,
    filhoUnicoId: 'comp-b-membro',
  });
  db.seed('produtos/comp-b/prodshopee/link-comp-b', {
    item_id: T5_COMP_B,
    contaProdutoShopeeOuterRef: T5_REF_CONTA,
    category_id: T5_CATEGORIA,
  });
  db.seed('produtos/comp-b-membro', { nome: 'Boné', sku: 'BONE-UN', paiId: 'comp-b' });
}

/** K — «É kit» + «É kit virtual», NO listing yet: the dispatcher's `kit-criar` (rule 5). */
function t5SemearKit(db: FakeDb): void {
  db.seed(`produtos/${T5_K}`, {
    nome: 'Kit camiseta e boné',
    sku: 'KIT-1',
    paiId: null,
    ehKit: true,
    ehKitVirtual: true,
    pesoBrutoKg: 0.8,
    alturaCm: 10,
    larguraCm: 20,
    profundidadeCm: 30,
    precos: { 'tab-normal': { valor: 99.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
  });
  db.seed(`produtos/${T5_K}/extraData/singleton`, { descricao: 'Kit para presente.' });
  db.seed(`grupoDeVariacoes/${T5_GRUPO}`, {
    nome: 'Cor',
    ordem: 1,
    variacoes: [
      { id: 'var-azul', nome: 'Azul' },
      { id: 'var-verde', nome: 'Verde' },
    ],
  });
  const filho = (id: string, variante: string, ordem: number, componentesKit: Json): void => {
    db.seed(`produtos/${id}`, {
      nome: `Kit ${variante}`,
      sku: `KIT-1-${String(ordem)}`,
      paiId: T5_K,
      ordem,
      ehKit: true,
      grupoDeVariacoesUid: [T5_GRUPO],
      variacoesUid: [varianteFakePath(T5_GRUPO, variante)],
      componentesKit,
    });
  };
  filho('kit-k-azul', 'var-azul', 1, {
    'comp-a-filho': { quantidade: 1, limitarEstoque: true },
    'comp-b-membro': { quantidade: 1, limitarEstoque: true },
  });
  filho('kit-k-verde', 'var-verde', 2, { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } });
}

interface T5Loja {
  readonly client: ShopeeClient;
  readonly ops: string[];
  /** A crash right after the link write: the read-back's `get_kit_item_info` throws this. */
  falhaNaLeituraDoKit: Error | null;
}

/**
 * A shop that CREATES what `add_kit_item` is sent and serves it back the way
 * the SG probe measured (`tag.kit: true`, the plain component's HIDDEN model
 * id), plus the reads a create arm runs. Anything not arranged throws.
 */
function t5Loja(): T5Loja {
  const ops: string[] = [];
  const bases = new Map<number, Json>([
    [
      T5_COMP_A,
      { item_id: T5_COMP_A, item_status: 'NORMAL', has_model: true, tag: { kit: false } },
    ],
    [
      T5_COMP_B,
      { item_id: T5_COMP_B, item_status: 'NORMAL', has_model: false, tag: { kit: false } },
    ],
  ]);
  let kit: Json | null = null;
  let modelos: Json[] = [];
  const loja: T5Loja = { client: {} as ShopeeClient, ops, falhaNaLeituraDoKit: null };
  const conhecidas: Record<string, (p: never) => Promise<unknown>> = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      return Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          item_list: p.itemIds.flatMap((id) => {
            const b = bases.get(id);
            return b === undefined ? [] : [b];
          }),
        }),
      );
    },
    getItemList: () => {
      ops.push('get_item_list');
      const item = [...bases.values()].map((b) => ({
        item_id: b.item_id,
        item_status: b.item_status,
        tag: b.tag,
      }));
      return Promise.resolve(
        shopeeItemListPayloadSchema.parse({
          item,
          total_count: item.length,
          has_next_page: false,
          next_offset: null,
          next: '',
        }),
      );
    },
    getKitItemInfo: () => {
      ops.push('get_kit_item_info');
      if (loja.falhaNaLeituraDoKit !== null) return Promise.reject(loja.falhaNaLeituraDoKit);
      return Promise.resolve(
        shopeeKitItemInfoPayloadSchema.parse({
          product_info: kit === null ? null : { ...kit, model_list: modelos },
        }),
      );
    },
    getModelList: (p: { itemId: number }) => {
      ops.push('get_model_list');
      return Promise.resolve(
        shopeeModelListPayloadSchema.parse(
          p.itemId === T5_KIT && kit !== null
            ? {
                tier_variation: kit.tier_variation_list,
                model: modelos.map((m) => ({
                  model_id: m.model_id,
                  tier_index: m.tier_index,
                  model_status: 'MODEL_NORMAL',
                })),
              }
            : { model: [] },
        ),
      );
    },
    getKitItemLimit: () => {
      ops.push('get_kit_item_limit');
      return Promise.reject(
        shopeeErrorFromEnvelope(
          { error: 'error_not_found', message: null, request_id: null, warning: null },
          {
            path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
            httpStatus: 404,
            surface: SHOPEE_SURFACE.business,
          },
        ),
      );
    },
    getChannelList: () => {
      ops.push('get_channel_list');
      return Promise.resolve({
        logistics_channel_list: [
          shopeeLogisticsChannelSchema.parse({
            logistics_channel_id: 90_003,
            enabled: true,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
          }),
        ],
      });
    },
    addKitItem: (corpo: ShopeeAddKitItemRequest) => {
      ops.push('add_kit_item');
      const s = corpo.item_setting;
      modelos = s.model_list.map((m, i) => ({
        model_id: T5_MODELOS_DO_KIT[i] ?? T5_KIT + i,
        model_sku: m.model_sku ?? null,
        original_price: m.original_price,
        tier_index: [...m.tier_index],
        component_list: m.component_list.map((c) => ({
          component_item_id: c.component_item_id,
          component_model_id:
            c.component_model_id ?? (c.component_item_id === T5_COMP_B ? T5_COMP_B_OCULTO : null),
          quantity: c.quantity,
          main_component: c.main_component === true,
        })),
      }));
      const tiers = s.tier_variation_list.map((t) => ({
        name: t.name,
        option_list: t.option_list.map((o) => ({ option: o.option })),
      }));
      kit = {
        item_id: T5_KIT,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        category_id: T5_CATEGORIA,
        weight: String(s.weight),
        tier_variation_list: tiers,
      };
      bases.set(T5_KIT, {
        item_id: T5_KIT,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        has_model: true,
        tag: { kit: true },
        category_id: T5_CATEGORIA,
      });
      return Promise.resolve({
        request_id: 'req-1',
        error: '',
        message: '',
        warning: '',
        response: { item_id: T5_KIT },
      });
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        ops.push(`?${prop}`);
        throw new Error(`fixture: a loja não serve ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return Object.assign(loja, { client });
}

function t5Resolvedor(): ResolvedorDeImagensShopee {
  return {
    resolver: (fotos) =>
      Promise.resolve({
        imageIds: ['img-kit-1'],
        reutilizadas: 0,
        enviadas: 1,
        falhas: [],
        consideradas: fotos.length,
        descartadasPeloLimite: 0,
      }),
    resumo: () => ({
      consideradas: 1,
      reutilizadas: 0,
      enviadas: 1,
      falhas: 0,
      descartadasPeloLimite: 0,
    }),
  };
}

function t5Deps(db: FakeDb, loja: T5Loja): KitDeps {
  return {
    db: asDb(db),
    client: loja.client,
    partnerClient: () => {
      throw new Error('fixture: o partner client só é usado pelo resolvedor de imagens');
    },
    integracaoId: T5_INTEGRACAO,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    depositoOuterRef: 'documents/depositos/dep-1',
    operacaoOuterRef: null,
    nowMs: T5_AGORA,
    esperar: () => Promise.resolve(),
    taxonomia: {
      integracaoId: T5_INTEGRACAO,
      client: loja.client,
      variationsPath: SHOPEE_GET_VARIATIONS_PATH,
    },
    categorias: {
      carregar: () => {
        throw new Error('fixture: o kit não lê a árvore de categorias');
      },
    },
    resolvedorDeImagens: t5Resolvedor(),
    increment,
  };
}

/** The route's call, exactly: no `--link`, no kit option but the principal. */
function t5Publicar(db: FakeDb, loja: T5Loja) {
  return publicarShopee(t5Deps(db, loja), {
    produtoId: T5_K,
    linkDocId: null,
    categoryId: null,
    statusPedido: 'NORMAL',
    principal: 'comp-a-filho',
    recriar: false,
    converterEmKit: false,
  });
}

function t5Vinculo(db: FakeDb): LinkParaEstoque {
  const doc = db.store[`produtos/${T5_K}/prodshopee/${T5_VINCULO}`]?.data;
  expect(doc).toBeDefined();
  return doc as LinkParaEstoque;
}

describe('T5 (passo 19, PR 7) — o vínculo que a criação pela ROTA grava é PULADO pelo passo 12', () => {
  beforeEach(() => {
    limparTaxonomiaShopee();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    limparTaxonomiaShopee();
    vi.restoreAllMocks();
  });

  it('⚠️ PAR: o despachante escolhe `kit-criar`, o kit nasce, e o vínculo ESCRITO responde `kit-derivado` — o vínculo do componente, no MESMO banco, ENVIA', async () => {
    const db = new FakeDb();
    t5SemearComponentes(db);
    t5SemearKit(db);
    const loja = t5Loja();

    const res = await t5Publicar(db, loja);

    expect(res).toMatchObject({
      tipo: 'kit',
      resultado: { arma: 'kit-criar', desfecho: 'criado', itemId: T5_KIT, linkDocId: T5_VINCULO },
    });
    expect(loja.ops.filter((o) => o === 'add_kit_item')).toHaveLength(1);
    const vinculo = t5Vinculo(db);
    expect(vinculo).toMatchObject({ item_id: T5_KIT, kitNativo: true });
    // The produto K is ehKit + ehKitVirtual; the verdict comes from the LINK alone.
    const produtoK = db.store[`produtos/${T5_K}`]?.data ?? {};
    expect(podeEnviarEstoqueShopee(vinculo, produtoK, { nowMs: T5_AGORA })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
    });
    // ⛔ QUASE-PAR: the component's ORDINARY listing, in the same database, sends.
    const componente = db.store['produtos/comp-a/prodshopee/link-comp-a']?.data ?? {};
    expect(podeEnviarEstoqueShopee(componente, {}, { nowMs: T5_AGORA })).toEqual({ enviar: true });
  });

  it('⚠️ uma QUEDA logo depois da escrita do vínculo (a releitura nunca terminou) já deixa o literal `kitNativo: true` — o passo 12 pula mesmo assim (R-1)', async () => {
    const db = new FakeDb();
    t5SemearComponentes(db);
    t5SemearKit(db);
    const loja = t5Loja();
    // `get_kit_item_info` runs only in the read-back, AFTER `add_kit_item` and
    // the link write: a non-Shopee throw there is the crash.
    const queda = new TypeError('fixture: o processo caiu na releitura do kit');
    loja.falhaNaLeituraDoKit = queda;

    await expect(t5Publicar(db, loja)).rejects.toBe(queda);

    expect(loja.ops.filter((o) => o === 'add_kit_item')).toHaveLength(1);
    const vinculo = t5Vinculo(db);
    // The literal the link write stamps — no read-back ever ran.
    expect(vinculo.kitNativo).toBe(true);
    expect(vinculo.item_status ?? null).toBeNull();
    expect(podeEnviarEstoqueShopee(vinculo, {}, { nowMs: T5_AGORA })).toEqual({
      enviar: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
    });
  });
});

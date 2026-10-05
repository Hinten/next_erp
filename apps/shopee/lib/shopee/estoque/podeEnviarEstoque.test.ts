import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ESTADO_ANUNCIO_SHOPEE, type EstadoAnuncioShopee } from '@delfrance/schemas';

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

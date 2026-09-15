/**
 * The pure state model of the stuck-reservation sweep (step 8, #1516).
 *
 * Two things this file does on purpose, because reading the module cannot show
 * either of them:
 *
 *  - the status table is driven off `SHOPEE_ORDER_STATUS` itself, so a Shopee
 *    token that gains a rung in step 5's ladder without gaining an arm here
 *    fails HERE rather than in a weekly tick nobody watches;
 *  - the two dangerous claims in the module's docblock — "a re-drive on an
 *    unknown token RELEASES the reservation" and "`manter` answers at the FIRST
 *    clause" — are EXECUTED against the real `estadoShopeeAplicavel`, never
 *    asserted in prose. A claim about state that is only read is refuted by
 *    default.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { ESTADOS_PEDIDO_RESERVA, ESTADO_PEDIDO } from '@delfrance/schemas';

import { SHOPEE_ERRO_ORDER_NOT_FOUND } from './importarPedido';
import { makePedidoIdShopee } from './orderIds';
import {
  ALVO_ESTADO_SHOPEE,
  MOTIVO_ESTADO_SHOPEE,
  SHOPEE_ORDER_STATUS,
  estadoShopeeAplicavel,
  type AlvoEstadoShopee,
} from './orderStatusMaps';
import {
  CODIGOS_PEDIDO_INEXISTENTE,
  DIA_US,
  VEREDITOS_QUE_AVISAM,
  VEREDITOS_RESERVA_TRAVADA,
  VEREDITO_RESERVA_TRAVADA,
  classificarReservaTravada,
  idadeEmDias,
  integracaoIdDoPedidoShopee,
  provaDeIdentidadeShopee,
  type LeituraReservaTravada,
  type VereditoReservaTravada,
} from './reservaTravadaMapping';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
/** The SG sandbox order — the one the committed `__wire__` bodies carry. */
const ORDER_SN = '260910KJBHUJDM';
const OUTER_REF = `documents/integracao/${CONTA}`;

/** A `pay_time` above `PISO_SEGUNDOS_SHOPEE` (2020-01-01), i.e. a real one. */
const PAY_TIME_OK = 1_800_000_000;
/** A `pay_time` BELOW the floor — a 2017 value, which the fold calls absence. */
const PAY_TIME_PRE_2020 = 1_500_000_000;

/** A token Shopee has never published. The ladder answers `erro` for it. */
const TOKEN_INVENTADO = 'ESTADO_QUE_A_SHOPEE_NAO_PUBLICOU';

function leitura(over: Partial<LeituraReservaTravada> = {}): LeituraReservaTravada {
  return { orderStatus: SHOPEE_ORDER_STATUS.unpaid, payTime: null, pendingTerms: null, ...over };
}

/** The same digest the module computes, spelled out so we compare PREIMAGES. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/*  (1) a tabela — todos os onze status documentados, mais um inventado         */
/* -------------------------------------------------------------------------- */

type LinhaDaTabela = readonly [
  status: string,
  veredito: VereditoReservaTravada,
  redirigir: boolean,
  surfacar: boolean,
  alvoTipo: AlvoEstadoShopee['tipo'],
  alvoEstado: string | null,
];

const V = VEREDITO_RESERVA_TRAVADA;
const T = ALVO_ESTADO_SHOPEE;

const TABELA: readonly LinhaDaTabela[] = [
  [
    SHOPEE_ORDER_STATUS.unpaid,
    V.aindaNaoPago,
    false,
    true,
    T.estado,
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ],
  [
    SHOPEE_ORDER_STATUS.pending,
    V.aindaNaoPago,
    false,
    true,
    T.estado,
    ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ],
  [
    SHOPEE_ORDER_STATUS.readyToShip,
    V.redirecionadoAvancou,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.pago,
  ],
  [
    SHOPEE_ORDER_STATUS.processed,
    V.redirecionadoAvancou,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.pago,
  ],
  [
    SHOPEE_ORDER_STATUS.retryShip,
    V.redirecionadoAvancou,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.pago,
  ],
  [SHOPEE_ORDER_STATUS.shipped, V.redirecionadoAvancou, true, false, T.estado, ESTADO_PEDIDO.pago],
  [
    SHOPEE_ORDER_STATUS.toConfirmReceive,
    V.redirecionadoAvancou,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.pago,
  ],
  [
    SHOPEE_ORDER_STATUS.completed,
    V.redirecionadoAvancou,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.pago,
  ],
  [
    SHOPEE_ORDER_STATUS.inCancel,
    V.redirecionadoCancelado,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.processandoCancelamento,
  ],
  [
    SHOPEE_ORDER_STATUS.cancelled,
    V.redirecionadoCancelado,
    true,
    false,
    T.estado,
    ESTADO_PEDIDO.cancelado,
  ],
  [SHOPEE_ORDER_STATUS.toReturn, V.manterDevolucao, false, true, T.manter, null],
  [TOKEN_INVENTADO, V.statusDesconhecido, false, false, T.erro, null],
];

describe('1 — a tabela de classificação', () => {
  it.each(TABELA)(
    'Shopee diz %s ⇒ %s',
    (status, veredito, redirigir, surfacar, alvoTipo, alvoEstado) => {
      const c = classificarReservaTravada(leitura({ orderStatus: status }));
      expect(c.veredito).toBe(veredito);
      expect(c.redirigir).toBe(redirigir);
      expect(c.surfacar).toBe(surfacar);
      expect(c.alvo.tipo).toBe(alvoTipo);
      if (c.alvo.tipo === ALVO_ESTADO_SHOPEE.estado) {
        expect(c.alvo.estado).toBe(alvoEstado);
      }
      // `order_status` travels VERBATIM: it is the aviso `motivo` and the
      // synthetic push's `orderStatus` hint downstream.
      expect(c.orderStatus).toBe(status);
    },
  );

  it('a tabela cobre os ONZE status documentados, sem faltar nem sobrar', () => {
    // ⚠️ The guard that makes the table above worth anything: a token that
    // gains a rung in `orderStatusMaps.ts` without gaining a row here fails
    // HERE, not in a weekly tick nobody is watching.
    const naTabela = new Set(TABELA.map(([status]) => status));
    naTabela.delete(TOKEN_INVENTADO);
    expect([...naTabela].sort()).toEqual([...Object.values(SHOPEE_ORDER_STATUS)].sort());
  });

  it('um alvo `erro` carrega um motivo nomeado, que é o que o log imprime', () => {
    const { alvo } = classificarReservaTravada(leitura({ orderStatus: TOKEN_INVENTADO }));
    expect(alvo.tipo).toBe(ALVO_ESTADO_SHOPEE.erro);
    if (alvo.tipo === ALVO_ESTADO_SHOPEE.erro) {
      expect(alvo.motivo).toContain(TOKEN_INVENTADO);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) o dobrar do `pay_time` — a ÚNICA discriminação da barra de pendência    */
/* -------------------------------------------------------------------------- */

describe('2 — `pay_time`, a única discriminação da rung de pendência', () => {
  it('PENDING com pay_time utilizável ⇒ pendente-pago; PENDING com pay_time 0 / null / undefined / pré-2020 ⇒ ainda-nao-pago', () => {
    const pago = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.pending, payTime: PAY_TIME_OK }),
    );
    expect(pago.veredito).toBe(V.pendentePago);
    expect(pago.temPayTime).toBe(true);
    expect(pago.redirigir).toBe(false);
    expect(pago.surfacar).toBe(true);

    // ⚠️ The four absences Shopee can produce. `0` is the zero-fill this wire
    // uses for every unset numeric, and a `=== null` test would read it as
    // "paid at the epoch" — the near-miss this fold exists for. `undefined`
    // cannot arrive off a parsed row (every optional is `.nullable().default(null)`),
    // but a hand-built fixture may carry it and it must fold the same way.
    for (const payTime of [0, null, undefined, PAY_TIME_PRE_2020]) {
      const c = classificarReservaTravada(
        leitura({ orderStatus: SHOPEE_ORDER_STATUS.pending, payTime }),
      );
      expect(c.veredito).toBe(V.aindaNaoPago);
      expect(c.temPayTime).toBe(false);
      expect(c.surfacar).toBe(true);
      expect(c.redirigir).toBe(false);
    }
  });

  it('UNPAID com pay_time utilizável é uma contradição do provedor: ainda-nao-pago com temPayTime true', () => {
    // The token is what decides, not the fold: only the pendency token is asked
    // about `pay_time`. An UNPAID order carrying one is Shopee contradicting
    // itself, and the conservative answer — do not redirect, surface it — is
    // the same one the absence gets. `temPayTime` still reports the truth, so
    // the counter tables and the CLI column can show the contradiction.
    const c = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.unpaid, payTime: PAY_TIME_OK }),
    );
    expect(c.veredito).toBe(V.aindaNaoPago);
    expect(c.temPayTime).toBe(true);
    expect(c.redirigir).toBe(false);
    expect(c.surfacar).toBe(true);
  });

  it('`pending_terms` atravessa verbatim e NUNCA muda o veredito', () => {
    // The three documented terms land on the same two arms, discriminated by
    // `pay_time` alone: no wire field distinguishes BR's pending causes.
    const termos = ['SYSTEM_PENDING'];
    const semPagamento = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.pending, pendingTerms: termos }),
    );
    const comPagamento = classificarReservaTravada(
      leitura({
        orderStatus: SHOPEE_ORDER_STATUS.pending,
        payTime: PAY_TIME_OK,
        pendingTerms: ['ARRANGE_SHIPMENT_PENDING'],
      }),
    );
    expect(semPagamento.veredito).toBe(V.aindaNaoPago);
    expect(semPagamento.pendingTerms).toEqual(termos);
    expect(comPagamento.veredito).toBe(V.pendentePago);
    // `[]` (perguntamos, não há) e `null` (não perguntamos) são distintos, e
    // `undefined` dobra para `null`.
    expect(classificarReservaTravada(leitura({ pendingTerms: [] })).pendingTerms).toEqual([]);
    expect(classificarReservaTravada(leitura({ pendingTerms: null })).pendingTerms).toBeNull();
    expect(classificarReservaTravada(leitura({ pendingTerms: undefined })).pendingTerms).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) as duas afirmações perigosas, RODADAS contra a escada de verdade        */
/* -------------------------------------------------------------------------- */

describe('3 — o que a escada de verdade responde', () => {
  it('status desconhecido NÃO redireciona — re-conduzir escreveria estado error e SOLTARIA a reserva', () => {
    const c = classificarReservaTravada(leitura({ orderStatus: TOKEN_INVENTADO }));
    expect(c.veredito).toBe(V.statusDesconhecido);
    expect(c.redirigir).toBe(false);
    expect(c.surfacar).toBe(false);

    // ⚠️ THE reason, executed on the real engine instead of asserted in prose.
    // A synthetic code 3 re-drives step 5, which applies this same `alvo` to the
    // stored estado — and it WRITES.
    const aplicavel = estadoShopeeAplicavel(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento, c.alvo);
    expect(aplicavel).toEqual({
      escrever: true,
      estado: ESTADO_PEDIDO.error,
      ressuscitado: false,
    });

    // …and the estado it writes is OUTSIDE the reserve set, while the one it
    // replaces is inside it. That difference IS the released reservation.
    expect(ESTADOS_PEDIDO_RESERVA.has(ESTADO_PEDIDO.error)).toBe(false);
    expect(ESTADOS_PEDIDO_RESERVA.has(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento)).toBe(true);
  });

  it('TO_RETURN ⇒ manter-devolucao: a escada responde manter na PRIMEIRA cláusula', () => {
    const c = classificarReservaTravada(leitura({ orderStatus: SHOPEE_ORDER_STATUS.toReturn }));
    expect(c.veredito).toBe(V.manterDevolucao);
    expect(c.redirigir).toBe(false);
    expect(c.surfacar).toBe(true);

    // ⚠️ "First clause" is the load-bearing half: `manter` is answered BEFORE
    // the `sem-mudanca` and `fora-da-escada` tests, so no stored estado can
    // change the answer. That is why a re-drive provably cannot move this
    // pedido — and why the only remaining action is to surface it.
    for (const armazenado of [
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      ESTADO_PEDIDO.pago,
      ESTADO_PEDIDO.finalizado, // off-ladder: would answer `fora-da-escada`
      ESTADO_PEDIDO.cancelado,
    ]) {
      expect(estadoShopeeAplicavel(armazenado, c.alvo)).toEqual({
        escrever: false,
        motivo: MOTIVO_ESTADO_SHOPEE.manter,
      });
    }
  });

  it('só redirecionado-cancelado solta a reserva: cancelado e processandoCancelamento estão fora de ESTADOS_PEDIDO_RESERVA, pago está dentro', () => {
    // The whole reason the two `redirecionado-*` arms are separate counters.
    expect(ESTADOS_PEDIDO_RESERVA.has(ESTADO_PEDIDO.pago)).toBe(true);
    expect(ESTADOS_PEDIDO_RESERVA.has(ESTADO_PEDIDO.cancelado)).toBe(false);
    expect(ESTADOS_PEDIDO_RESERVA.has(ESTADO_PEDIDO.processandoCancelamento)).toBe(false);

    const avancou = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.readyToShip }),
    );
    const cancelou = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.cancelled }),
    );
    const emCancelamento = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.inCancel }),
    );
    expect(avancou.veredito).toBe(V.redirecionadoAvancou);
    expect(cancelou.veredito).toBe(V.redirecionadoCancelado);
    expect(emCancelamento.veredito).toBe(V.redirecionadoCancelado);
    // Both redirect; only one of them ends with the unit back on the shelf.
    expect([avancou.redirigir, cancelou.redirigir, emCancelamento.redirigir]).toEqual([
      true,
      true,
      true,
    ]);
    expect(avancou.veredito).not.toBe(cancelou.veredito);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) o conjunto de veredictos                                               */
/* -------------------------------------------------------------------------- */

describe('4 — os veredictos', () => {
  it('surfacar deriva de VEREDITOS_QUE_AVISAM', () => {
    // Not "these four surface" — that would be the second copy. The assertion
    // is that the boolean and the Set can never disagree, over every row.
    for (const [status] of TABELA) {
      const c = classificarReservaTravada(leitura({ orderStatus: status }));
      expect(c.surfacar).toBe(VEREDITOS_QUE_AVISAM.has(c.veredito));
    }
    const comPayTime = classificarReservaTravada(
      leitura({ orderStatus: SHOPEE_ORDER_STATUS.pending, payTime: PAY_TIME_OK }),
    );
    expect(comPayTime.surfacar).toBe(VEREDITOS_QUE_AVISAM.has(comPayTime.veredito));

    // And the set itself: four members, and `inexistente` is one of them even
    // though the classifier never returns it — it is decided at the READ.
    expect([...VEREDITOS_QUE_AVISAM].sort()).toEqual(
      [V.aindaNaoPago, V.inexistente, V.manterDevolucao, V.pendentePago].sort(),
    );
    expect(VEREDITOS_QUE_AVISAM.has(V.statusDesconhecido)).toBe(false);
    expect(VEREDITOS_QUE_AVISAM.has(V.naoVerificavel)).toBe(false);
  });

  it('VEREDITOS_RESERVA_TRAVADA cobre os onze membros sem repetição', () => {
    // It is the ZERO-SEED of the tick's counter map: a missing arm is a counter
    // that only appears in the weeks it happens to fire, which destroys the
    // week-over-week diff the rehearsal is.
    expect(VEREDITOS_RESERVA_TRAVADA).toHaveLength(11);
    expect(new Set(VEREDITOS_RESERVA_TRAVADA).size).toBe(11);
    expect([...VEREDITOS_RESERVA_TRAVADA].sort()).toEqual(
      [...Object.values(VEREDITO_RESERVA_TRAVADA)].sort(),
    );
    for (const veredito of VEREDITOS_QUE_AVISAM) {
      expect(VEREDITOS_RESERVA_TRAVADA).toContain(veredito);
    }
  });

  it('classificarReservaTravada é pura', () => {
    const entrada: LeituraReservaTravada = {
      orderStatus: SHOPEE_ORDER_STATUS.pending,
      payTime: PAY_TIME_OK,
      pendingTerms: ['ARRANGE_SHIPMENT_PENDING'],
    };
    const copia = JSON.parse(JSON.stringify(entrada)) as unknown;

    const primeira = classificarReservaTravada(entrada);
    const segunda = classificarReservaTravada(entrada);

    expect(primeira).toEqual(segunda);
    expect(primeira).not.toBe(segunda);
    // The input is untouched — no clock, no env, no hidden state read.
    expect(JSON.parse(JSON.stringify(entrada))).toEqual(copia);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) a fonte: uma tabela de status, e só uma                                */
/* -------------------------------------------------------------------------- */

describe('5 — a fonte', () => {
  it('a ÚNICA tabela de status consultada é estadoPedidoDeOrderStatus', () => {
    // A raw-text grep, so the module may not spell a status token even in a
    // comment. #1369 is why: a second copy of a marketplace rule drifts toward
    // PLAUSIBLE, so both files read correct while disagreeing, and a reviewer
    // cannot diff them by eye.
    const fonte = readFileSync(
      fileURLToPath(new URL('./reservaTravadaMapping.ts', import.meta.url)),
      'utf8',
    );
    for (const token of Object.values(SHOPEE_ORDER_STATUS)) {
      expect(fonte).not.toContain(`'${token}'`);
      expect(fonte).not.toContain(`"${token}"`);
    }
    // …and no second table of its own.
    expect(fonte).not.toContain('SHOPEE_ORDER_STATUS = {');
    expect(fonte).toContain('estadoPedidoDeOrderStatus');
    // ÂNCORA: the file really was read and really does hold the module.
    expect(fonte).toContain('export function classificarReservaTravada');
  });

  it('CODIGOS_PEDIDO_INEXISTENTE contém SHOPEE_ERRO_ORDER_NOT_FOUND', () => {
    // The pin that stops the two spellings drifting: one is the importer's
    // constant, the other is the page's own Error example. Both are on record.
    expect(CODIGOS_PEDIDO_INEXISTENTE.has(SHOPEE_ERRO_ORDER_NOT_FOUND)).toBe(true);
    expect(CODIGOS_PEDIDO_INEXISTENTE.has('error_not_found')).toBe(true);
    expect(CODIGOS_PEDIDO_INEXISTENTE.size).toBe(2);
    // QUASE-ERRO: a plausible third spelling is NOT one of ours, and treating
    // it as "the order is gone" would surface a live sale as inexistent.
    expect(CODIGOS_PEDIDO_INEXISTENTE.has('order_not_exist')).toBe(false);
    expect(CODIGOS_PEDIDO_INEXISTENTE.has('error_param')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) a prova de posse                                                       */
/* -------------------------------------------------------------------------- */

describe('6 — a posse do pedido', () => {
  it('provaDeIdentidadeShopee aceita o digest legado exato e recusa a grafia da issue', () => {
    const docId = makePedidoIdShopee(CONTA, ORDER_SN);
    const raw = { numero: ORDER_SN, integracaoPedidoOuterRef: OUTER_REF };

    expect(provaDeIdentidadeShopee(docId, raw)).toEqual({ contaId: CONTA, orderSn: ORDER_SN });

    // ⚠️ #1516 proposes `sha256("<contaId>|shopee|<order_sn>")`. It is a
    // DIFFERENT id, and a gate built from it would refuse every migrated Shopee
    // pedido — the population most likely to be stuck — and report an empty,
    // confident, wrong tick.
    const grafiaDaIssue = sha256Hex(`${CONTA}|shopee|${ORDER_SN}`);
    expect(grafiaDaIssue).not.toBe(docId);
    expect(provaDeIdentidadeShopee(grafiaDaIssue, raw)).toBeNull();

    // …and the Mercado Livre spelling is a third id, also refused.
    expect(provaDeIdentidadeShopee(sha256Hex(`shopee${CONTA}-${ORDER_SN}`), raw)).toBeNull();
  });

  it('sem `numero`, com `numero` vazio, não-string ou de outra conta ⇒ null', () => {
    const docId = makePedidoIdShopee(CONTA, ORDER_SN);
    expect(provaDeIdentidadeShopee(docId, { integracaoPedidoOuterRef: OUTER_REF })).toBeNull();
    expect(
      provaDeIdentidadeShopee(docId, { numero: '', integracaoPedidoOuterRef: OUTER_REF }),
    ).toBeNull();
    expect(
      provaDeIdentidadeShopee(docId, { numero: 260910, integracaoPedidoOuterRef: OUTER_REF }),
    ).toBeNull();
    expect(provaDeIdentidadeShopee(docId, { numero: ORDER_SN })).toBeNull();
    expect(
      provaDeIdentidadeShopee(docId, {
        numero: ORDER_SN,
        integracaoPedidoOuterRef: 'documents/integracao/int-2',
      }),
    ).toBeNull();
  });

  it('integracaoIdDoPedidoShopee', () => {
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: OUTER_REF })).toBe(CONTA);
    // A bare id survives: `.split('/').filter(Boolean).pop()` is the last
    // non-empty segment, whatever the prefix.
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: CONTA })).toBe(CONTA);
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: `${OUTER_REF}/` })).toBe(CONTA);
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: '' })).toBeNull();
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: '///' })).toBeNull();
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: 42 })).toBeNull();
    expect(integracaoIdDoPedidoShopee({ integracaoPedidoOuterRef: null })).toBeNull();
    expect(integracaoIdDoPedidoShopee({})).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (7) a idade — o lado ARMAZENADO, onde o corpus legado é em ms              */
/* -------------------------------------------------------------------------- */

describe('7 — idadeEmDias', () => {
  /** ~2025-09, in MICROseconds. Its ms twin is ~1.756e12. */
  const NOW_US = 1_757_000_000_000_000;

  it('idadeEmDias: um timestamp legado em MILISSEGUNDOS sai coerido, não 1970', () => {
    const oitoDiasUs = NOW_US - 8 * DIA_US;
    const oitoDiasMs = oitoDiasUs / 1000;
    expect(Number.isInteger(oitoDiasMs)).toBe(true);

    expect(idadeEmDias(oitoDiasUs, NOW_US)).toBe(8);
    // ⚠️ The legacy Flutter app serialised every DateTime as ms, so a migrated
    // Shopee pedido arrives at this magnitude. A strict `typeof === 'number'`
    // reader (the ML sweep's `readMicros`) would take it verbatim and report an
    // age of ~55 000 days. `coerceToMicros` classifies by magnitude instead.
    expect(idadeEmDias(oitoDiasMs, NOW_US)).toBe(8);
    // The same instant through the ISO string the legacy export also produces.
    expect(idadeEmDias(new Date(oitoDiasMs).toISOString(), NOW_US)).toBe(8);
  });

  it('o que não coage sai null, e um carimbo no FUTURO sai 0 — nunca negativo', () => {
    expect(idadeEmDias('não é uma data', NOW_US)).toBeNull();
    expect(idadeEmDias(null, NOW_US)).toBeNull();
    expect(idadeEmDias(undefined, NOW_US)).toBeNull();
    expect(idadeEmDias({}, NOW_US)).toBeNull();
    expect(idadeEmDias(Number.NaN, NOW_US)).toBeNull();

    expect(idadeEmDias(NOW_US + DIA_US, NOW_US)).toBe(0);
    expect(idadeEmDias(NOW_US, NOW_US)).toBe(0);
    // Truncation is toward the past: 7 days and 23 hours is still 7.
    expect(idadeEmDias(NOW_US - (8 * DIA_US - 3_600_000_000), NOW_US)).toBe(7);
  });
});

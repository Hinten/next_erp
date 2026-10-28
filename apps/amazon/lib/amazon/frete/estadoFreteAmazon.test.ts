import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pacoteWireAmazonSchema,
  type PacoteWireAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_FRETE,
  STATUS_PAGAMENTO,
  estadoFreteSchema,
  type EstadoFrete,
  type EstadoPedido,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import type { ContextoEstadoAmazon } from '../pedidos/estadoPedidoAmazon';
import { MERCADORIA_FORA } from '../pedidos/freteAmazon';
import { DETAILED_STATUS_REVERSAO, ehDetailedStatusReversao } from '../pedidos/pacotesAmazon';
import { pacoteAmazon, pedidoAmazon, type OpcoesPacoteTeste } from '../testing/pedidoWireAmazon';
import {
  ESCADA_FRETE_AMAZON,
  ESTADO_FRETE_DE_DETAILED_STATUS,
  FALHAS_FRETE_AMAZON,
  MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON,
  REVERSAO_DO_FRETE_AMAZON,
  STATUS_PACOTE_AMAZON,
  alvoFreteAmazon,
  alvoSemPacotesAmazon,
  diarioComMercadoriaForaAmazon,
  dobrarPacotesAmazon,
  estadoDaLinhaAmazon,
  estadoFreteAmazonAplicavel,
  estadoFreteEfetivoAmazon,
  estadoFreteParaMercadoriaForaAmazon,
  grupoFreteAmazon,
  lerFreteAmazon,
  logisticaAmazon,
  mesmoDiarioAmazon,
  projetarPacoteAmazon,
  statusPacoteComMercadoriaForaAmazon,
  type DobraPacotesAmazon,
  type LinhaDiarioAmazon,
  type LogisticaAmazon,
} from './estadoFreteAmazon';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RELOGIO_US = 1_790_000_000_000_000;
const DEPOIS_US = RELOGIO_US + 60_000_000;

function pacote(
  ref: string | null | undefined,
  detalhe: string | null | undefined,
  opcoes: OpcoesPacoteTeste = {},
): PacoteWireAmazon {
  return pacoteWireAmazonSchema.parse(pacoteAmazon(ref, detalhe, opcoes));
}

function dobrar(
  pacotes: readonly PacoteWireAmazon[],
  extra: { invoiceStatus?: unknown; armazenados?: unknown; relogioUs?: number } = {},
): DobraPacotesAmazon {
  return dobrarPacotesAmazon(pacotes, {
    invoiceStatus: extra.invoiceStatus ?? null,
    relogioUs: extra.relogioUs ?? RELOGIO_US,
    armazenados: extra.armazenados,
  });
}

/** The verdict; an MFN read unless the test says otherwise. */
const aplicavel = (
  de: EstadoFrete,
  para: EstadoFrete | null,
  o: { maisNovo?: boolean; logistica?: LogisticaAmazon } = {},
) =>
  estadoFreteAmazonAplicavel(de, para, {
    maisNovo: o.maisNovo ?? false,
    logistica: o.logistica ?? 'mfn',
  });

const LOGISTICAS: readonly LogisticaAmazon[] = ['mfn', 'afn', 'desconhecida'];

/* -------------------------------------------------------------------------- */

describe('the table — one row per token, matched EXACTLY', () => {
  it.each([
    ['PENDING_PICK_UP', 'aguardandoPostagem'],
    ['PENDING_DROP_OFF', 'aguardandoPostagem'],
    ['LABEL_CANCELLED', 'despachoNegado'],
    ['PICKED_UP', 'postado'],
    ['DROPPED_OFF', 'postado'],
    ['AT_ORIGIN_FC', 'recebidoPelaTransportadora'],
    ['AT_DESTINATION_FC', 'aCaminho'],
    ['OUT_FOR_DELIVERY', 'tentandoRealizarEntrega'],
    ['DELIVERED', 'entregue'],
    ['REJECTED_BY_BUYER', 'falhaNaEntrega'],
    ['UNDELIVERABLE', 'enderecoNaoEncontrado'],
    ['RETURNING_TO_SELLER', 'aCaminhoDoRemetente'],
    ['RETURNED_TO_SELLER', 'devolvido'],
    ['LOST', 'objetoExtraviado'],
    ['DAMAGED', 'objetoExtraviado'],
  ] as const)('%s ⇒ %s (whatever the invoice status)', (token, estado) => {
    for (const nota of [null, 'NOT_FOUND', 'ACCEPTED']) {
      expect(projetarPacoteAmazon(token, nota)).toEqual({
        tipo: 'estado',
        estado,
        notaNaoExigida: false,
      });
    }
  });

  it('PENDING_SCHEDULE: the invoice status decides — NOT_FOUND/PROCESSING/ERRORED ⇒ aguardandoNFe, ACCEPTED ⇒ aguardandoAgendamento, NOT_REQUIRED ⇒ aguardandoAgendamento + the count flag', () => {
    for (const nota of ['NOT_FOUND', 'PROCESSING', 'ERRORED']) {
      expect(projetarPacoteAmazon('PENDING_SCHEDULE', nota)).toEqual({
        tipo: 'estado',
        estado: 'aguardandoNFe',
        notaNaoExigida: false,
      });
    }
    expect(projetarPacoteAmazon('PENDING_SCHEDULE', 'ACCEPTED')).toEqual({
      tipo: 'estado',
      estado: 'aguardandoAgendamento',
      notaNaoExigida: false,
    });
    expect(projetarPacoteAmazon('PENDING_SCHEDULE', 'NOT_REQUIRED')).toEqual({
      tipo: 'estado',
      estado: 'aguardandoAgendamento',
      notaNaoExigida: true,
    });
  });

  it('PENDING_SCHEDULE with the invoice status absent, blank or unknown ⇒ NO change (never a guess); NEAR-MISS spellings of the invoice status are unknown too', () => {
    for (const nota of [null, undefined, '', 'accepted', 'ACCEPTED ', 'INVOICE_UNCONFIRMED', 7]) {
      expect(projetarPacoteAmazon('PENDING_SCHEDULE', nota), String(nota)).toEqual({
        tipo: 'sem-nota',
      });
    }
  });

  it('★ NEAR-MISS tokens are UNKNOWN: one L, a trailing space, lower case, an inherited name, absent', () => {
    for (const token of [
      'LABEL_CANCELED',
      'DELIVERED ',
      ' DELIVERED',
      'delivered',
      'Delivered',
      'PICKED-UP',
      'constructor',
      'toString',
      '',
      null,
      undefined,
      7,
    ]) {
      expect(projetarPacoteAmazon(token, 'ACCEPTED'), String(token)).toEqual({
        tipo: 'desconhecido',
      });
    }
  });

  it('★ the reversal rows are EXACTLY the step-5 set — the same object, identity-equal (never a second list)', () => {
    expect(REVERSAO_DO_FRETE_AMAZON).toBe(DETAILED_STATUS_REVERSAO);
    const naEscadaOuColeta = (e: EstadoFrete) =>
      (ESCADA_FRETE_AMAZON as readonly EstadoFrete[]).includes(e) ||
      e === ESTADO_FRETE.despachoNegado;
    const tokensDeReversao = Object.entries(ESTADO_FRETE_DE_DETAILED_STATUS)
      .filter(([, l]) => l.tipo === 'estado' && !naEscadaOuColeta(l.estado))
      .map(([t]) => t)
      .sort();
    expect(tokensDeReversao).toEqual(Object.keys(DETAILED_STATUS_REVERSAO).sort());
    for (const token of Object.keys(ESTADO_FRETE_DE_DETAILED_STATUS)) {
      expect(ehDetailedStatusReversao(token), token).toBe(tokensDeReversao.includes(token));
    }
  });

  it('holds exactly the sixteen documented tokens, frozen; every target is a member of the enum', () => {
    expect(Object.keys(ESTADO_FRETE_DE_DETAILED_STATUS).sort()).toEqual(
      [
        'PENDING_SCHEDULE',
        'PENDING_PICK_UP',
        'PENDING_DROP_OFF',
        'LABEL_CANCELLED',
        'PICKED_UP',
        'DROPPED_OFF',
        'AT_ORIGIN_FC',
        'AT_DESTINATION_FC',
        'DELIVERED',
        'REJECTED_BY_BUYER',
        'UNDELIVERABLE',
        'RETURNING_TO_SELLER',
        'RETURNED_TO_SELLER',
        'LOST',
        'OUT_FOR_DELIVERY',
        'DAMAGED',
      ].sort(),
    );
    expect(Object.isFrozen(ESTADO_FRETE_DE_DETAILED_STATUS)).toBe(true);
    for (const l of Object.values(ESTADO_FRETE_DE_DETAILED_STATUS)) {
      if (l.tipo === 'estado') expect(estadoFreteSchema.safeParse(l.estado).success).toBe(true);
    }
  });
});

describe('an order without packages (alvoSemPacotesAmazon)', () => {
  it('UNSHIPPED / PARTIALLY_SHIPPED ⇒ the invoice status decides as PENDING_SCHEDULE', () => {
    for (const status of ['UNSHIPPED', 'PARTIALLY_SHIPPED']) {
      expect(alvoSemPacotesAmazon(pedidoAmazon({ status, invoiceStatus: 'NOT_FOUND' }))).toEqual({
        tipo: 'estado',
        estado: 'aguardandoNFe',
        notaNaoExigida: false,
      });
      expect(alvoSemPacotesAmazon(pedidoAmazon({ status, invoiceStatus: 'ACCEPTED' }))).toEqual({
        tipo: 'estado',
        estado: 'aguardandoAgendamento',
        notaNaoExigida: false,
      });
      expect(alvoSemPacotesAmazon(pedidoAmazon({ status }))).toEqual({ tipo: 'sem-nota' });
    }
  });

  it('★ PENDING, SHIPPED (no status-only floor), CANCELLED and an unknown status ⇒ no change', () => {
    for (const status of ['PENDING', 'PENDING_AVAILABILITY', 'SHIPPED', 'CANCELLED', 'NEW', null]) {
      expect(
        alvoSemPacotesAmazon(pedidoAmazon({ status, invoiceStatus: 'ACCEPTED' })),
        String(status),
      ).toBeNull();
    }
  });
});

describe('the ladder and the verdict', () => {
  it('★ the ladder is pinned EXPLICITLY (aguardandoAgendamento BEFORE despachoAutorizado — not the enum order)', () => {
    expect(ESCADA_FRETE_AMAZON).toEqual([
      'iniciado',
      'aguardandoAutorizacao',
      'aguardandoNFe',
      'aguardandoValidacaoTransporadora',
      'aguardandoAgendamento',
      'despachoAutorizado',
      'emSeparacao',
      'empacotado',
      'aguardandoPostagem',
      'checkFinalizado',
      'postado',
      'recebidoPelaTransportadora',
      'aCaminho',
      'tentandoRealizarEntrega',
      'entregue',
    ]);
    // The enum itself orders them the other way round: a copy of it would be wrong.
    const enumOrdem = estadoFreteSchema.options as readonly string[];
    expect(enumOrdem.indexOf('despachoAutorizado')).toBeLessThan(
      enumOrdem.indexOf('aguardandoAgendamento'),
    );
  });

  it('★ aguardandoAgendamento after despachoAutorizado ⇒ regressivo; despachoAutorizado after aguardandoAgendamento ⇒ written', () => {
    expect(aplicavel(ESTADO_FRETE.despachoAutorizado, ESTADO_FRETE.aguardandoAgendamento)).toEqual({
      escrever: false,
      motivo: 'regressivo',
    });
    expect(
      aplicavel(ESTADO_FRETE.aguardandoAgendamento, ESTADO_FRETE.despachoAutorizado),
    ).toMatchObject({
      escrever: true,
    });
  });

  it('★ aguardandoPostagem after checkFinalizado ⇒ regressivo (the checkout survives a late PENDING_PICK_UP); postado after it ⇒ written', () => {
    expect(aplicavel(ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.aguardandoPostagem)).toEqual({
      escrever: false,
      motivo: 'regressivo',
    });
    expect(aplicavel(ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.postado)).toEqual({
      escrever: true,
      estado: 'postado',
      ressuscitado: false,
    });
  });

  it('every rung pair: forward written, backward regressivo, equal sem-mudanca', () => {
    ESCADA_FRETE_AMAZON.forEach((de, i) => {
      ESCADA_FRETE_AMAZON.forEach((para, j) => {
        const v = aplicavel(de, para);
        if (i === j) expect(v).toEqual({ escrever: false, motivo: 'sem-mudanca' });
        else if (j < i)
          expect(v, `${de}→${para}`).toEqual({ escrever: false, motivo: 'regressivo' });
        else
          expect(v, `${de}→${para}`).toEqual({ escrever: true, estado: para, ressuscitado: false });
      });
    });
  });

  it('★ a failure → entregue is always written (any clock)', () => {
    for (const falha of FALHAS_FRETE_AMAZON) {
      expect(aplicavel(falha, ESTADO_FRETE.entregue)).toEqual({
        escrever: true,
        estado: 'entregue',
        ressuscitado: false,
      });
    }
  });

  /** The ladder split by the goods-out table (pinned literally, then checked against it). */
  const DEGRAUS_DENTRO = [
    'iniciado',
    'aguardandoAutorizacao',
    'aguardandoNFe',
    'aguardandoValidacaoTransporadora',
    'aguardandoAgendamento',
    'despachoAutorizado',
    'emSeparacao',
    'empacotado',
    'aguardandoPostagem',
    'checkFinalizado',
  ] as const satisfies readonly EstadoFrete[];
  const DEGRAUS_FORA_VIVOS = [
    'postado',
    'recebidoPelaTransportadora',
    'aCaminho',
    'tentandoRealizarEntrega',
  ] as const satisfies readonly EstadoFrete[];
  const FALHAS_DENTRO = ['despachoNegado', 'cancelado'] as const satisfies readonly EstadoFrete[];
  const FALHAS_FORA = [
    'falhaNaEntrega',
    'enderecoNaoEncontrado',
    'objetoExtraviado',
  ] as const satisfies readonly EstadoFrete[];

  it('the splits the verdict tests use ARE the ladder, the failure set and the goods-out table', () => {
    expect(ESCADA_FRETE_AMAZON).toEqual([...DEGRAUS_DENTRO, ...DEGRAUS_FORA_VIVOS, 'entregue']);
    for (const e of DEGRAUS_DENTRO) expect(MERCADORIA_FORA[e], e).toBe(false);
    for (const e of [...DEGRAUS_FORA_VIVOS, 'entregue'] as const) {
      expect(MERCADORIA_FORA[e], e).toBe(true);
    }
    expect([...FALHAS_FRETE_AMAZON].filter((f) => !MERCADORIA_FORA[f])).toEqual(FALHAS_DENTRO);
    expect([...FALHAS_FRETE_AMAZON].filter((f) => MERCADORIA_FORA[f])).toEqual(FALHAS_FORA);
  });

  it('★ a live rung after a failure: a goods-IN failure → any rung, and a goods-OUT failure → a goods-out rung, are refused on an EQUAL clock and ressuscitado on a strictly newer one (the reschedule after LABEL_CANCELLED); a goods-OUT failure → a goods-IN rung is regressivo on ANY clock', () => {
    for (const logistica of ['mfn', 'desconhecida'] as const) {
      const ressuscita = (falha: EstadoFrete, vivo: EstadoFrete) => {
        const nome = `${falha}→${vivo}/${logistica}`;
        expect(aplicavel(falha, vivo, { logistica }), nome).toEqual({
          escrever: false,
          motivo: 'terminal',
        });
        expect(aplicavel(falha, vivo, { logistica, maisNovo: true }), nome).toEqual({
          escrever: true,
          estado: vivo,
          ressuscitado: true,
        });
      };
      // The pickup cancelled with the goods still in: every rung, the reschedule included.
      for (const falha of FALHAS_DENTRO) {
        for (const vivo of [...DEGRAUS_DENTRO, ...DEGRAUS_FORA_VIVOS]) ressuscita(falha, vivo);
      }
      for (const falha of FALHAS_FORA) {
        // NEAR-MISS: the goods out again (a re-delivery attempt, a found parcel).
        for (const vivo of DEGRAUS_FORA_VIVOS) ressuscita(falha, vivo);
        // A sibling still waiting beside a lost one is no fact that the units came back.
        for (const vivo of DEGRAUS_DENTRO) {
          for (const maisNovo of [false, true]) {
            expect(
              aplicavel(falha, vivo, { logistica, maisNovo }),
              `${falha}→${vivo}/${logistica}/${String(maisNovo)}`,
            ).toEqual({ escrever: false, motivo: 'regressivo' });
          }
        }
      }
    }
    // The two the PR-review probes walked, side by side.
    expect(
      aplicavel(ESTADO_FRETE.objetoExtraviado, ESTADO_FRETE.aguardandoPostagem, { maisNovo: true }),
    ).toEqual({ escrever: false, motivo: 'regressivo' });
    expect(
      aplicavel(ESTADO_FRETE.despachoNegado, ESTADO_FRETE.aguardandoPostagem, { maisNovo: true }),
    ).toEqual({ escrever: true, estado: 'aguardandoPostagem', ressuscitado: true });
  });

  it('a live rung → a failure, a failure → another failure, and a failure → the reverse leg are written', () => {
    expect(aplicavel(ESTADO_FRETE.aCaminho, ESTADO_FRETE.falhaNaEntrega)).toMatchObject({
      escrever: true,
    });
    expect(aplicavel(ESTADO_FRETE.aguardandoPostagem, ESTADO_FRETE.despachoNegado)).toMatchObject({
      escrever: true,
    });
    expect(aplicavel(ESTADO_FRETE.falhaNaEntrega, ESTADO_FRETE.objetoExtraviado)).toMatchObject({
      escrever: true,
    });
    expect(aplicavel(ESTADO_FRETE.falhaNaEntrega, ESTADO_FRETE.aCaminhoDoRemetente)).toMatchObject({
      escrever: true,
    });
    expect(aplicavel(ESTADO_FRETE.enderecoNaoEncontrado, ESTADO_FRETE.devolvido)).toMatchObject({
      escrever: true,
    });
  });

  it('★ gate 8, ENUMERATED over every stored estado × every target × the three logistics × both clocks: goods OUT at the stored estado (through the residue projection) → goods IN at the target ⇒ regressivo, exactly on the documented pairs', () => {
    /** The targets where the goods are in that are OFF the ladder. */
    const DENTRO_FORA_DA_ESCADA = [
      'fulfillment',
      'despachoNegado',
      'cancelado',
      'desconhecido',
      'error',
    ] as const satisfies readonly EstadoFrete[];
    const DEGRAUS_FORA = [...DEGRAUS_FORA_VIVOS, 'entregue'] as const;
    // The two lists are EVERY estado where the goods are in, once.
    expect([...DENTRO_FORA_DA_ESCADA, ...DEGRAUS_DENTRO].sort()).toEqual(
      estadoFreteSchema.options.filter((e) => !MERCADORIA_FORA[e]).sort(),
    );
    /** The pairs the docblock names: a goods-out rung → off-ladder; a goods-out failure → anything in. */
    const documentados = (logistica: LogisticaAmazon): string[] => {
      if (logistica === 'afn') return [];
      const pares: string[] = [];
      // The residue is rung 11 only under a MERCHANT read (gate 4 holds it otherwise).
      const degraus = logistica === 'mfn' ? [...DEGRAUS_FORA, 'fulfillment'] : [...DEGRAUS_FORA];
      for (const de of degraus) {
        for (const para of DENTRO_FORA_DA_ESCADA) if (de !== para) pares.push(`${de}→${para}`);
      }
      for (const de of FALHAS_FORA) {
        for (const para of [...DENTRO_FORA_DA_ESCADA, ...DEGRAUS_DENTRO]) {
          pares.push(`${de}→${para}`);
        }
      }
      return pares.sort();
    };
    const escada = ESCADA_FRETE_AMAZON as readonly EstadoFrete[];
    for (const logistica of LOGISTICAS) {
      for (const maisNovo of [false, true]) {
        const disparam: string[] = [];
        for (const de of estadoFreteSchema.options) {
          const efetivo = estadoFreteEfetivoAmazon(de, logistica);
          for (const para of estadoFreteSchema.options) {
            const v = aplicavel(de, para, { maisNovo, logistica });
            const i = escada.indexOf(efetivo);
            const j = escada.indexOf(para);
            // Gate 7 is the only OTHER source of `regressivo`.
            const peloGate7 = i >= 0 && j >= 0 && j < i;
            if (!v.escrever && v.motivo === 'regressivo' && !peloGate7) {
              disparam.push(`${de}→${para}`);
            }
            // And no gate ever WRITES goods out → goods in.
            if (MERCADORIA_FORA[efetivo] && !MERCADORIA_FORA[para]) {
              expect(v.escrever, `${de}→${para}/${logistica}/${String(maisNovo)}`).toBe(false);
            }
          }
        }
        expect(disparam.sort(), `${logistica}/${String(maisNovo)}`).toEqual(
          documentados(logistica),
        );
      }
    }
    // Anti-vacuity: the MERCHANT set is 5×5 + 4 (the residue) + 3×15.
    expect(documentados('mfn')).toHaveLength(74);
  });

  it('★ goods out → an estado where they are IN (a LABEL_CANCELLED after the pickup) ⇒ regressivo on ANY clock; the NEAR-MISSes are still written', () => {
    for (const de of [...DEGRAUS_FORA_VIVOS, 'entregue', ...FALHAS_FORA] as const) {
      for (const para of ['despachoNegado', 'cancelado', 'error'] as const) {
        for (const maisNovo of [false, true]) {
          expect(aplicavel(de, para, { maisNovo }), `${de}→${para}/${String(maisNovo)}`).toEqual({
            escrever: false,
            motivo: 'regressivo',
          });
        }
      }
    }
    // The legacy residue is rung 11 under a MERCHANT read: goods out, the same gate.
    expect(aplicavel(ESTADO_FRETE.fulfillment, ESTADO_FRETE.despachoNegado)).toEqual({
      escrever: false,
      motivo: 'regressivo',
    });
    // NEAR-MISS: a step-14 `error` stamp over goods-IN freight is still written.
    expect(aplicavel(ESTADO_FRETE.aguardandoPostagem, ESTADO_FRETE.error)).toEqual({
      escrever: true,
      estado: 'error',
      ressuscitado: false,
    });
    // NEAR-MISS: the goods still in the warehouse — the pickup cancellation is written.
    for (const de of [
      'iniciado',
      'aguardandoAgendamento',
      'aguardandoPostagem',
      'checkFinalizado',
      'cancelado',
      'desconhecido',
    ] as const) {
      expect(aplicavel(de, ESTADO_FRETE.despachoNegado), de).toEqual({
        escrever: true,
        estado: 'despachoNegado',
        ressuscitado: false,
      });
    }
    // NEAR-MISS: goods out → goods out off the ladder is still written.
    expect(aplicavel(ESTADO_FRETE.postado, ESTADO_FRETE.objetoExtraviado)).toEqual({
      escrever: true,
      estado: 'objetoExtraviado',
      ressuscitado: false,
    });
  });

  it('the reverse leg: only forward on it', () => {
    expect(aplicavel(ESTADO_FRETE.aCaminhoDoRemetente, ESTADO_FRETE.devolvido)).toEqual({
      escrever: true,
      estado: 'devolvido',
      ressuscitado: false,
    });
    for (const para of ['aCaminhoDoRemetente', 'entregue', 'aCaminho', 'falhaNaEntrega'] as const) {
      expect(aplicavel(ESTADO_FRETE.devolvido, para, { maisNovo: true }), para).toMatchObject({
        escrever: false,
      });
    }
    for (const para of ['entregue', 'postado', 'falhaNaEntrega'] as const) {
      expect(aplicavel(ESTADO_FRETE.aCaminhoDoRemetente, para, { maisNovo: true }), para).toEqual({
        escrever: false,
        motivo: 'retorno-preservado',
      });
    }
  });

  it('★ a stored error (step 14’s stamp): a non-physical target is refused, a physical fact is written (the conservative arm only)', () => {
    for (const para of [
      'aguardandoAgendamento',
      'aguardandoNFe',
      'despachoNegado',
      'cancelado',
    ] as const) {
      expect(aplicavel(ESTADO_FRETE.error, para, { maisNovo: true }), para).toEqual({
        escrever: false,
        motivo: 'erro-preservado',
      });
    }
    for (const para of ['postado', 'aguardandoPostagem', 'entregue', 'objetoExtraviado'] as const) {
      expect(aplicavel(ESTADO_FRETE.error, para), para).toEqual({
        escrever: true,
        estado: para,
        ressuscitado: false,
      });
    }
  });

  it('fora-do-canal: a stored aguardandoRetirada or suspenso is never moved; fulfillment on an AFN order neither', () => {
    for (const de of ['aguardandoRetirada', 'suspenso'] as const) {
      expect(aplicavel(de, ESTADO_FRETE.entregue, { maisNovo: true })).toEqual({
        escrever: false,
        motivo: 'fora-do-canal',
      });
    }
    expect(
      aplicavel(ESTADO_FRETE.fulfillment, ESTADO_FRETE.aCaminho, {
        maisNovo: true,
        logistica: 'afn',
      }),
    ).toEqual({
      escrever: false,
      motivo: 'fora-do-canal',
    });
  });

  it('★ an AFN read moves NO block, whatever is stored — never into a stock-removal estado, never to cancelado', () => {
    for (const de of estadoFreteSchema.options) {
      for (const para of [
        ESTADO_FRETE.aguardandoPostagem,
        ESTADO_FRETE.postado,
        ESTADO_FRETE.aCaminho,
        ESTADO_FRETE.entregue,
        ESTADO_FRETE.cancelado,
      ]) {
        if (de === para) continue;
        expect(aplicavel(de, para, { maisNovo: true, logistica: 'afn' }), `${de}→${para}`).toEqual({
          escrever: false,
          motivo: 'fora-do-canal',
        });
      }
    }
    // NEAR-MISS: the same stored iniciado walks under an MFN read and an unknown one.
    for (const logistica of ['mfn', 'desconhecida'] as const) {
      expect(aplicavel(ESTADO_FRETE.iniciado, ESTADO_FRETE.postado, { logistica })).toMatchObject({
        escrever: true,
      });
    }
  });

  it('★ a stored fulfillment under a read WITHOUT fulfilledBy is fora-do-canal (the AFN seed and the MFN residue hold the same value)', () => {
    for (const para of [ESTADO_FRETE.aCaminho, ESTADO_FRETE.entregue, ESTADO_FRETE.cancelado]) {
      expect(
        aplicavel(ESTADO_FRETE.fulfillment, para, { maisNovo: true, logistica: 'desconhecida' }),
      ).toEqual({ escrever: false, motivo: 'fora-do-canal' });
    }
  });

  it('★ the logistics is fulfilledBy EXACTLY: MERCHANT ⇒ mfn, AMAZON ⇒ afn, anything else (absent, blank, case, a space) ⇒ desconhecida', () => {
    expect(logisticaAmazon('MERCHANT')).toBe('mfn');
    expect(logisticaAmazon('AMAZON')).toBe('afn');
    for (const outro of [null, undefined, '', ' ', 'merchant', 'MERCHANT ', 'amazon', 'FBA', 1]) {
      expect(logisticaAmazon(outro), String(outro)).toBe('desconhecida');
    }
  });

  it('★ the LADDER’s residue projection: stored fulfillment under MERCHANT ⇒ rung 11 (goods out); under any other read, or any other estado, as stored', () => {
    expect(estadoFreteEfetivoAmazon(ESTADO_FRETE.fulfillment, 'mfn')).toBe(
      'recebidoPelaTransportadora',
    );
    expect(MERCADORIA_FORA[estadoFreteEfetivoAmazon(ESTADO_FRETE.fulfillment, 'mfn')]).toBe(true);
    // NEAR-MISS: an AFN read and an unknown one keep it — the ladder cannot
    // attribute the block, so it never walks it.
    for (const logistica of ['afn', 'desconhecida'] as const) {
      expect(estadoFreteEfetivoAmazon(ESTADO_FRETE.fulfillment, logistica)).toBe('fulfillment');
    }
    for (const de of estadoFreteSchema.options) {
      if (de === ESTADO_FRETE.fulfillment) continue;
      for (const logistica of LOGISTICAS) {
        expect(estadoFreteEfetivoAmazon(de, logistica), `${de}/${logistica}`).toBe(de);
      }
    }
  });

  it('★ (PR 5-f) the GOODS-OUT reading’s projection is the ladder’s with ONE widening: a stored fulfillment under a read without fulfilledBy is rung 11 too unless the pedido is our own AFN error — over every stored estado × the three logistics × both answers of the AFN-error test', () => {
    for (const de of estadoFreteSchema.options) {
      for (const logistica of LOGISTICAS) {
        for (const afnNosso of [false, true]) {
          const nome = `${de}/${logistica}/${String(afnNosso)}`;
          const alargado =
            de === ESTADO_FRETE.fulfillment && logistica === 'desconhecida' && !afnNosso;
          expect(estadoFreteParaMercadoriaForaAmazon(de, { logistica, afnNosso }), nome).toBe(
            alargado
              ? ESTADO_FRETE.recebidoPelaTransportadora
              : estadoFreteEfetivoAmazon(de, logistica),
          );
        }
      }
    }
    // The pair that must come out equal, and the near-misses that must stay distinct.
    const fora = (logistica: LogisticaAmazon, afnNosso: boolean) =>
      MERCADORIA_FORA[
        estadoFreteParaMercadoriaForaAmazon(ESTADO_FRETE.fulfillment, { logistica, afnNosso })
      ];
    expect(fora('desconhecida', false)).toBe(fora('mfn', false));
    expect(fora('desconhecida', false)).toBe(true);
    // Our AFN seed under an unknown read, and the AFN read itself (the C1 flip), stay goods IN.
    expect(fora('desconhecida', true)).toBe(false);
    expect(fora('afn', false)).toBe(false);
    expect(fora('afn', true)).toBe(false);
    // MERCHANT reads the residue whatever the stored pedido (unchanged).
    expect(fora('mfn', true)).toBe(true);
  });

  it('★ legacy residue: a stored fulfillment on an MFN order reads as rung 11 — PICKED_UP regressive, AT_DESTINATION_FC written (NEAR-MISS against fora-do-canal)', () => {
    expect(aplicavel(ESTADO_FRETE.fulfillment, ESTADO_FRETE.postado)).toEqual({
      escrever: false,
      motivo: 'regressivo',
    });
    expect(aplicavel(ESTADO_FRETE.fulfillment, ESTADO_FRETE.aCaminho)).toEqual({
      escrever: true,
      estado: 'aCaminho',
      ressuscitado: false,
    });
  });

  it('legacy residue: a stored desconhecido is overwritable; a stored cancelado on a live order reads as a failure (equal clock refused, newer written)', () => {
    expect(aplicavel(ESTADO_FRETE.desconhecido, ESTADO_FRETE.aguardandoNFe)).toMatchObject({
      escrever: true,
    });
    expect(aplicavel(ESTADO_FRETE.cancelado, ESTADO_FRETE.postado)).toEqual({
      escrever: false,
      motivo: 'terminal',
    });
    expect(
      aplicavel(ESTADO_FRETE.cancelado, ESTADO_FRETE.postado, { maisNovo: true }),
    ).toMatchObject({
      escrever: true,
      ressuscitado: true,
    });
  });

  it('no target ⇒ sem-alvo, whatever is stored', () => {
    for (const de of estadoFreteSchema.options) {
      expect(aplicavel(de, null, { maisNovo: true })).toEqual({
        escrever: false,
        motivo: 'sem-alvo',
      });
    }
  });
});

describe('the fold (dobrarPacotesAmazon)', () => {
  it('★ two packages at rungs 8 and 12 ⇒ 8 (the LEAST advanced, stock-safe)', () => {
    const d = dobrar([pacote('A', 'PENDING_PICK_UP'), pacote('B', 'AT_DESTINATION_FC')]);
    expect(d).toMatchObject({ alvo: 'aguardandoPostagem', bloqueado: false });
    // Order-independent.
    expect(dobrar([pacote('B', 'AT_DESTINATION_FC'), pacote('A', 'PENDING_PICK_UP')]).alvo).toBe(
      'aguardandoPostagem',
    );
  });

  it('★ one unknown token blocks the whole answer (never skipped), the known package still gets its row', () => {
    const d = dobrar([pacote('A', 'DELIVERED'), pacote('B', 'SOMETHING_NEW')]);
    expect(d).toMatchObject({
      alvo: null,
      bloqueado: true,
      contagens: { pacotes: 2, naoMapeados: 1, semChave: 0 },
    });
    expect(d.pacotes.map((l) => [l.numero, l.estado, l.estadoMarketplace])).toEqual([
      ['A', 'entregue', 'DELIVERED'],
      ['B', null, 'SOMETHING_NEW'],
    ]);
  });

  it('★ LABEL_CANCELLED + PENDING_PICK_UP ⇒ aguardandoPostagem (a failed row is ignored while a live one exists), and the coleta flag', () => {
    expect(dobrar([pacote('A', 'LABEL_CANCELLED'), pacote('B', 'PENDING_PICK_UP')])).toMatchObject({
      alvo: 'aguardandoPostagem',
      coletaCancelada: true,
      bloqueado: false,
    });
    expect(dobrar([pacote('A', 'LABEL_CANCELLED')])).toMatchObject({
      alvo: 'despachoNegado',
      coletaCancelada: true,
    });
  });

  it('★ only failures ⇒ the precedence by physical consequence, never the clock', () => {
    const casos: [string[], EstadoFrete][] = [
      [['LOST', 'REJECTED_BY_BUYER', 'LABEL_CANCELLED'], 'objetoExtraviado'],
      [['UNDELIVERABLE', 'REJECTED_BY_BUYER'], 'falhaNaEntrega'],
      [['UNDELIVERABLE', 'LABEL_CANCELLED'], 'enderecoNaoEncontrado'],
      [['RETURNED_TO_SELLER', 'RETURNING_TO_SELLER'], 'aCaminhoDoRemetente'],
      [['RETURNED_TO_SELLER', 'LABEL_CANCELLED'], 'devolvido'],
      [['UNDELIVERABLE', 'RETURNING_TO_SELLER'], 'enderecoNaoEncontrado'],
      [['DAMAGED', 'RETURNED_TO_SELLER'], 'objetoExtraviado'],
    ];
    for (const [tokens, esperado] of casos) {
      const pacotes = tokens.map((t, i) => pacote(`P${String(i)}`, t));
      expect(dobrar(pacotes).alvo, tokens.join('+')).toBe(esperado);
      expect(dobrar([...pacotes].reverse()).alvo, tokens.join('+')).toBe(esperado);
    }
  });

  it('a live package wins over a failed or returning one', () => {
    expect(dobrar([pacote('A', 'DELIVERED'), pacote('B', 'RETURNED_TO_SELLER')]).alvo).toBe(
      'entregue',
    );
    expect(dobrar([pacote('A', 'LOST'), pacote('B', 'PICKED_UP')]).alvo).toBe('postado');
  });

  it('★ a package without a packageReferenceId ⇒ blocked + no row of its own; the other package’s row is still written', () => {
    for (const ref of [undefined, null, '', '   ', 'x'.repeat(61)]) {
      const d = dobrar([pacote(ref, 'DELIVERED', { rastreio: 'TRK-1' }), pacote('B', 'PICKED_UP')]);
      expect(d, String(ref)).toMatchObject({
        alvo: null,
        bloqueado: true,
        contagens: { pacotes: 2, naoMapeados: 0, semChave: 1 },
      });
      expect(d.pacotes.map((l) => l.numero)).toEqual(['B']);
    }
    // NEAR-MISS: a 60-character reference keys a row.
    expect(dobrar([pacote('y'.repeat(60), 'DELIVERED')]).bloqueado).toBe(false);
  });

  it('the same reference twice in one read keys nothing: blocked, neither row written', () => {
    const d = dobrar([
      pacote('A', 'DELIVERED'),
      pacote('A', 'PICKED_UP'),
      pacote('B', 'DELIVERED'),
    ]);
    expect(d).toMatchObject({ alvo: null, bloqueado: true, contagens: { semChave: 2 } });
    expect(d.pacotes.map((l) => l.numero)).toEqual(['B']);
  });

  it('★ VERBATIM, never trimmed: the key, the token, the status and the tracking number keep their spaces (and a spaced key is not its trimmed twin)', () => {
    const d = dobrar([
      pacote(' PKG-1 ', 'DELIVERED ', { status: 'IN_TRANSIT ', rastreio: ' TRK-1 ' }),
      pacote('PKG-1', 'DELIVERED'),
    ]);
    // Two DIFFERENT keys: no duplicate, two rows.
    expect(d.contagens.semChave).toBe(0);
    expect(d.pacotes.map((l) => l.numero)).toEqual([' PKG-1 ', 'PKG-1']);
    expect(d.pacotes[0]).toMatchObject({
      estado: null,
      estadoMarketplace: 'DELIVERED ',
      statusMarketplace: 'IN_TRANSIT ',
      codRastreio: ' TRK-1 ',
    });
    // The spaced token is UNKNOWN: blocked (no `entregue` from its twin).
    expect(d).toMatchObject({ alvo: null, bloqueado: true, contagens: { naoMapeados: 1 } });
    expect(d.codRastreio).toBe(' TRK-1 ');
  });

  it('★ NEAR-MISS: a LABEL_CANCELLED with a stray space is NOT a cancelled pickup (it is an unknown token)', () => {
    expect(dobrar([pacote('A', 'LABEL_CANCELLED ')])).toMatchObject({
      coletaCancelada: false,
      bloqueado: true,
    });
    expect(dobrar([pacote('A', 'label_cancelled')]).coletaCancelada).toBe(false);
    expect(dobrar([pacote('A', 'LABEL_CANCELED')]).coletaCancelada).toBe(false);
  });

  it('★ no status-only floor: a package with status SHIPPED/DELIVERED and no detailedStatus is UNKNOWN', () => {
    for (const status of ['SHIPPED', 'DELIVERED', 'IN_TRANSIT']) {
      expect(dobrar([pacote('A', undefined, { status })]), status).toMatchObject({
        alvo: null,
        bloqueado: true,
      });
    }
  });

  it('an invoice-less PENDING_SCHEDULE gives no answer (no motivo: the token is known), even beside a live package', () => {
    expect(dobrar([pacote('A', 'PENDING_SCHEDULE')])).toMatchObject({
      alvo: null,
      bloqueado: false,
      semNota: true,
    });
    expect(
      dobrar([pacote('A', 'PENDING_SCHEDULE'), pacote('B', 'PICKED_UP')], {
        invoiceStatus: 'ACCEPTED',
      }),
    ).toMatchObject({ alvo: 'aguardandoAgendamento', semNota: false });
    expect(
      dobrar([pacote('A', 'PENDING_SCHEDULE')], { invoiceStatus: 'NOT_REQUIRED' }),
    ).toMatchObject({ alvo: 'aguardandoAgendamento', notaNaoExigida: true });
  });

  it('the diary rows: sorted by numero, verbatim tokens and tracking, the closed status stored, fonte getOrder, the ORDER clock', () => {
    const d = dobrar(
      [
        pacote('Z-2', 'AT_ORIGIN_FC', { status: 'IN_TRANSIT', rastreio: 'TRK-2' }),
        pacote('A-1', 'PENDING_SCHEDULE', { status: 'PENDING' }),
      ],
      { invoiceStatus: 'PROCESSING' },
    );
    expect(d.pacotes).toEqual([
      {
        canalId: null,
        prazoDespacho: null,
        numero: 'A-1',
        estado: 'aguardandoNFe',
        estadoMarketplace: 'PENDING_SCHEDULE',
        statusMarketplace: 'PENDING',
        codRastreio: null,
        atualizadoEm: RELOGIO_US,
        fonte: 'getOrder',
      },
      {
        canalId: null,
        prazoDespacho: null,
        numero: 'Z-2',
        estado: 'recebidoPelaTransportadora',
        estadoMarketplace: 'AT_ORIGIN_FC',
        statusMarketplace: 'IN_TRANSIT',
        codRastreio: 'TRK-2',
        atualizadoEm: RELOGIO_US,
        fonte: 'getOrder',
      },
    ]);
    expect(d.statusPacotes).toBe('IN_TRANSIT,PENDING');
    expect(
      dobrar([
        pacote('A', 'DELIVERED', { status: 'NEW_ONE' }),
        pacote('B', 'DELIVERED', { status: null }),
      ]).statusPacotes,
    ).toBe('<ausente>,<outro>');
  });

  it('★ goods out is read from EVERY package, apart from the least-advanced target and the block', () => {
    const fora = (pacotes: PacoteWireAmazon[], invoiceStatus: unknown = 'ACCEPTED') =>
      dobrar(pacotes, { invoiceStatus });
    // A package with the carrier beside one still waiting: the target is the
    // waiting one (stock-safe for REMOVING), the goods are out all the same.
    const misto = fora([pacote('A', 'PICKED_UP'), pacote('B', 'PENDING_PICK_UP')]);
    expect(misto).toMatchObject({ alvo: 'aguardandoPostagem', mercadoriaFora: true });
    // Beside an unknown token (blocked: no target; its closed status PENDING, so
    // the picked-up package alone says it) and an unkeyed package.
    expect(
      fora([pacote('A', 'PICKED_UP'), pacote('B', 'NEW_TOKEN', { status: 'PENDING' })]),
    ).toMatchObject({
      alvo: null,
      bloqueado: true,
      mercadoriaFora: true,
    });
    expect(fora([pacote(undefined, 'AT_ORIGIN_FC')])).toMatchObject({
      alvo: null,
      mercadoriaFora: true,
    });
    // Beside an invoice-less PENDING_SCHEDULE (no answer).
    expect(fora([pacote('A', 'PENDING_SCHEDULE'), pacote('B', 'DELIVERED')], null)).toMatchObject({
      alvo: null,
      semNota: true,
      mercadoriaFora: true,
    });
    // A failure is goods out too (lost, refused, returning).
    expect(fora([pacote('A', 'LOST')]).mercadoriaFora).toBe(true);
    // NEAR-MISS: nothing out — waiting, a cancelled pickup, and an unknown or a
    // spaced token whose closed status still says PENDING (PR 5-f's fallback).
    const pendente = { status: 'PENDING' };
    for (const pacotes of [
      [pacote('A', 'PENDING_PICK_UP'), pacote('B', 'PENDING_SCHEDULE')],
      [pacote('A', 'LABEL_CANCELLED')],
      [pacote('A', 'NEW_TOKEN', pendente)],
      [pacote('A', 'PICKED_UP ', pendente)],
      [pacote('A', 'picked_up', pendente)],
    ]) {
      const tokens = pacotes.map((x) => x.packageStatus?.detailedStatus).join();
      expect(fora(pacotes).mercadoriaFora, tokens).toBe(false);
    }
    expect(fora([]).mercadoriaFora).toBe(false);
  });

  it('★ the ROW GATE: a stored row where the goods are OUT keeps its estado when this read projects them IN, or projects nothing — the wire fields still take this read, verbatim, and atualizadoEm advances on that wire change', () => {
    const coletado = dobrar([
      pacote('PKG-1', 'PICKED_UP', { status: 'IN_TRANSIT', rastreio: 'TRK-1' }),
    ]);
    expect(coletado.pacotes[0]).toMatchObject({ numero: 'PKG-1', estado: 'postado' });
    const casos: [string, Partial<DobraPacotesAmazon>][] = [
      ['LABEL_CANCELLED', { alvo: ESTADO_FRETE.despachoNegado, coletaCancelada: true }],
      ['PENDING_PICK_UP', { alvo: ESTADO_FRETE.aguardandoPostagem }],
      ['PENDING_DROP_OFF', { alvo: ESTADO_FRETE.aguardandoPostagem }],
      ['NEW_TOKEN', { alvo: null, bloqueado: true }],
      ['PENDING_SCHEDULE', { alvo: null, semNota: true }],
    ];
    for (const [token, dobra] of casos) {
      const d = dobrar([pacote('PKG-1', token, { status: 'PENDING', rastreio: 'TRK-2' })], {
        relogioUs: DEPOIS_US,
        armazenados: coletado.pacotes,
      });
      expect(d.pacotes, token).toEqual([
        {
          canalId: null,
          prazoDespacho: null,
          numero: 'PKG-1',
          estado: 'postado',
          estadoMarketplace: token,
          statusMarketplace: 'PENDING',
          codRastreio: 'TRK-2',
          atualizadoEm: DEPOIS_US,
          fonte: 'getOrder',
        },
      ]);
      // The target and the flags read the PROJECTION: the stock-safe target for
      // REMOVING stock is unchanged, and the kept estado (a STORED row's, which
      // the predicate's third reading counts) does not feed this read's flag.
      expect(d, token).toMatchObject({ ...dobra, mercadoriaFora: false });
    }
    // A sibling still waiting beside the kept row: the target is the waiting one.
    const comIrmao = dobrar(
      [pacote('PKG-1', 'LABEL_CANCELLED'), pacote('PKG-2', 'PENDING_PICK_UP')],
      {
        relogioUs: DEPOIS_US,
        armazenados: coletado.pacotes,
      },
    );
    expect(comIrmao.alvo).toBe('aguardandoPostagem');
    expect(comIrmao.pacotes.map((l) => [l.numero, l.estado])).toEqual([
      ['PKG-1', 'postado'],
      ['PKG-2', 'aguardandoPostagem'],
    ]);
    // An EQUAL-clock redelivery of the read that kept the row is an EMPTY diff,
    // and a later clock on the same wire keeps the stored atualizadoEm.
    const cancelado = dobrar([pacote('PKG-1', 'LABEL_CANCELLED', { rastreio: 'TRK-1' })], {
      relogioUs: DEPOIS_US,
      armazenados: coletado.pacotes,
    });
    for (const relogioUs of [DEPOIS_US, DEPOIS_US + 60_000_000]) {
      const deNovo = dobrar([pacote('PKG-1', 'LABEL_CANCELLED', { rastreio: 'TRK-1' })], {
        relogioUs,
        armazenados: cancelado.pacotes,
      });
      expect(mesmoDiarioAmazon(cancelado.pacotes, deNovo.pacotes), String(relogioUs)).toBe(true);
      expect(deNovo.pacotes[0]).toMatchObject({ estado: 'postado', atualizadoEm: DEPOIS_US });
    }
  });

  it('★ the row gate’s NEAR-MISSes: goods out → a DIFFERENT goods-out projection is written; a goods-in row is re-derived; a malformed or another package’s stored row keeps nothing', () => {
    const linha = (estado: unknown, numero = 'PKG-1'): LinhaDiarioAmazon => ({
      numero,
      estado,
      estadoMarketplace: 'X',
      statusMarketplace: 'IN_TRANSIT',
      codRastreio: null,
      atualizadoEm: RELOGIO_US,
      fonte: 'getOrder',
    });
    const estadoApos = (guardado: unknown, token: string, invoiceStatus: unknown = 'ACCEPTED') =>
      dobrar([pacote('PKG-1', token)], {
        invoiceStatus,
        relogioUs: DEPOIS_US,
        armazenados: [guardado],
      }).pacotes.find((l) => l.numero === 'PKG-1')?.estado;
    // Goods out → goods out, a different estado: written (the row follows Amazon).
    const foraParaFora: [EstadoFrete, string, EstadoFrete][] = [
      ['postado', 'AT_DESTINATION_FC', 'aCaminho'],
      ['postado', 'LOST', 'objetoExtraviado'],
      ['postado', 'RETURNED_TO_SELLER', 'devolvido'],
      ['aCaminho', 'DELIVERED', 'entregue'],
      ['objetoExtraviado', 'PICKED_UP', 'postado'],
      ['recebidoPelaTransportadora', 'REJECTED_BY_BUYER', 'falhaNaEntrega'],
    ];
    for (const [guardado, token, esperado] of foraParaFora) {
      expect(estadoApos(linha(guardado), token), `${guardado}+${token}`).toBe(esperado);
    }
    // Goods in → anything: re-derived as before.
    const dentro: [EstadoFrete, string, EstadoFrete | null][] = [
      ['aguardandoPostagem', 'LABEL_CANCELLED', 'despachoNegado'],
      ['despachoNegado', 'PENDING_PICK_UP', 'aguardandoPostagem'],
      ['aguardandoNFe', 'PENDING_SCHEDULE', 'aguardandoAgendamento'],
      ['aguardandoPostagem', 'PICKED_UP', 'postado'],
      ['aguardandoPostagem', 'NEW_TOKEN', null],
      // A row this importer never writes, read AS STORED (no residue projection).
      ['fulfillment', 'LABEL_CANCELLED', 'despachoNegado'],
    ];
    for (const [guardado, token, esperado] of dentro) {
      expect(estadoApos(linha(guardado), token), `${guardado}+${token}`).toBe(esperado);
    }
    // A malformed stored estado keeps nothing (no trim, no case fold, no coercion,
    // no inherited property name: an `in`-style lookup would read those as goods out).
    for (const malformado of [
      'POSTADO',
      ' postado',
      'postado ',
      7,
      null,
      undefined,
      ['postado'],
      'toString',
      'constructor',
      '__proto__',
    ]) {
      expect(estadoApos(linha(malformado), 'LABEL_CANCELLED'), String(malformado)).toBe(
        'despachoNegado',
      );
    }
    // Another package's goods-out row never lends PKG-1 its estado (and is kept as stored).
    const outro = linha('postado', 'PKG-0');
    const d = dobrar([pacote('PKG-1', 'LABEL_CANCELLED')], {
      relogioUs: DEPOIS_US,
      armazenados: [outro],
    });
    expect(d.pacotes.map((l) => [l.numero, l.estado])).toEqual([
      ['PKG-0', 'postado'],
      ['PKG-1', 'despachoNegado'],
    ]);
    expect(d.pacotes[0]).toBe(outro);
    // The goods-out flag is never weakened by a stored row: a goods-out projection counts.
    expect(
      dobrar([pacote('PKG-1', 'AT_DESTINATION_FC')], {
        relogioUs: DEPOIS_US,
        armazenados: [linha('aguardandoPostagem')],
      }).mercadoriaFora,
    ).toBe(true);
  });

  it('atualizadoEm advances ONLY when a wire field of that row changed — never on a re-projection alone', () => {
    const primeiro = dobrar([pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING' })], {
      invoiceStatus: 'NOT_FOUND',
    });
    // Same wire, the invoice accepted (the projection moves), a later clock.
    const mesmoFio = dobrar([pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING' })], {
      invoiceStatus: 'ACCEPTED',
      relogioUs: DEPOIS_US,
      armazenados: primeiro.pacotes,
    });
    expect(mesmoFio.pacotes[0]).toMatchObject({
      estado: 'aguardandoAgendamento',
      atualizadoEm: RELOGIO_US,
    });
    for (const mudanca of [
      pacote('A', 'PENDING_PICK_UP', { status: 'PENDING' }),
      pacote('A', 'PENDING_SCHEDULE', { status: 'IN_TRANSIT' }),
      pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING', rastreio: 'TRK-9' }),
      // NEAR-MISS (the comparison's SCOPE): a change of whitespace alone is a change.
      pacote('A', 'PENDING_SCHEDULE ', { status: 'PENDING' }),
      pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING ' }),
    ]) {
      expect(
        dobrar([mudanca], {
          invoiceStatus: 'ACCEPTED',
          relogioUs: DEPOIS_US,
          armazenados: primeiro.pacotes,
        }).pacotes[0]?.atualizadoEm,
      ).toBe(DEPOIS_US);
    }
    // The tracking number too: 'TRK-9 ' against a stored 'TRK-9' is a change.
    const comRastreio = dobrar(
      [pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING', rastreio: 'TRK-9' })],
      { invoiceStatus: 'ACCEPTED' },
    );
    const espaco = dobrar(
      [pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING', rastreio: 'TRK-9 ' })],
      { invoiceStatus: 'ACCEPTED', relogioUs: DEPOIS_US, armazenados: comRastreio.pacotes },
    );
    expect(espaco.pacotes[0]).toMatchObject({ codRastreio: 'TRK-9 ', atualizadoEm: DEPOIS_US });
    // And the control: the very same wire keeps the stored clock.
    expect(
      dobrar([pacote('A', 'PENDING_SCHEDULE', { status: 'PENDING', rastreio: 'TRK-9' })], {
        invoiceStatus: 'ACCEPTED',
        relogioUs: DEPOIS_US,
        armazenados: comRastreio.pacotes,
      }).pacotes[0]?.atualizadoEm,
    ).toBe(RELOGIO_US);
  });

  it('a stored row this read does not name is KEPT as stored (never deleted), in numero order; its other keys survive', () => {
    const guardado: LinhaDiarioAmazon[] = [
      { numero: 'M', estado: 'postado', estadoMarketplace: 'PICKED_UP', extra: 'x' },
    ];
    const d = dobrar([pacote('Z', 'DELIVERED'), pacote('A', 'DELIVERED')], {
      armazenados: guardado,
    });
    expect(d.pacotes.map((l) => l.numero)).toEqual(['A', 'M', 'Z']);
    expect(d.pacotes[1]).toBe(guardado[0]);
    // A row this read DOES name keeps its unknown keys too.
    const comExtra = dobrar([pacote('M', 'DELIVERED')], { armazenados: guardado });
    expect(comExtra.pacotes[0]).toMatchObject({ numero: 'M', extra: 'x', estado: 'entregue' });
  });

  it('★ codRastreio: the distinct numbers, sorted by numero, joined; nothing to say ⇒ null; capped at 200 by whole entries', () => {
    const d = dobrar([
      pacote('B', 'PICKED_UP', { rastreio: 'TRK-B' }),
      pacote('A', 'PICKED_UP', { rastreio: 'TRK-A' }),
      pacote('C', 'PICKED_UP', { rastreio: 'TRK-A' }),
      pacote('D', 'PICKED_UP', { rastreio: '  ' }),
    ]);
    expect(d.codRastreio).toBe('TRK-A, TRK-B');
    expect(dobrar([pacote('A', 'PICKED_UP')]).codRastreio).toBeNull();
    const longos = Array.from({ length: 12 }, (_, i) =>
      pacote(`P${String(i).padStart(2, '0')}`, 'PICKED_UP', {
        rastreio: `TRK-${'9'.repeat(20)}-${String(i)}`,
      }),
    );
    const cortado = dobrar(longos).codRastreio ?? '';
    expect(cortado.length).toBeLessThanOrEqual(200);
    expect(cortado).toMatch(/ \+\d+$/);
    expect(cortado.startsWith(`TRK-${'9'.repeat(20)}-0, `)).toBe(true);
  });
});

describe('the stored diary as goods-out evidence (the predicate’s third reading)', () => {
  it('★ some stored row whose estado READS as goods out ⇒ true — keyed or not, beside goods-in and malformed rows', () => {
    for (const estado of estadoFreteSchema.options) {
      expect(diarioComMercadoriaForaAmazon([{ numero: 'A', estado }]), estado).toBe(
        MERCADORIA_FORA[estado],
      );
    }
    expect(diarioComMercadoriaForaAmazon([{ estado: 'objetoExtraviado' }])).toBe(true);
    expect(
      diarioComMercadoriaForaAmazon([
        null,
        7,
        'postado',
        { numero: 'B', estado: 'aguardandoPostagem' },
        { numero: 'C', estado: 'POSTADO' },
        { numero: 'A', estado: 'aCaminho' },
      ]),
    ).toBe(true);
  });

  it('★ NEAR-MISS: a goods-in diary, a malformed row (no trim, no case fold, no coercion), a non-array, or a row read through the residue projection contribute NOTHING', () => {
    for (const diario of [
      undefined,
      null,
      'postado',
      7,
      { 0: { numero: 'A', estado: 'postado' }, length: 1 },
      [],
      [
        { numero: 'A', estado: 'aguardandoPostagem' },
        { numero: 'B', estado: 'despachoNegado' },
      ],
      [{ numero: 'A', estado: 'POSTADO' }],
      [{ numero: 'A', estado: ' postado' }],
      [{ numero: 'A', estado: 'postado ' }],
      [{ numero: 'A', estado: 7 }],
      [{ numero: 'A', estado: null }],
      [{ numero: 'A' }],
      [{ numero: 'A', estado: ['postado'] }],
      // Inherited property names: an `in`-style lookup would read them as goods out.
      [{ numero: 'A', estado: 'toString' }],
      [{ numero: 'A', estado: 'constructor' }],
      [{ numero: 'A', estado: '__proto__' }],
      ['postado'],
      [['postado']],
      [null],
      // AS STORED: a row is never the block's legacy residue.
      [{ numero: 'A', estado: 'fulfillment' }],
    ]) {
      expect(diarioComMercadoriaForaAmazon(diario), JSON.stringify(diario)).toBe(false);
    }
  });

  it('estadoDaLinhaAmazon: a member of the enum, or null', () => {
    expect(estadoDaLinhaAmazon({ numero: 'A', estado: 'postado' })).toBe('postado');
    expect(estadoDaLinhaAmazon({ estado: 'aguardandoPostagem', extra: 1 })).toBe(
      'aguardandoPostagem',
    );
    for (const linhaRuim of [
      null,
      undefined,
      'postado',
      ['postado'],
      { estado: 'Postado' },
      {},
      { estado: 'toString' },
      { estado: 'constructor' },
      { estado: '__proto__' },
    ]) {
      expect(estadoDaLinhaAmazon(linhaRuim), JSON.stringify(linhaRuim)).toBeNull();
    }
  });
});

describe('★ PR 5-f — the goods-out fallback on packageStatus.status (an unknown detailedStatus only; never the target)', () => {
  const FORA = ['IN_TRANSIT', 'SHIPPED', 'DELIVERED', 'UNDELIVERABLE'] as const;
  /** Tokens the table does not hold: absent, blank, undocumented, misspelt, inherited, not a string. */
  const DESCONHECIDOS: readonly unknown[] = [
    undefined,
    null,
    '',
    '   ',
    'NEW_TOKEN',
    'PICKED_UP ',
    'picked_up',
    'LABEL_CANCELED',
    'toString',
    '__proto__',
    7,
  ];

  it('the status table is EXPLICIT and EXHAUSTIVE over the closed enum, frozen: exactly IN_TRANSIT, SHIPPED, DELIVERED and UNDELIVERABLE say the goods left', () => {
    expect(Object.keys(MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON).sort()).toEqual(
      Object.values(STATUS_PACOTE_AMAZON).sort(),
    );
    expect(
      Object.entries(MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON)
        .filter(([, fora]) => fora)
        .map(([status]) => status)
        .sort(),
    ).toEqual([...FORA].sort());
    expect(Object.isFrozen(MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON)).toBe(true);
  });

  it('★ an unknown detailedStatus (absent included) beside a goods-out status ⇒ goods out', () => {
    for (const token of DESCONHECIDOS) {
      expect(projetarPacoteAmazon(token, 'ACCEPTED'), String(token)).toEqual({
        tipo: 'desconhecido',
      });
      for (const status of FORA) {
        expect(
          statusPacoteComMercadoriaForaAmazon(token, status),
          `${String(token)}+${status}`,
        ).toBe(true);
      }
    }
  });

  it('★ NEAR-MISS (the status): PENDING, CANCELLED, absent, or anything not EXACTLY a member (case, a space, an inherited name, an undocumented value, not a string) ⇒ not goods out', () => {
    for (const status of [
      'PENDING',
      'CANCELLED',
      undefined,
      null,
      '',
      'in_transit',
      'IN_TRANSIT ',
      ' SHIPPED',
      'Delivered',
      'toString',
      'constructor',
      '__proto__',
      'NEW_STATUS',
      7,
      ['IN_TRANSIT'],
    ]) {
      for (const token of [undefined, 'NEW_TOKEN']) {
        expect(
          statusPacoteComMercadoriaForaAmazon(token, status),
          `${String(token)}+${JSON.stringify(status)}`,
        ).toBe(false);
      }
    }
  });

  it('★ NEAR-MISS (the token): a KNOWN detailedStatus always decides on its own — no table row falls back to the status, whatever it says', () => {
    for (const token of Object.keys(ESTADO_FRETE_DE_DETAILED_STATUS)) {
      for (const status of FORA) {
        expect(statusPacoteComMercadoriaForaAmazon(token, status), `${token}+${status}`).toBe(
          false,
        );
      }
    }
  });

  it('★ the fold: the flag rises for an unknown or absent token whose status says the package left — keyed or not — while the TARGET stays the blocked answer and the row estado stays null (no status-only floor)', () => {
    for (const status of FORA) {
      for (const p of [
        pacote('A', undefined, { status }),
        pacote('A', 'NEW_TOKEN', { status }),
        pacote(undefined, undefined, { status }),
      ]) {
        const d = dobrar([p], { invoiceStatus: 'ACCEPTED' });
        expect(d, status).toMatchObject({ alvo: null, bloqueado: true, mercadoriaFora: true });
        for (const l of d.pacotes) expect(l.estado, status).toBeNull();
      }
    }
    // Beside a sibling still waiting: the target stays blocked, the goods are out.
    expect(
      dobrar(
        [
          pacote('A', 'PENDING_PICK_UP', { status: 'PENDING' }),
          pacote('B', undefined, { status: 'DELIVERED' }),
        ],
        { invoiceStatus: 'ACCEPTED' },
      ),
    ).toMatchObject({ alvo: null, bloqueado: true, mercadoriaFora: true });
    // NEAR-MISS: the same unreadable packages whose status does not say it ⇒ nothing out.
    for (const status of ['PENDING', 'CANCELLED', null, 'NEW_STATUS']) {
      for (const p of [pacote('A', undefined, { status }), pacote('A', 'NEW_TOKEN', { status })]) {
        expect(dobrar([p]).mercadoriaFora, String(status)).toBe(false);
      }
    }
    // NEAR-MISS: a known token decides, against the status in BOTH directions.
    const casos: [string, string, boolean][] = [
      ['PENDING_PICK_UP', 'SHIPPED', false],
      ['LABEL_CANCELLED', 'DELIVERED', false],
      ['PENDING_SCHEDULE', 'IN_TRANSIT', false],
      ['PICKED_UP', 'PENDING', true],
      ['DELIVERED', 'CANCELLED', true],
    ];
    for (const [token, status, fora] of casos) {
      expect(dobrar([pacote('A', token, { status })]).mercadoriaFora, `${token}+${status}`).toBe(
        fora,
      );
    }
  });

  it('★ durable: the row the fold writes reads as goods out in the stored-diary reading, through its VERBATIM estadoMarketplace and statusMarketplace; the fold and the stored reading answer the same for every token × status', () => {
    const d = dobrar([pacote('PKG-1', undefined, { status: 'IN_TRANSIT' })]);
    expect(d.pacotes).toEqual([
      expect.objectContaining({
        numero: 'PKG-1',
        estado: null,
        estadoMarketplace: null,
        statusMarketplace: 'IN_TRANSIT',
      }),
    ]);
    expect(diarioComMercadoriaForaAmazon(d.pacotes)).toBe(true);
    for (const status of FORA) {
      expect(
        diarioComMercadoriaForaAmazon([
          { numero: 'A', estado: null, estadoMarketplace: 'NEW_TOKEN', statusMarketplace: status },
        ]),
        status,
      ).toBe(true);
      // A row without an estadoMarketplace key: an unknown token, like absent.
      expect(diarioComMercadoriaForaAmazon([{ numero: 'A', statusMarketplace: status }])).toBe(
        true,
      );
    }
    // NEAR-MISS rows: a known estadoMarketplace decides; a status not EXACTLY in the set.
    for (const linhaGuardada of [
      {
        numero: 'A',
        estado: 'aguardandoPostagem',
        estadoMarketplace: 'PENDING_PICK_UP',
        statusMarketplace: 'SHIPPED',
      },
      {
        numero: 'A',
        estado: 'despachoNegado',
        estadoMarketplace: 'LABEL_CANCELLED',
        statusMarketplace: 'DELIVERED',
      },
      {
        numero: 'A',
        estado: null,
        estadoMarketplace: 'PENDING_SCHEDULE',
        statusMarketplace: 'IN_TRANSIT',
      },
      { numero: 'A', estado: null, estadoMarketplace: null, statusMarketplace: 'PENDING' },
      { numero: 'A', estado: null, estadoMarketplace: null, statusMarketplace: 'CANCELLED' },
      { numero: 'A', estado: null, estadoMarketplace: null, statusMarketplace: null },
      { numero: 'A', estado: null, estadoMarketplace: null },
      { numero: 'A', estado: null, estadoMarketplace: null, statusMarketplace: 'in_transit' },
      { numero: 'A', estado: null, estadoMarketplace: null, statusMarketplace: 'IN_TRANSIT ' },
      { numero: 'A', estado: null, estadoMarketplace: null, statusMarketplace: 'toString' },
    ]) {
      expect(diarioComMercadoriaForaAmazon([linhaGuardada]), JSON.stringify(linhaGuardada)).toBe(
        false,
      );
    }
    // Read N and read N+1 agree: the read's flag equals the stored reading of the row it wrote.
    const tokens: (string | undefined)[] = [
      ...Object.keys(ESTADO_FRETE_DE_DETAILED_STATUS),
      undefined,
      '',
      '   ',
      'NEW_TOKEN',
      'X'.repeat(121),
    ];
    const statuses: (string | null)[] = [
      ...Object.values(STATUS_PACOTE_AMAZON),
      null,
      '   ',
      'NEW_STATUS',
      ' IN_TRANSIT',
      'S'.repeat(121),
    ];
    for (const token of tokens) {
      for (const status of statuses) {
        for (const invoiceStatus of [null, 'ACCEPTED']) {
          const lida = dobrar([pacote('PKG-1', token, { status })], { invoiceStatus });
          expect(
            diarioComMercadoriaForaAmazon(lida.pacotes),
            `${String(token)}+${String(status)}+${String(invoiceStatus)}`,
          ).toBe(lida.mercadoriaFora);
        }
      }
    }
  });

  it('★ RESIDUAL, pinned as it is today: the fallback’s evidence lives in the row’s WIRE fields, so a later read naming the same package with a goods-IN reading rewrites them and the row stops saying the goods left (no estado is invented for it); NEAR-MISS: a row whose goods out is its ESTADO keeps it (the row gate)', () => {
    const emTransito = dobrar([pacote('PKG-1', undefined, { status: 'IN_TRANSIT' })]);
    expect(diarioComMercadoriaForaAmazon(emTransito.pacotes)).toBe(true);
    const leituras: [string | undefined, string][] = [
      ['PENDING_PICK_UP', 'PENDING'],
      ['LABEL_CANCELLED', 'CANCELLED'],
      [undefined, 'PENDING'],
      ['NEW_TOKEN', 'CANCELLED'],
    ];
    for (const [token, status] of leituras) {
      const depois = dobrar([pacote('PKG-1', token, { status })], {
        invoiceStatus: 'ACCEPTED',
        relogioUs: DEPOIS_US,
        armazenados: emTransito.pacotes,
      });
      expect(depois.pacotes[0], `${String(token)}+${status}`).toMatchObject({
        estadoMarketplace: token ?? null,
        statusMarketplace: status,
      });
      expect(diarioComMercadoriaForaAmazon(depois.pacotes), `${String(token)}+${status}`).toBe(
        false,
      );
    }
    // NEAR-MISS: the same later read over a row whose estado says the goods left.
    const coletado = dobrar([pacote('PKG-1', 'PICKED_UP')]);
    for (const [token, status] of leituras) {
      const depois = dobrar([pacote('PKG-1', token, { status })], {
        invoiceStatus: 'ACCEPTED',
        relogioUs: DEPOIS_US,
        armazenados: coletado.pacotes,
      });
      expect(depois.pacotes[0]?.estado, `${String(token)}+${status}`).toBe('postado');
      expect(diarioComMercadoriaForaAmazon(depois.pacotes), `${String(token)}+${status}`).toBe(
        true,
      );
    }
  });
});

describe('one read: lerFreteAmazon and alvoFreteAmazon', () => {
  it('the motivos come from the order alone: unknown/unkeyed ⇒ pacote-status-desconhecido; LABEL_CANCELLED ⇒ coleta-cancelada unless the order is CANCELLED', () => {
    const ler = (status: string, pacotes: Record<string, unknown>[]) =>
      lerFreteAmazon(pedidoAmazon({ status, pacotesBrutos: pacotes }), {
        relogioUs: RELOGIO_US,
        armazenados: undefined,
      });
    expect(ler('UNSHIPPED', [pacoteAmazon('A', 'NEW_TOKEN')]).motivos).toEqual([
      'pacote-status-desconhecido',
    ]);
    expect(ler('UNSHIPPED', [pacoteAmazon(undefined, 'DELIVERED')]).motivos).toEqual([
      'pacote-status-desconhecido',
    ]);
    expect(ler('UNSHIPPED', [pacoteAmazon('A', 'LABEL_CANCELLED')]).motivos).toEqual([
      'coleta-cancelada',
    ]);
    // An unkeyed LABEL_CANCELLED package is still a cancelled pickup.
    expect(ler('UNSHIPPED', [pacoteAmazon(undefined, 'LABEL_CANCELLED')]).motivos).toEqual([
      'pacote-status-desconhecido',
      'coleta-cancelada',
    ]);
    expect(ler('CANCELLED', [pacoteAmazon('A', 'LABEL_CANCELLED')]).motivos).toEqual([]);
    // pacote-status-desconhecido has NO CANCELLED exception: it resolves only
    // when every token is known and keyed.
    expect(ler('CANCELLED', [pacoteAmazon('A', 'NEW_TOKEN')]).motivos).toEqual([
      'pacote-status-desconhecido',
    ]);
    expect(ler('CANCELLED', [pacoteAmazon(undefined, 'DELIVERED')]).motivos).toEqual([
      'pacote-status-desconhecido',
    ]);
    // NEAR-MISS: every token known and keyed, no LABEL_CANCELLED ⇒ nothing.
    expect(
      ler('SHIPPED', [pacoteAmazon('A', 'PICKED_UP'), pacoteAmazon('B', 'DELIVERED')]).motivos,
    ).toEqual([]);
    expect(ler('UNSHIPPED', [pacoteAmazon('A', 'LABEL_CANCELED')]).motivos).toEqual([
      'pacote-status-desconhecido',
    ]);
  });

  it('without packages: no fold, the no-packages rule, no motivo', () => {
    const r = lerFreteAmazon(pedidoAmazon({ invoiceStatus: 'ACCEPTED' }), {
      relogioUs: RELOGIO_US,
      armazenados: undefined,
    });
    expect(r).toEqual({
      alvo: 'aguardandoAgendamento',
      dobra: null,
      mercadoriaFora: false,
      semNota: false,
      notaNaoExigida: false,
      motivos: [],
    });
    expect(
      lerFreteAmazon(pedidoAmazon({ pacotesBrutos: [] }), { relogioUs: 1, armazenados: [] }),
    ).toMatchObject({ alvo: null, dobra: null, semNota: true });
  });

  /** A stored pedido the predicate reads (governed `pago` unless the test says otherwise). */
  const contexto = (
    o: { estado?: EstadoPedido; mercadoriaFora?: boolean; pagamento?: 'ausente' | 'aprovado' } = {},
  ): ContextoEstadoAmazon => ({
    armazenado: {
      estado: o.estado ?? 'pago',
      error: null,
      marketplaceTipo: 'amazon',
      marketplaceStatus: 'UNSHIPPED',
      impresso: false,
      congelado: false,
      freteEstado: null,
    },
    pagamentoArmazenado: o.pagamento === 'aprovado' ? STATUS_PAGAMENTO.aprovado : 'ausente',
    mercadoriaFora: o.mercadoriaFora ?? false,
  });

  it('★ the CANCELLED rule is the predicate’s outcome: goods out ⇒ the read’s target; goods in ⇒ cancelado; any other status ⇒ the read’s target', () => {
    expect(
      alvoFreteAmazon({
        cancelado: true,
        contexto: contexto({ mercadoriaFora: true }),
        alvoDaLeitura: ESTADO_FRETE.postado,
      }),
    ).toBe('postado');
    expect(
      alvoFreteAmazon({
        cancelado: true,
        contexto: contexto({ mercadoriaFora: true }),
        alvoDaLeitura: null,
      }),
    ).toBeNull();
    for (const pagamento of ['ausente', 'aprovado'] as const) {
      expect(
        alvoFreteAmazon({
          cancelado: true,
          contexto: contexto({ pagamento }),
          alvoDaLeitura: ESTADO_FRETE.aguardandoPostagem,
        }),
        pagamento,
      ).toBe(ESTADO_FRETE.cancelado);
    }
    expect(
      alvoFreteAmazon({
        cancelado: false,
        contexto: contexto(),
        alvoDaLeitura: ESTADO_FRETE.aguardandoPostagem,
      }),
    ).toBe('aguardandoPostagem');
  });

  it('★ the predicate’s OTHER keep arm too: a stored estado the operator owns (finalizado, emProcessamento) keeps the freight, goods in or not', () => {
    for (const estado of ['finalizado', 'emProcessamento'] as const) {
      expect(
        alvoFreteAmazon({
          cancelado: true,
          contexto: contexto({ estado }),
          alvoDaLeitura: null,
        }),
        estado,
      ).toBeNull();
      expect(
        alvoFreteAmazon({
          cancelado: true,
          contexto: contexto({ estado }),
          alvoDaLeitura: ESTADO_FRETE.aguardandoPostagem,
        }),
        estado,
      ).toBe('aguardandoPostagem');
    }
  });
});

describe('the group against a block (grupoFreteAmazon) and the diary comparator', () => {
  const dobraDe = (pacotes: PacoteWireAmazon[], armazenados?: unknown) =>
    dobrar(pacotes, { armazenados, invoiceStatus: 'ACCEPTED' });

  it('an unchanged read ⇒ NO change (EQUAL); one diary field changed ⇒ the diary rewritten (NEAR-MISS)', () => {
    const d1 = dobraDe([pacote('A', 'PICKED_UP', { rastreio: 'TRK-1' })]);
    const bloco = { estado: 'postado', pacotes: d1.pacotes, codRastreio: 'TRK-1' };
    const igual = grupoFreteAmazon({
      bloco,
      alvo: ESTADO_FRETE.postado,
      dobra: dobraDe([pacote('A', 'PICKED_UP', { rastreio: 'TRK-1' })], d1.pacotes),
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(igual.mudancas).toEqual({});
    const outro = grupoFreteAmazon({
      bloco,
      alvo: ESTADO_FRETE.postado,
      dobra: dobraDe(
        [pacote('A', 'PICKED_UP', { rastreio: 'TRK-1', status: 'SHIPPED' })],
        d1.pacotes,
      ),
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(Object.keys(outro.mudancas)).toEqual(['pacotes']);
  });

  it('★ codRastreio REPLACES a stored value (logged divergent), fills a missing one (not divergent), and an empty fold keeps it', () => {
    const d = dobraDe([pacote('A', 'PICKED_UP', { rastreio: 'TRK-NOVO' })]);
    const troca = grupoFreteAmazon({
      bloco: { estado: 'postado', codRastreio: 'TRK-VELHO' },
      alvo: null,
      dobra: d,
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(troca.mudancas).toMatchObject({ codRastreio: 'TRK-NOVO' });
    expect(troca.codRastreioDivergente).toBe(true);
    const preenche = grupoFreteAmazon({
      bloco: { estado: 'postado', codRastreio: null },
      alvo: null,
      dobra: d,
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(preenche).toMatchObject({
      mudancas: { codRastreio: 'TRK-NOVO' },
      codRastreioDivergente: false,
    });
    const vazio = grupoFreteAmazon({
      bloco: { estado: 'postado', codRastreio: 'TRK-VELHO' },
      alvo: null,
      dobra: dobraDe([pacote('A', 'PICKED_UP')]),
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(Object.hasOwn(vazio.mudancas, 'codRastreio')).toBe(false);
    // NEAR-MISS: Amazon's value differing by a space alone is REPLACED, verbatim.
    const espaco = grupoFreteAmazon({
      bloco: { estado: 'postado', codRastreio: 'TRK-NOVO' },
      alvo: null,
      dobra: dobraDe([pacote('A', 'PICKED_UP', { rastreio: 'TRK-NOVO ' })]),
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(espaco).toMatchObject({
      mudancas: { codRastreio: 'TRK-NOVO ' },
      codRastreioDivergente: true,
    });
    // And the same value is no change.
    expect(
      grupoFreteAmazon({
        bloco: { estado: 'postado', codRastreio: 'TRK-NOVO' },
        alvo: null,
        dobra: d,
        maisNovo: false,
        logistica: 'mfn',
      }).mudancas,
    ).not.toHaveProperty('codRastreio');
    const semPacotes = grupoFreteAmazon({
      bloco: { estado: 'postado', codRastreio: 'TRK-VELHO', pacotes: d.pacotes },
      alvo: null,
      dobra: null,
      maisNovo: false,
      logistica: 'mfn',
    });
    expect(semPacotes.mudancas).toEqual({});
  });

  it('the estado goes through the verdict; an unreadable stored estado decides nothing', () => {
    expect(
      grupoFreteAmazon({
        bloco: { estado: 'iniciado' },
        alvo: ESTADO_FRETE.aguardandoNFe,
        dobra: null,
        maisNovo: false,
        logistica: 'mfn',
      }),
    ).toMatchObject({ mudancas: { estado: 'aguardandoNFe' } });
    expect(
      grupoFreteAmazon({
        bloco: { estado: 'checkFinalizado' },
        alvo: ESTADO_FRETE.aguardandoPostagem,
        dobra: null,
        maisNovo: true,
        logistica: 'mfn',
      }),
    ).toMatchObject({ mudancas: {}, veredito: { escrever: false, motivo: 'regressivo' } });
    expect(
      grupoFreteAmazon({
        bloco: { estado: 'nao-e-um-estado' },
        alvo: ESTADO_FRETE.postado,
        dobra: null,
        maisNovo: true,
        logistica: 'mfn',
      }),
    ).toEqual({ mudancas: {}, veredito: null, codRastreioDivergente: false });
  });

  it('★ the diary comparator is strict, row by row: absent ≢ null, a reordered diary differs, a different length differs', () => {
    const linha = { numero: 'A', estado: 'postado', codRastreio: null };
    expect(mesmoDiarioAmazon([{ ...linha }], [{ ...linha }])).toBe(true);
    expect(mesmoDiarioAmazon([{ numero: 'A', estado: 'postado' }], [linha])).toBe(false);
    expect(mesmoDiarioAmazon([{ ...linha, extra: 1 }], [linha])).toBe(false);
    expect(mesmoDiarioAmazon([{ ...linha, estado: 'aCaminho' }], [linha])).toBe(false);
    const b = { ...linha, numero: 'B' };
    expect(mesmoDiarioAmazon([b, linha], [linha, b])).toBe(false);
    expect(mesmoDiarioAmazon([linha], [linha, b])).toBe(false);
    expect(mesmoDiarioAmazon(undefined, [linha])).toBe(false);
    expect(mesmoDiarioAmazon(null, [])).toBe(false);
    expect(mesmoDiarioAmazon([], [])).toBe(true);
    // Strings compare as themselves: a space or a case is a difference (the fold's SCOPE).
    for (const campo of ['codRastreio', 'estadoMarketplace', 'statusMarketplace', 'numero']) {
      for (const quase of ['TRK-1 ', 'trk-1']) {
        expect(
          mesmoDiarioAmazon([{ ...linha, [campo]: 'TRK-1' }], [{ ...linha, [campo]: quase }]),
          `${campo} ${quase}`,
        ).toBe(false);
      }
    }
    // Numbers compare as themselves: 1 ≢ '1'.
    expect(
      mesmoDiarioAmazon([{ ...linha, atualizadoEm: 1 }], [{ ...linha, atualizadoEm: '1' }]),
    ).toBe(false);
  });
});

describe('purity', () => {
  it('reads no clock, no environment, no logger, and converts no instant', () => {
    const fonte = readFileSync(join(AQUI, 'estadoFreteAmazon.ts'), 'utf8');
    for (const proibido of [
      /Date\.now/,
      /new Date\(/,
      /process\s*\.\s*env/,
      /millisToMicros|coerceToMicros|agoraUsDe/,
      /registrarEventoAmazon|console\./,
      /firebase-admin/,
    ]) {
      expect(fonte, String(proibido)).not.toMatch(proibido);
    }
  });
});

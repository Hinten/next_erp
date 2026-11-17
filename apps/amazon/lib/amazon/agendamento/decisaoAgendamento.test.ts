/**
 * The Easy Ship scheduling's pure decisions (step 15, PR 15-b), over parsed
 * `getOrder` orders: the owner's C1 captures where one exists (sanitized,
 * `fixtures/__wire__/c1-*.json`), else synthetic UNSHIPPED variants of the
 * model's BR example (`sb-getorder-br.json`) built in test code. No Amazon call
 * (D11): only parses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  pedidoWireAmazonSchema,
  respostaAgendamentoEasyShipSchema,
  type PedidoWireAmazon,
  type RespostaAgendamentoEasyShip,
} from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_FRETE,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  motivoEtiquetaAmazonSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { ContaAmazonParadaError } from '../core/erros';
import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import { ESTADO_FRETE_A_AGENDAR_AMAZON, lerFreteAmazon } from '../frete/estadoFreteAmazon';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { pacoteAmazon } from '../testing/pedidoWireAmazon';
import {
  CODIGOS_NOVO_HORARIO_EASY_SHIP,
  CODIGOS_RETENTAVEIS_EASY_SHIP,
  CODIGO_FALHA_INTERNA_EASY_SHIP,
  type DecisaoAgendamentoAmazon,
  type GateNotasAgendamentoAmazon,
  type ResultadoBulkImpressaoAgendamentoAmazon,
  agendamentoEncerradoAmazon,
  decidirAgendamentoAmazon,
  desfechoImpressaoAgendamentoAmazon,
  gateNotasAgendamentoAmazon,
  gatesArmazenadosAgendamentoAmazon,
  lerRespostaAgendamentoAmazon,
  planoAgendamentoAmazon,
} from './decisaoAgendamento';

type Json = Record<string, unknown>;

/** A getOrder fixture's `order`, parsed by the package's own wire schema (a fresh copy). */
function pedidoDoFixture(nome: string): PedidoWireAmazon {
  const leitura = lerFixtureAmazon(readFileSync(join(DIRETORIO_WIRE_AMAZON, nome), 'utf8'));
  if (!leitura.ok) throw new Error(`${nome} não é um envelope válido`);
  const order = (leitura.data.resposta.corpo as { order: Json }).order;
  return pedidoWireAmazonSchema.parse(structuredClone(order));
}

/**
 * The model's BR example (UNSHIPPED, MERCHANT) as a Delivery-by-Amazon order,
 * with `packages` and the order-level invoice status set (`null` = absent).
 */
function variante(
  packages: readonly Json[] | null,
  invoiceStatus: string | null = 'ACCEPTED',
  status = 'UNSHIPPED',
  ajustar: (corpo: Json) => void = () => undefined,
): PedidoWireAmazon {
  const base = pedidoDoFixture('sb-getorder-br.json') as unknown as Json;
  const corpo: Json = {
    ...base,
    programs: ['DELIVERY_BY_AMAZON'],
    fulfillment: { ...(base.fulfillment as Json), fulfillmentStatus: status },
  };
  if (packages === null) delete corpo.packages;
  else corpo.packages = packages;
  if (invoiceStatus === null) delete corpo.tax;
  else corpo.tax = { ...(base.tax as Json | undefined), taxInvoicing: { invoiceStatus } };
  ajustar(corpo);
  return pedidoWireAmazonSchema.parse(corpo);
}

const pacote = (detalhe: string, status = 'PENDING') => pacoteAmazon('PKG-1', detalhe, { status });

describe('agendamentoEncerradoAmazon — when the import may resolve the two scheduling motivos', () => {
  it.each<[string, () => PedidoWireAmazon, boolean]>([
    [
      'c1-cancelado-depois (CANCELLED, LABEL_CANCELLED, ACCEPTED kept)',
      () => pedidoDoFixture('c1-cancelado-depois.json'),
      true,
    ],
    [
      'c1-dba-e-transito (SHIPPED, PICKED_UP)',
      () => pedidoDoFixture('c1-dba-e-transito.json'),
      true,
    ],
    [
      'c1-dba-f-entregue (SHIPPED, DELIVERED)',
      () => pedidoDoFixture('c1-dba-f-entregue.json'),
      true,
    ],
    ['c1-devolvido (SHIPPED, the reverse leg)', () => pedidoDoFixture('c1-devolvido.json'), true],
    ['c1-pendente (PENDING, no packages)', () => pedidoDoFixture('c1-pendente.json'), false],
  ])('★ %s ⇒ %s', (_nome, order, encerrado) => {
    expect(agendamentoEncerradoAmazon(order())).toBe(encerrado);
  });

  it('★ scheduled or later ⇒ ended: PENDING_PICK_UP, PENDING_DROP_OFF, PICKED_UP, DROPPED_OFF, DELIVERED', () => {
    for (const detalhe of ['PENDING_PICK_UP', 'PENDING_DROP_OFF']) {
      const order = variante([pacote(detalhe)]);
      // One source: the fold itself reads it as scheduled.
      expect(lerFreteAmazon(order, { relogioUs: 0, armazenados: null }).alvo, detalhe).toBe(
        'aguardandoPostagem',
      );
      expect(agendamentoEncerradoAmazon(order), detalhe).toBe(true);
    }
    for (const detalhe of ['PICKED_UP', 'DROPPED_OFF', 'DELIVERED']) {
      expect(agendamentoEncerradoAmazon(variante([pacote(detalhe, 'IN_TRANSIT')])), detalhe).toBe(
        true,
      );
    }
  });

  it('★ LABEL_CANCELLED ⇒ ended (a schedule existed; rescheduling stays in Seller Central)', () => {
    expect(agendamentoEncerradoAmazon(variante([pacote('LABEL_CANCELLED')]))).toBe(true);
  });

  it('★ NEAR-MISS: still to schedule ⇒ NOT ended — PENDING_SCHEDULE whatever the invoice status, no packages, a mixed set waiting', () => {
    for (const nota of ['ACCEPTED', 'PROCESSING', 'NOT_FOUND', 'ERRORED', 'NOT_REQUIRED', null]) {
      expect(
        agendamentoEncerradoAmazon(variante([pacote('PENDING_SCHEDULE')], nota)),
        String(nota),
      ).toBe(false);
      expect(agendamentoEncerradoAmazon(variante(null, nota)), `sem pacotes ${String(nota)}`).toBe(
        false,
      );
    }
    // The least-advanced package decides, as the fold's target does.
    expect(
      agendamentoEncerradoAmazon(
        variante([
          pacoteAmazon('PKG-1', 'PENDING_SCHEDULE', { status: 'PENDING' }),
          pacoteAmazon('PKG-2', 'PENDING_PICK_UP', { status: 'PENDING' }),
        ]),
      ),
    ).toBe(false);
  });

  it('an unknown token: NOT ended while its closed status says it waits; ended once that status says it left (the goods-out fallback)', () => {
    expect(agendamentoEncerradoAmazon(variante([pacote('NEW_TOKEN', 'PENDING')]))).toBe(false);
    expect(agendamentoEncerradoAmazon(variante([pacote('NEW_TOKEN', 'IN_TRANSIT')]))).toBe(true);
  });

  it('the phase alone ends it: SHIPPED or CANCELLED without packages; PARTIALLY_SHIPPED, UNFULFILLABLE or an unknown status without packages does not', () => {
    expect(agendamentoEncerradoAmazon(variante(null, 'ACCEPTED', 'SHIPPED'))).toBe(true);
    expect(agendamentoEncerradoAmazon(variante(null, 'ACCEPTED', 'CANCELLED'))).toBe(true);
    for (const status of ['PARTIALLY_SHIPPED', 'UNFULFILLABLE', 'SHIPPED_SOMEHOW']) {
      expect(agendamentoEncerradoAmazon(variante(null, 'ACCEPTED', status)), status).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       the live order (decidirAgendamentoAmazon)             */
/* -------------------------------------------------------------------------- */

/** A read of `order`, as `lerPedidoAmazon` answers one. */
const lido = (order: PedidoWireAmazon) =>
  ({ tipo: 'lido', order, watermarkUs: 1, defasadaAceita: false }) as const;

const decidir = (order: PedidoWireAmazon) => decidirAgendamentoAmazon(lido(order));

/** One package, by its `detailedStatus` (its closed status `PENDING`). */
const pendente = (detalhe: string) => [pacote(detalhe)];

/** Every `agendar` asserts the fold's own target too: one source (§3 decision 4). */
function esperaAgendar(order: PedidoWireAmazon): void {
  expect(decidir(order)).toMatchObject({ acao: 'agendar', motivo: null });
  expect(lerFreteAmazon(order, { relogioUs: 1, armazenados: null }).alvo).toBe(
    ESTADO_FRETE_A_AGENDAR_AMAZON,
  );
}

describe('decidirAgendamentoAmazon — one row per decision', () => {
  it('★ c1-cancelado-depois ⇒ pedido-cancelado (ACCEPTED survives a cancellation; NEAR-MISS: never agendar)', () => {
    const d = decidir(pedidoDoFixture('c1-cancelado-depois.json'));
    expect(d).toEqual({
      acao: 'recusar',
      motivo: 'pedido-cancelado',
      fase: 'CANCELLED',
      invoiceStatus: 'ACCEPTED',
    });
  });

  it('★ c1-pendente ⇒ pedido-pendente', () => {
    expect(decidir(pedidoDoFixture('c1-pendente.json'))).toMatchObject({
      acao: 'recusar',
      motivo: 'pedido-pendente',
    });
  });

  it('★ c1-dba-e-transito ⇒ ja-enviado', () => {
    expect(decidir(pedidoDoFixture('c1-dba-e-transito.json'))).toMatchObject({
      acao: 'recusar',
      motivo: 'ja-enviado',
    });
  });

  it('★ PENDING_SCHEDULE + ACCEPTED ⇒ agendar, and the fold reads aguardandoAgendamento', () => {
    esperaAgendar(variante(pendente('PENDING_SCHEDULE')));
    expect(decidir(variante(pendente('PENDING_SCHEDULE')))).toEqual({
      acao: 'agendar',
      motivo: null,
      fase: 'UNSHIPPED',
      invoiceStatus: 'ACCEPTED',
    });
  });

  it('★ no packages + ACCEPTED ⇒ agendar, and the fold reads aguardandoAgendamento', () => {
    esperaAgendar(variante(null));
    esperaAgendar(variante([]));
  });

  it('★ mutation 2: PENDING_SCHEDULE + NOT_REQUIRED ⇒ nf-nao-requerida (NEAR-MISS: the same order with ACCEPTED schedules)', () => {
    expect(decidir(variante(pendente('PENDING_SCHEDULE'), 'NOT_REQUIRED'))).toMatchObject({
      acao: 'recusar',
      motivo: 'nf-nao-requerida',
      invoiceStatus: 'NOT_REQUIRED',
    });
    expect(decidir(variante(null, 'NOT_REQUIRED'))).toMatchObject({ motivo: 'nf-nao-requerida' });
    esperaAgendar(variante(pendente('PENDING_SCHEDULE'), 'ACCEPTED'));
  });

  it('★ PENDING_SCHEDULE + PROCESSING ⇒ aceite-pendente; the motivo follows the order-level invoice status', () => {
    expect(decidir(variante(pendente('PENDING_SCHEDULE'), 'PROCESSING'))).toEqual({
      acao: 'aceite-pendente',
      motivo: 'nfe-em-processamento',
      fase: 'UNSHIPPED',
      invoiceStatus: 'PROCESSING',
    });
    expect(decidir(variante(pendente('PENDING_SCHEDULE'), 'ERRORED'))).toMatchObject({
      acao: 'aceite-pendente',
      motivo: 'nfe-recusada-pela-amazon',
    });
    expect(decidir(variante(pendente('PENDING_SCHEDULE'), 'NOT_FOUND'))).toMatchObject({
      acao: 'aceite-pendente',
      motivo: 'nfe-nao-enviada',
    });
    // Absent, or a near-spelling: no usable status — still processing, never agendar.
    for (const nota of [null, 'accepted', 'ACCEPTED ']) {
      expect(decidir(variante(pendente('PENDING_SCHEDULE'), nota)), String(nota)).toMatchObject({
        acao: 'aceite-pendente',
        motivo: 'nfe-em-processamento',
        invoiceStatus: '<outro>',
      });
    }
  });

  it('★ PENDING_PICK_UP and PENDING_DROP_OFF ⇒ ja-agendado', () => {
    for (const detalhe of ['PENDING_PICK_UP', 'PENDING_DROP_OFF']) {
      expect(decidir(variante(pendente(detalhe))), detalhe).toEqual({
        acao: 'ja-agendado',
        motivo: null,
        fase: 'UNSHIPPED',
        invoiceStatus: 'ACCEPTED',
      });
    }
  });

  it('★ mutation 4: LABEL_CANCELLED ⇒ coleta-cancelada — never a reschedule', () => {
    expect(decidir(variante(pendente('LABEL_CANCELLED')))).toMatchObject({
      acao: 'recusar',
      motivo: 'coleta-cancelada',
    });
    // Beside a package still to schedule, too.
    expect(
      decidir(variante([pacote('LABEL_CANCELLED'), pacoteAmazon('PKG-2', 'PENDING_SCHEDULE')])),
    ).toMatchObject({ acao: 'recusar', motivo: 'coleta-cancelada' });
  });

  it('★ PICKED_UP on an UNSHIPPED order ⇒ ja-enviado (the goods are out)', () => {
    expect(decidir(variante([pacote('PICKED_UP', 'IN_TRANSIT')]))).toMatchObject({
      acao: 'recusar',
      motivo: 'ja-enviado',
    });
  });

  it('★ an unknown token, or a package without a reference ⇒ pacote-desconhecido', () => {
    expect(decidir(variante(pendente('NEW_TOKEN')))).toMatchObject({
      acao: 'recusar',
      motivo: 'pacote-desconhecido',
    });
    expect(decidir(variante([pacoteAmazon(undefined, 'PENDING_SCHEDULE')]))).toMatchObject({
      motivo: 'pacote-desconhecido',
    });
  });

  it('★ mutation 3: PARTIALLY_SHIPPED ⇒ status-pedido-inesperado — so do UNFULFILLABLE, an unknown and an absent status', () => {
    expect(
      decidir(variante(pendente('PENDING_SCHEDULE'), 'ACCEPTED', 'PARTIALLY_SHIPPED')),
    ).toEqual({
      acao: 'recusar',
      motivo: 'status-pedido-inesperado',
      fase: 'PARTIALLY_SHIPPED',
      invoiceStatus: 'ACCEPTED',
    });
    for (const status of ['UNFULFILLABLE', 'SHIPPED_SOMEHOW']) {
      expect(decidir(variante(null, 'ACCEPTED', status)), status).toMatchObject({
        motivo: 'status-pedido-inesperado',
      });
    }
    expect(
      decidir(
        variante(null, 'ACCEPTED', 'UNSHIPPED', (c) => {
          c.fulfillment = { ...(c.fulfillment as Json), fulfillmentStatus: undefined };
        }),
      ),
    ).toMatchObject({ motivo: 'status-pedido-inesperado', fase: '<outro>' });
  });

  it('★ mutation 5: an OPEN cancellation request with ACCEPTED ⇒ cancelamento-solicitado; NEAR-MISS: a request its own execution closed does not', () => {
    const comCancelamento = (cancellation: Json) =>
      variante(pendente('PENDING_SCHEDULE'), 'ACCEPTED', 'UNSHIPPED', (c) => {
        const itens = c.orderItems as Json[];
        c.orderItems = itens.map((item, i) => (i === 0 ? { ...item, cancellation } : item));
      });
    expect(decidir(comCancelamento({ cancellationRequest: { requester: 'BUYER' } }))).toMatchObject(
      { acao: 'recusar', motivo: 'cancelamento-solicitado' },
    );
    // A closed request on an UNSHIPPED order is a partial cancellation: it schedules.
    esperaAgendar(
      comCancelamento({
        cancellationRequest: { requester: 'BUYER' },
        cancellationExecution: { cancelledBy: 'BUYER' },
      }),
    );
  });

  it('★ mutation 6: NEAR-MISSES on DBA — programs AMAZON_EASY_SHIP, fulfilledBy AMAZON, no programs ⇒ nao-dba', () => {
    const casos: [string, (c: Json) => void][] = [
      ['AMAZON_EASY_SHIP', (c) => (c.programs = ['AMAZON_EASY_SHIP'])],
      [
        'fulfilledBy AMAZON',
        (c) => (c.fulfillment = { ...(c.fulfillment as Json), fulfilledBy: 'AMAZON' }),
      ],
      ['no programs', (c) => delete c.programs],
    ];
    for (const [nome, ajustar] of casos) {
      expect(
        decidir(variante(pendente('PENDING_SCHEDULE'), 'ACCEPTED', 'UNSHIPPED', ajustar)),
        nome,
      ).toMatchObject({ acao: 'recusar', motivo: 'nao-dba' });
    }
  });

  it('a mixed package set follows the fold: PENDING_SCHEDULE beside PENDING_PICK_UP ⇒ agendar', () => {
    esperaAgendar(
      variante([
        pacoteAmazon('PKG-1', 'PENDING_SCHEDULE', { status: 'PENDING' }),
        pacoteAmazon('PKG-2', 'PENDING_PICK_UP', { status: 'PENDING' }),
      ]),
    );
  });

  it('a foreign marketplace ⇒ marketplace-estrangeiro, with no order tokens to read', () => {
    expect(decidirAgendamentoAmazon({ tipo: 'marketplace-estrangeiro' })).toEqual({
      acao: 'recusar',
      motivo: 'marketplace-estrangeiro',
      fase: '<outro>',
      invoiceStatus: '<outro>',
    });
  });

  it('the rows are ordered: a cancelled non-DBA order is pedido-cancelado; a non-DBA order with an open request is cancelamento-solicitado; a non-DBA SHIPPED order is nao-dba', () => {
    expect(
      decidir(
        variante(null, 'ACCEPTED', 'CANCELLED', (c) => {
          c.programs = ['PRIME'];
        }),
      ),
    ).toMatchObject({ motivo: 'pedido-cancelado' });
    // Row 3 before row 4: the open request is named even on an order that is not DBA.
    expect(
      decidir(
        variante(pendente('PENDING_SCHEDULE'), 'ACCEPTED', 'UNSHIPPED', (c) => {
          c.programs = ['PRIME'];
          const itens = c.orderItems as Json[];
          c.orderItems = itens.map((item, i) =>
            i === 0
              ? { ...item, cancellation: { cancellationRequest: { requester: 'BUYER' } } }
              : item,
          );
        }),
      ),
    ).toMatchObject({ motivo: 'cancelamento-solicitado' });
    expect(
      decidir(
        variante(null, 'ACCEPTED', 'SHIPPED', (c) => {
          c.programs = ['PRIME'];
        }),
      ),
    ).toMatchObject({ motivo: 'nao-dba' });
  });

  it('every refusal motivo is a member of the closed label slugs', () => {
    const ordens = [
      pedidoDoFixture('c1-cancelado-depois.json'),
      pedidoDoFixture('c1-pendente.json'),
      pedidoDoFixture('c1-dba-e-transito.json'),
      variante(pendente('LABEL_CANCELLED')),
      variante(pendente('NEW_TOKEN')),
      variante(pendente('PENDING_SCHEDULE'), 'NOT_REQUIRED'),
      variante(pendente('PENDING_SCHEDULE'), 'ERRORED'),
    ];
    for (const o of ordens) {
      const { motivo } = decidir(o);
      expect(motivoEtiquetaAmazonSchema.safeParse(motivo).success, String(motivo)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                     the stored pedido (gatesArmazenados…)                   */
/* -------------------------------------------------------------------------- */

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);

/** A raw pedido the importer wrote: proved, paid, its freight `amz`. */
function pedidoRaw(extra: Json = {}, frete: Json | null = {}): Json {
  const raw: Json = {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
  };
  if (frete !== null) {
    raw.freteInicial = {
      externalOptionIntegracao: INTEGRACAO_FRETE.amazon,
      estado: ESTADO_FRETE.aguardandoAgendamento,
      ...frete,
    };
  }
  return { ...raw, ...extra };
}

const gates = (raw: Json | null) => gatesArmazenadosAgendamentoAmazon(PEDIDO_ID, raw);

describe('gatesArmazenadosAgendamentoAmazon — the stored pedido', () => {
  it('a proved Amazon pedido goes on, with its conta and order', () => {
    expect(gates(pedidoRaw())).toEqual({ segue: true, contaId: CONTA, orderId: ORDER });
  });

  it('★ mutations 14 and 15: stored checkFinalizado, aguardandoPostagem and the NF-e step’s error stamp all pass (NEAR-MISS: postado ⇒ mercadoria-fora)', () => {
    for (const estado of [
      ESTADO_FRETE.checkFinalizado,
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.error,
      ESTADO_FRETE.aguardandoNFe,
    ]) {
      expect(gates(pedidoRaw({}, { estado })), estado).toMatchObject({ segue: true });
    }
    expect(gates(pedidoRaw({}, { estado: ESTADO_FRETE.postado }))).toEqual({
      segue: false,
      motivo: 'mercadoria-fora',
    });
    expect(gates(pedidoRaw({}, { estado: ESTADO_FRETE.entregue }))).toMatchObject({
      motivo: 'mercadoria-fora',
    });
  });

  it('★ mutation 19: a block of another integradora ⇒ outra-integradora; a block WITHOUT externalOptionIntegracao too (NEAR-MISS: amz passes; no block passes)', () => {
    expect(
      gates(pedidoRaw({}, { externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios })),
    ).toEqual({ segue: false, motivo: 'outra-integradora' });
    const semIntegradora = pedidoRaw();
    delete (semIntegradora.freteInicial as Json).externalOptionIntegracao;
    expect(gates(semIntegradora)).toEqual({ segue: false, motivo: 'outra-integradora' });
    expect(gates(pedidoRaw({}, { externalOptionIntegracao: 'amz' }))).toMatchObject({
      segue: true,
    });
    expect(gates(pedidoRaw({}, null))).toMatchObject({ segue: true });
    expect(gates(pedidoRaw({ freteInicial: null }, null))).toMatchObject({ segue: true });
  });

  it('★ a cancelled sale ⇒ pedido-cancelado (both terminal estados)', () => {
    for (const estado of [ESTADO_PEDIDO.cancelado, ESTADO_PEDIDO.estornadoIntegralmente]) {
      expect(gates(pedidoRaw({ estado })), estado).toEqual({
        segue: false,
        motivo: 'pedido-cancelado',
      });
    }
  });

  it('★ the pedido held at error ⇒ pedido-bloqueado', () => {
    expect(gates(pedidoRaw({ estado: ESTADO_PEDIDO.error }))).toEqual({
      segue: false,
      motivo: 'pedido-bloqueado',
    });
  });

  it('not proved ⇒ nao-amazon: absent, another pedido id, another conta', () => {
    expect(gates(null)).toEqual({ segue: false, motivo: 'nao-amazon' });
    expect(gatesArmazenadosAgendamentoAmazon('0'.repeat(64), pedidoRaw())).toEqual({
      segue: false,
      motivo: 'nao-amazon',
    });
    expect(
      gates(pedidoRaw({ integracaoPedidoOuterRef: 'documents/integracao/outra' })),
    ).toMatchObject({ motivo: 'nao-amazon' });
  });

  it('the gates are ordered: a foreign block beats a cancelled sale; a cancelled sale and the error hold each beat goods out', () => {
    expect(
      gates(
        pedidoRaw(
          { estado: ESTADO_PEDIDO.cancelado },
          { externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios },
        ),
      ),
    ).toMatchObject({ motivo: 'outra-integradora' });
    expect(
      gates(pedidoRaw({ estado: ESTADO_PEDIDO.cancelado }, { estado: ESTADO_FRETE.postado })),
    ).toMatchObject({ motivo: 'pedido-cancelado' });
    expect(
      gates(pedidoRaw({ estado: ESTADO_PEDIDO.error }, { estado: ESTADO_FRETE.postado })),
    ).toMatchObject({ motivo: 'pedido-bloqueado' });
  });
});

/* -------------------------------------------------------------------------- */
/*                         the pedido's NF-e documents                         */
/* -------------------------------------------------------------------------- */

/** A synthetic proc: `finNFe` and `tpAmb` (production by default); no real party. */
function proc(finNFe = '1', tpAmb = '1'): string {
  return (
    `<nfeProc><NFe><infNFe><ide><tpAmb>${tpAmb}</tpAmb><tpNF>1</tpNF>` +
    `<finNFe>${finNFe}</finNFe></ide></infNFe></NFe></nfeProc>`
  );
}

const aprovada = () => ({ raw: { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc() } });
const vendaCancelada = () => ({ raw: { estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc() } });
const devolucaoCancelada = () => ({
  raw: { estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('4') },
});

describe('gateNotasAgendamentoAmazon — the NF-e documents (§3 decision 27)', () => {
  it('★ two aprovada sale notes ⇒ nfe-ambigua', () => {
    expect(gateNotasAgendamentoAmazon([aprovada(), aprovada()])).toEqual({
      segue: false,
      motivo: 'nfe-ambigua',
    });
  });

  it('★ one aprovada beside a cancelled sale note ⇒ nfe-substituta; only a cancelled sale note ⇒ nfe-cancelada', () => {
    expect(gateNotasAgendamentoAmazon([aprovada(), vendaCancelada()])).toEqual({
      segue: false,
      motivo: 'nfe-substituta',
    });
    expect(gateNotasAgendamentoAmazon([vendaCancelada()])).toEqual({
      segue: false,
      motivo: 'nfe-cancelada',
    });
  });

  it('★ one aprovada ⇒ goes on; no nfev4 at all (a hand upload) ⇒ goes on', () => {
    expect(gateNotasAgendamentoAmazon([aprovada()])).toEqual({ segue: true });
    expect(gateNotasAgendamentoAmazon([])).toEqual({ segue: true });
  });

  it('★ NEAR-MISS: a cancelled DEVOLUÇÃO beside one aprovada note goes on', () => {
    expect(gateNotasAgendamentoAmazon([aprovada(), devolucaoCancelada()])).toEqual({
      segue: true,
    });
  });

  it('★ NEAR-MISS: an aprovada document that is NOT an eligible sale note is not counted — a devolução, a homologação proc, no proc at all — so one sale note beside it goes on', () => {
    const naoElegiveis: [string, { raw: Json }][] = [
      ['an aprovada devolução', { raw: { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc('4') } }],
      [
        'an aprovada homologação proc',
        { raw: { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc('1', '2') } },
      ],
      ['an aprovada document without its proc', { raw: { estado: ESTADO_NFE.aprovada } }],
    ];
    for (const [nome, doc] of naoElegiveis) {
      expect(gateNotasAgendamentoAmazon([aprovada(), doc]), nome).toEqual({ segue: true });
    }
  });

  it('two eligible notes win over a cancelled one (first match)', () => {
    expect(gateNotasAgendamentoAmazon([aprovada(), aprovada(), vendaCancelada()])).toMatchObject({
      motivo: 'nfe-ambigua',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                        Amazon's answer (lerResposta…)                       */
/* -------------------------------------------------------------------------- */

/** The bulk 200 the model gives (`sb-bulk-200.json`), parsed by the package's schema. */
function bulk200(): RespostaAgendamentoEasyShip {
  const leitura = lerFixtureAmazon(
    readFileSync(join(DIRETORIO_WIRE_AMAZON, 'sb-bulk-200.json'), 'utf8'),
  );
  if (!leitura.ok) throw new Error('sb-bulk-200.json não é um envelope válido');
  return respostaAgendamentoEasyShipSchema.parse(structuredClone(leitura.data.resposta.corpo));
}

const URL_DOC = 'https://example-bucket.s3.amazonaws.com/x.zip?X-Amz-Signature=0000';

/** A 2xx answer: our order rejected with `error`, and/or scheduled. */
function resposta(o: {
  rejeitado?: Json | null;
  agendado?: boolean;
  outro?: boolean;
  url?: string | null;
}): RespostaAgendamentoEasyShip {
  const corpo: Json = {};
  if (o.rejeitado !== undefined) {
    corpo.rejectedOrders = [
      ...(o.outro === true
        ? [{ amazonOrderId: '000-0000000-0000001', error: { code: 'InvalidInput' } }]
        : []),
      o.rejeitado === null
        ? { amazonOrderId: ORDER }
        : { amazonOrderId: ORDER, error: o.rejeitado },
    ];
  } else if (o.outro === true) {
    corpo.rejectedOrders = [
      { amazonOrderId: '000-0000000-0000001', error: { code: 'InvalidInput' } },
    ];
  }
  if (o.agendado === true) {
    corpo.scheduledPackages = [
      { scheduledPackageId: { amazonOrderId: ORDER, packageId: 'PKG-TESTE-1' } },
    ];
  }
  if (o.url !== undefined && o.url !== null) corpo.printableDocumentsUrl = o.url;
  return respostaAgendamentoEasyShipSchema.parse(corpo);
}

const rejeitado = (code: string, url: string | null = URL_DOC) =>
  resposta({ rejeitado: { code, message: 'texto da Amazon' }, url });

describe('lerRespostaAgendamentoAmazon — rejectedOrders FIRST (§3 decision 10)', () => {
  it('★ sb-bulk-200: each scheduled order ⇒ agendado; the rejected one ⇒ recusado InvalidInput', () => {
    const dados = bulk200();
    for (const orderId of ['000-0000000-8397448', '000-0000000-2877936']) {
      expect(lerRespostaAgendamentoAmazon(dados, orderId)).toEqual({
        tipo: 'agendado',
        codigo: null,
        url: 'https://redacted.invalid/',
        pacotes: 1,
      });
    }
    expect(lerRespostaAgendamentoAmazon(dados, '000-0000000-6040666')).toMatchObject({
      tipo: 'recusado',
      codigo: 'InvalidInput',
      pacotes: 0,
    });
  });

  it('★ mutation 8: our order rejected with ScheduledPackageAlreadyExists, a URL present ⇒ ja-agendado with the URL', () => {
    expect(lerRespostaAgendamentoAmazon(rejeitado('ScheduledPackageAlreadyExists'), ORDER)).toEqual(
      { tipo: 'ja-agendado', codigo: 'ScheduledPackageAlreadyExists', url: URL_DOC, pacotes: 0 },
    );
  });

  it('★ mutation 18: InternalServerError, RetryableAfterGettingNewSlots and ScheduleWindowExpired ⇒ transitorio with the code (NEAR-MISS: InvalidTimeSlotId ⇒ recusado)', () => {
    for (const code of [
      'InternalServerError',
      'RetryableAfterGettingNewSlots',
      'ScheduleWindowExpired',
    ]) {
      expect(lerRespostaAgendamentoAmazon(rejeitado(code), ORDER), code).toMatchObject({
        tipo: 'transitorio',
        codigo: code,
      });
    }
    expect(lerRespostaAgendamentoAmazon(rejeitado('InvalidTimeSlotId'), ORDER)).toMatchObject({
      tipo: 'recusado',
      codigo: 'InvalidTimeSlotId',
    });
    expect(lerRespostaAgendamentoAmazon(rejeitado('internalServerError'), ORDER).tipo).toBe(
      'recusado',
    );
  });

  it('the retryable set is EXACTLY the outage plus the two slot codes', () => {
    expect(CODIGO_FALHA_INTERNA_EASY_SHIP).toBe('InternalServerError');
    expect([...CODIGOS_NOVO_HORARIO_EASY_SHIP].sort()).toEqual(
      ['RetryableAfterGettingNewSlots', 'ScheduleWindowExpired'].sort(),
    );
    expect([...CODIGOS_RETENTAVEIS_EASY_SHIP].sort()).toEqual(
      ['InternalServerError', 'RetryableAfterGettingNewSlots', 'ScheduleWindowExpired'].sort(),
    );
  });

  it('★ mutations 7 and 9: our order in BOTH lists (InvalidOrderState) ⇒ recusado — rejectedOrders is read first', () => {
    const dados = resposta({ rejeitado: { code: 'InvalidOrderState' }, agendado: true });
    expect(lerRespostaAgendamentoAmazon(dados, ORDER)).toMatchObject({
      tipo: 'recusado',
      codigo: 'InvalidOrderState',
      pacotes: 1,
    });
  });

  it('★ our order rejected with NO error object ⇒ recusado, codigo null', () => {
    expect(lerRespostaAgendamentoAmazon(resposta({ rejeitado: null }), ORDER)).toEqual({
      tipo: 'recusado',
      codigo: null,
      url: null,
      pacotes: 0,
    });
  });

  it('★ TimeSlotNotAvailable and MissingPackageDimensions ⇒ recusado with that code', () => {
    for (const code of ['TimeSlotNotAvailable', 'MissingPackageDimensions']) {
      expect(lerRespostaAgendamentoAmazon(rejeitado(code), ORDER), code).toMatchObject({
        tipo: 'recusado',
        codigo: code,
      });
    }
  });

  it('★ another order’s rejection only, ours absent ⇒ sem-pedido', () => {
    expect(lerRespostaAgendamentoAmazon(resposta({ outro: true }), ORDER)).toMatchObject({
      tipo: 'sem-pedido',
      codigo: null,
    });
  });

  it('NEAR-MISS: other orders SCHEDULED (and another rejected), ours named nowhere ⇒ sem-pedido, zero packages — a scheduled entry counts only when it names OUR order', () => {
    // sb-bulk-200 schedules two orders and rejects a third; ours is none of them.
    expect(lerRespostaAgendamentoAmazon(bulk200(), ORDER)).toEqual({
      tipo: 'sem-pedido',
      codigo: null,
      url: 'https://redacted.invalid/',
      pacotes: 0,
    });
    const soOutroAgendado = respostaAgendamentoEasyShipSchema.parse({
      scheduledPackages: [
        { scheduledPackageId: { amazonOrderId: '000-0000000-0000001', packageId: 'PKG-OUTRO' } },
      ],
    });
    expect(lerRespostaAgendamentoAmazon(soOutroAgendado, ORDER)).toMatchObject({
      tipo: 'sem-pedido',
      pacotes: 0,
    });
  });

  it('★ a code outside the grammar (`Missing Package!`) ⇒ <outro>', () => {
    expect(lerRespostaAgendamentoAmazon(rejeitado('Missing Package!'), ORDER)).toMatchObject({
      tipo: 'recusado',
      codigo: '<outro>',
    });
  });

  it('NEAR-MISS: the grammar refuses a code with a space, a hyphen, a leading digit or 65 characters — each ⇒ <outro>; its edge (64) passes', () => {
    for (const code of [
      'Missing Package',
      'Invalid-Input',
      '9InvalidInput',
      `A${'b'.repeat(64)}`,
    ]) {
      expect(lerRespostaAgendamentoAmazon(rejeitado(code), ORDER), code).toMatchObject({
        tipo: 'recusado',
        codigo: '<outro>',
      });
    }
    const borda = `A${'b'.repeat(63)}`;
    expect(lerRespostaAgendamentoAmazon(rejeitado(borda), ORDER).codigo).toBe(borda);
  });

  it('★ an empty 2xx (null) ⇒ sem-pedido; `{}` ⇒ sem-pedido', () => {
    expect(lerRespostaAgendamentoAmazon(null, ORDER)).toEqual({
      tipo: 'sem-pedido',
      codigo: null,
      url: null,
      pacotes: 0,
    });
    expect(lerRespostaAgendamentoAmazon(resposta({}), ORDER).tipo).toBe('sem-pedido');
  });

  it('a scheduled answer without a URL keeps url null; an empty URL reads as none', () => {
    expect(lerRespostaAgendamentoAmazon(resposta({ agendado: true }), ORDER)).toEqual({
      tipo: 'agendado',
      codigo: null,
      url: null,
      pacotes: 1,
    });
    expect(lerRespostaAgendamentoAmazon(resposta({ agendado: true, url: '' }), ORDER).url).toBe(
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the plans                                  */
/* -------------------------------------------------------------------------- */

const SEGUE: GateNotasAgendamentoAmazon = { segue: true };
const AMBIGUA: GateNotasAgendamentoAmazon = { segue: false, motivo: 'nfe-ambigua' };

const decisao = (acao: DecisaoAgendamentoAmazon['acao']): DecisaoAgendamentoAmazon => {
  switch (acao) {
    case 'agendar':
      return decidir(variante(pendente('PENDING_SCHEDULE')));
    case 'ja-agendado':
      return decidir(variante(pendente('PENDING_PICK_UP')));
    case 'aceite-pendente':
      return decidir(variante(pendente('PENDING_SCHEDULE'), 'PROCESSING'));
    case 'recusar':
      return decidir(variante(pendente('LABEL_CANCELLED')));
  }
};

describe('planoAgendamentoAmazon — the plans', () => {
  it('the fixtures behind the plans decide what they are named', () => {
    for (const acao of ['agendar', 'ja-agendado', 'aceite-pendente', 'recusar'] as const) {
      expect(decisao(acao).acao).toBe(acao);
    }
  });

  it('★ tarefa + ja-agendado ⇒ no write; impressao + ja-agendado ⇒ write; impressao + agendar without podeAgendar ⇒ no write', () => {
    expect(
      planoAgendamentoAmazon(decisao('ja-agendado'), 'tarefa', true, SEGUE, false).escrever,
    ).toBe(false);
    expect(
      planoAgendamentoAmazon(decisao('ja-agendado'), 'impressao', false, SEGUE, false).escrever,
    ).toBe(true);
    expect(
      planoAgendamentoAmazon(decisao('agendar'), 'impressao', false, SEGUE, false).escrever,
    ).toBe(false);
    expect(
      planoAgendamentoAmazon(decisao('agendar'), 'impressao', true, SEGUE, false).escrever,
    ).toBe(true);
    expect(planoAgendamentoAmazon(decisao('agendar'), 'tarefa', false, SEGUE, false).escrever).toBe(
      true,
    );
  });

  it('only agendar (and, printing, ja-agendado) ever writes: aceite-pendente and recusar never do, in either mode', () => {
    for (const acao of ['aceite-pendente', 'recusar'] as const) {
      for (const modo of ['tarefa', 'impressao'] as const) {
        expect(planoAgendamentoAmazon(decisao(acao), modo, true, SEGUE, false).escrever).toBe(
          false,
        );
      }
    }
  });

  it('★ mutation 17: tarefa + agendar with the NF-e gate nfe-ambigua writes nothing, its diff says nfe-ambigua (NEAR-MISS: impressao + ja-agendado with the same gate still prints)', () => {
    const p = planoAgendamentoAmazon(decisao('agendar'), 'tarefa', true, AMBIGUA, false);
    expect(p).toMatchObject({ escrever: false, acao: 'recusar', motivo: 'nfe-ambigua' });
    expect(p.diff).toMatchObject({ acao: 'recusar', motivo: 'nfe-ambigua', escreveria: false });
    expect(p.decisao.acao).toBe('agendar');
    const impressao = planoAgendamentoAmazon(decisao('agendar'), 'impressao', true, AMBIGUA, false);
    expect(impressao).toMatchObject({ escrever: false, motivo: 'nfe-ambigua' });
    const jaAgendado = planoAgendamentoAmazon(
      decisao('ja-agendado'),
      'impressao',
      true,
      AMBIGUA,
      false,
    );
    expect(jaAgendado).toMatchObject({ escrever: true, acao: 'ja-agendado', motivo: null });
    // NEAR-MISS: the gate never touches an aceite-pendente or a live refusal either.
    expect(
      planoAgendamentoAmazon(decisao('aceite-pendente'), 'tarefa', true, AMBIGUA, false),
    ).toMatchObject({ acao: 'aceite-pendente', motivo: 'nfe-em-processamento', escrever: false });
    expect(
      planoAgendamentoAmazon(decisao('recusar'), 'impressao', true, AMBIGUA, false),
    ).toMatchObject({ acao: 'recusar', motivo: 'coleta-cancelada', escrever: false });
  });

  it('★ mutation 13: the diff key set is EXACT and holds no url, slot, tracking or pacote key', () => {
    const p = planoAgendamentoAmazon(decisao('agendar'), 'tarefa', true, SEGUE, false);
    expect(Object.keys(p.diff).sort()).toEqual(
      ['acao', 'escreveria', 'fase', 'invoiceStatus', 'modoExecucao', 'motivo'].sort(),
    );
    expect(p.diff).toEqual({
      acao: 'agendar',
      motivo: null,
      fase: 'UNSHIPPED',
      invoiceStatus: 'ACCEPTED',
      modoExecucao: 'tarefa',
      escreveria: true,
    });
    for (const v of Object.values(p.diff)) {
      expect(v === null || ['string', 'boolean'].includes(typeof v)).toBe(true);
    }
    expect(JSON.stringify(p.diff)).not.toMatch(/url|slot|tracking|pacote|https?:/i);
  });

  it('★ mutation 23: impressao + ja-agendado (or agendar with podeAgendar) on a STALE read ⇒ no write, motivo leitura-defasada (NEAR-MISS: the same read, not stale, writes)', () => {
    for (const acao of ['ja-agendado', 'agendar'] as const) {
      const defasado = planoAgendamentoAmazon(decisao(acao), 'impressao', true, SEGUE, true);
      expect(defasado, acao).toMatchObject({ escrever: false, motivo: 'leitura-defasada' });
      expect(defasado.diff, acao).toMatchObject({
        motivo: 'leitura-defasada',
        escreveria: false,
        acao,
      });
      expect(
        planoAgendamentoAmazon(decisao(acao), 'impressao', true, SEGUE, false).escrever,
        acao,
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               the print's outcome                           */
/* -------------------------------------------------------------------------- */

/** The request every thrown error in this block names. */
const REQUISICAO = {
  destino: 'sp-api',
  operacao: 'createScheduledPackageBulk',
  metodo: 'POST',
  caminho: '/easyShip/2022-03-23/packages/bulk',
  correlationId: 'corr-teste',
  requestIdAmazon: null,
  refCredencial: 'ref-teste',
} as const;

const lida = (dados: RespostaAgendamentoEasyShip): ResultadoBulkImpressaoAgendamentoAmazon => ({
  tipo: 'resposta',
  resposta: lerRespostaAgendamentoAmazon(dados, ORDER),
});
const lancado = (erro: unknown): ResultadoBulkImpressaoAgendamentoAmazon => ({
  tipo: 'erro',
  erro,
});
const http = (status: number, codigosErro: readonly string[] = []) =>
  new AmazonHttpError({ ...REQUISICAO, status, codigosErro });

describe('desfechoImpressaoAgendamentoAmazon — over an existing schedule the URL decides (§3 decision 10)', () => {
  it('★ mutation 24: ja-agendado + recusado OrderNotEligibleForRescheduling WITH a URL ⇒ the download', () => {
    expect(
      desfechoImpressaoAgendamentoAmazon(
        'ja-agendado',
        lida(rejeitado('OrderNotEligibleForRescheduling')),
      ),
    ).toEqual({ tipo: 'baixar', url: URL_DOC });
  });

  it('★ ja-agendado + a rejection with NO error object and a URL ⇒ the download', () => {
    expect(
      desfechoImpressaoAgendamentoAmazon(
        'ja-agendado',
        lida(resposta({ rejeitado: null, url: URL_DOC })),
      ),
    ).toEqual({ tipo: 'baixar', url: URL_DOC });
  });

  it('★ the same WITHOUT a URL ⇒ indisponivel; a thrown InvalidOrderState 404 ⇒ indisponivel — never recusada', () => {
    expect(
      desfechoImpressaoAgendamentoAmazon(
        'ja-agendado',
        lida(rejeitado('OrderNotEligibleForRescheduling', null)),
      ),
    ).toEqual({ tipo: 'indisponivel' });
    const erro404 = new AmazonNotFoundError({
      ...REQUISICAO,
      status: 404,
      codigosErro: ['InvalidOrderState'],
    });
    expect(desfechoImpressaoAgendamentoAmazon('ja-agendado', lancado(erro404))).toEqual({
      tipo: 'indisponivel',
    });
    expect(
      desfechoImpressaoAgendamentoAmazon('ja-agendado', lancado(http(400, ['InvalidInput']))),
    ).toEqual({
      tipo: 'indisponivel',
    });
  });

  it('★ NEAR-MISS: the same rejection on an agendar print stays recusada agendamento-recusado (and MissingPackageDimensions dimensoes-ausentes)', () => {
    expect(
      desfechoImpressaoAgendamentoAmazon(
        'agendar',
        lida(rejeitado('OrderNotEligibleForRescheduling')),
      ),
    ).toEqual({ tipo: 'recusada', motivo: 'agendamento-recusado' });
    expect(
      desfechoImpressaoAgendamentoAmazon('agendar', lida(rejeitado('MissingPackageDimensions'))),
    ).toEqual({ tipo: 'recusada', motivo: 'dimensoes-ausentes' });
    expect(
      desfechoImpressaoAgendamentoAmazon('agendar', lida(resposta({ rejeitado: null }))),
    ).toEqual({ tipo: 'recusada', motivo: 'agendamento-recusado' });
    const erro404 = new AmazonNotFoundError({
      ...REQUISICAO,
      status: 404,
      codigosErro: ['InvalidOrderState'],
    });
    expect(desfechoImpressaoAgendamentoAmazon('agendar', lancado(erro404))).toEqual({
      tipo: 'recusada',
      motivo: 'agendamento-recusado',
    });
  });

  it('★ a thrown refusal of the token MINT or of an LWA exchange is never recusada — nothing in the order was refused — in either mode (NEAR-MISS: the same 400 from the bulk is)', () => {
    const mint = {
      ...REQUISICAO,
      operacao: 'createRestrictedDataToken',
      caminho: '/tokens/2021-03-01/restrictedDataToken',
    } as const;
    const lwa = {
      ...REQUISICAO,
      destino: 'lwa',
      operacao: 'trocarRefreshToken',
      caminho: '/auth/o2/token',
    } as const;
    const erros = [
      new AmazonHttpError({ ...mint, status: 400, codigosErro: ['InvalidInput'] }),
      new AmazonHttpError({ ...mint, status: 400, codigosErro: ['MissingPackageDimensions'] }),
      new AmazonNotFoundError({ ...mint, status: 404 }),
      new AmazonHttpError({ ...lwa, status: 400 }),
      // The bulk's own label on the LWA host is still not the bulk's answer.
      new AmazonHttpError({ ...REQUISICAO, destino: 'lwa', status: 400 }),
    ];
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      for (const erro of erros) {
        expect(
          desfechoImpressaoAgendamentoAmazon(acao, lancado(erro)),
          `${acao} ${erro.operacao} ${erro.destino}`,
        ).toEqual({ tipo: 'indisponivel' });
      }
    }
    expect(
      desfechoImpressaoAgendamentoAmazon('agendar', lancado(http(400, ['InvalidInput']))),
    ).toEqual({ tipo: 'recusada', motivo: 'agendamento-recusado' });
  });

  it('a bulk 3xx is not a refusal (never followed, never Amazon’s verdict) ⇒ indisponivel', () => {
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      expect(desfechoImpressaoAgendamentoAmazon(acao, lancado(http(302)))).toEqual({
        tipo: 'indisponivel',
      });
    }
  });

  it('★ a TOP-LEVEL 400 MissingPackageDimensions on an agendar print ⇒ dimensoes-ausentes, as per order (NEAR-MISS: over an existing schedule ⇒ indisponivel)', () => {
    expect(
      desfechoImpressaoAgendamentoAmazon(
        'agendar',
        lancado(http(400, ['MissingPackageDimensions'])),
      ),
    ).toEqual({ tipo: 'recusada', motivo: 'dimensoes-ausentes' });
    expect(
      desfechoImpressaoAgendamentoAmazon(
        'ja-agendado',
        lancado(http(400, ['MissingPackageDimensions'])),
      ),
    ).toEqual({ tipo: 'indisponivel' });
  });

  it('★ ja-agendado + an answer naming NEITHER list for our order, WITH a URL ⇒ the download (NEAR-MISS: the same on an agendar print, or without a URL ⇒ indisponivel)', () => {
    const semNos = resposta({ outro: true, url: URL_DOC });
    expect(lerRespostaAgendamentoAmazon(semNos, ORDER)).toMatchObject({
      tipo: 'sem-pedido',
      url: URL_DOC,
    });
    expect(desfechoImpressaoAgendamentoAmazon('ja-agendado', lida(semNos))).toEqual({
      tipo: 'baixar',
      url: URL_DOC,
    });
    expect(
      desfechoImpressaoAgendamentoAmazon('ja-agendado', lida(resposta({ url: URL_DOC }))),
    ).toEqual({ tipo: 'baixar', url: URL_DOC });
    expect(desfechoImpressaoAgendamentoAmazon('agendar', lida(semNos))).toEqual({
      tipo: 'indisponivel',
    });
    expect(desfechoImpressaoAgendamentoAmazon('ja-agendado', lida(resposta({})))).toEqual({
      tipo: 'indisponivel',
    });
  });

  it('a scheduled answer prints with its URL and is indisponivel without one, in both modes', () => {
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      expect(
        desfechoImpressaoAgendamentoAmazon(acao, lida(resposta({ agendado: true, url: URL_DOC }))),
      ).toEqual({ tipo: 'baixar', url: URL_DOC });
      expect(desfechoImpressaoAgendamentoAmazon(acao, lida(resposta({ agendado: true })))).toEqual({
        tipo: 'indisponivel',
      });
      expect(
        desfechoImpressaoAgendamentoAmazon(acao, lida(rejeitado('ScheduledPackageAlreadyExists'))),
      ).toEqual({ tipo: 'baixar', url: URL_DOC });
      expect(desfechoImpressaoAgendamentoAmazon(acao, lida(resposta({})))).toEqual({
        tipo: 'indisponivel',
      });
    }
  });

  it('a retryable code (per order or top-level), a 429, a 5xx, a timeout and the network ⇒ amazon-indisponivel', () => {
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      expect(
        desfechoImpressaoAgendamentoAmazon(acao, lida(rejeitado('ScheduleWindowExpired'))),
      ).toEqual({ tipo: 'amazon-indisponivel' });
      for (const erro of [
        http(400, ['RetryableAfterGettingNewSlots']),
        new AmazonThrottleError({ ...REQUISICAO, status: 429, limiteTaxa: null }),
        http(503),
        new AmazonTimeoutError({ ...REQUISICAO, prazoMs: 30_000 }, null),
        new AmazonNetworkError(REQUISICAO, new TypeError('fetch failed')),
      ]) {
        expect(desfechoImpressaoAgendamentoAmazon(acao, lancado(erro)), erro.name).toEqual({
          tipo: 'amazon-indisponivel',
        });
      }
    }
  });

  it('a top-level ScheduledPackageAlreadyExists (no URL in an error list) and a 2xx off its schema ⇒ indisponivel', () => {
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      expect(
        desfechoImpressaoAgendamentoAmazon(
          acao,
          lancado(http(400, ['ScheduledPackageAlreadyExists'])),
        ),
      ).toEqual({ tipo: 'indisponivel' });
      const esquema = new AmazonSchemaError({
        ...REQUISICAO,
        status: 200,
        motivo: 'formato',
        campos: ['scheduledPackages'],
      });
      expect(desfechoImpressaoAgendamentoAmazon(acao, lancado(esquema))).toEqual({
        tipo: 'indisponivel',
      });
    }
  });

  it('a second credential refusal, or a parked credential at the write client’s getter ⇒ conta-indisponivel; an AmazonConfigError ⇒ relancar', () => {
    const auth = new AmazonAuthError({ ...REQUISICAO, status: 403, codigoLwa: null });
    const parada = new ContaAmazonParadaError(CONTA, 400, 1);
    for (const acao of ['agendar', 'ja-agendado'] as const) {
      expect(desfechoImpressaoAgendamentoAmazon(acao, lancado(auth))).toEqual({
        tipo: 'conta-indisponivel',
      });
      expect(desfechoImpressaoAgendamentoAmazon(acao, lancado(parada))).toEqual({
        tipo: 'conta-indisponivel',
      });
      expect(
        desfechoImpressaoAgendamentoAmazon(
          acao,
          lancado(new AmazonConfigError('pedido', { operacao: 'x', refCredencial: null })),
        ),
      ).toEqual({ tipo: 'relancar' });
      expect(desfechoImpressaoAgendamentoAmazon(acao, lancado(new TypeError('x')))).toEqual({
        tipo: 'relancar',
      });
    }
  });

  it('over an existing schedule, NO answer is ever recusada (the whole matrix)', () => {
    const respostas = [
      rejeitado('InvalidOrderState'),
      rejeitado('MissingPackageDimensions'),
      rejeitado('TimeSlotNotAvailable', null),
      resposta({ rejeitado: null }),
      resposta({}),
    ];
    const erros = [http(400), http(404, ['InvalidOrderState']), http(409), http(422, ['x'])];
    for (const r of respostas) {
      expect(desfechoImpressaoAgendamentoAmazon('ja-agendado', lida(r)).tipo).not.toBe('recusada');
    }
    for (const e of erros) {
      expect(desfechoImpressaoAgendamentoAmazon('ja-agendado', lancado(e)).tipo).not.toBe(
        'recusada',
      );
    }
  });
});

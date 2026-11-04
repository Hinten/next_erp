/**
 * The import batch against the fake db, which models the batch's all-or-nothing
 * commit, per-write preconditions and (PR 6) the server's answer to a
 * content-identical update — and nothing shaped like a transaction. The REAL
 * batch semantics run in `importarPedido.firestore.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { pagamentoCollection } from '@delfrance/data/admin/collections';
import { ESTADO_PEDIDO, STATUS_PAGAMENTO } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  depois,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { AmazonPedidoEmConflitoError } from './erros';
import {
  MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON,
  gravarPedidoAmazon,
  lerPedidoEPagamentoAmazon,
  type DecidirPagamentosAmazon,
} from './escritaPedido';
import { makePedidoIdAmazon } from './orderIds';
import { mapearPedidoAmazon, type EntradasPedidoAmazon } from './pedidoMapeamento';

const CONTA = 'conta-1';
const ORDER = '171-9876543-2109876';
const PEDIDO = makePedidoIdAmazon(CONTA, ORDER);
const CAMINHO = `pedidos/${PEDIDO}`;
const PAGAMENTO = `${CAMINHO}/pagamentos/${PEDIDO}`;
const NOW_US = 1_900_000_000_000_000;

const ENTRADAS: EntradasPedidoAmazon = {
  integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
  operacaoPedidoOuterRef: null,
  clientePedidoOuterRef: null,
  enderecoFreteOuterReference: null,
  integracaoFreteOuterRef: null,
  modalidadeFreteImportacao: null,
  vinculos: new Map(),
};

/** A hook that writes no pagamento (to set up a pedido alone). */
const SEM_PAGAMENTO: DecidirPagamentosAmazon = () => [];

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

/** One write of `opcoes`' order, through the real reader (step 1 of an attempt). */
async function gravar(
  opcoes: OpcoesPedidoTeste = {},
  extra: { decidirPagamentos?: DecidirPagamentosAmazon; mapeamentos?: { n: number } } = {},
) {
  const order = pedidoAmazon(opcoes);
  const primeiraLeitura = await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO);
  return gravarPedidoAmazon(asDb(db), {
    contaId: CONTA,
    orderId: ORDER,
    pedidoId: PEDIDO,
    primeiraLeitura,
    nowUs: NOW_US,
    mapear: () => {
      if (extra.mapeamentos !== undefined) extra.mapeamentos.n += 1;
      return mapearPedidoAmazon(order, ENTRADAS);
    },
    ...(extra.decidirPagamentos === undefined
      ? {}
      : { decidirPagamentos: extra.decidirPagamentos }),
  });
}

describe('one attempt', () => {
  it('★ a first import CREATES the pedido and its pagamento (never `set`) in ONE batch, parsed through the handles', async () => {
    const r = await gravar({ status: 'UNSHIPPED' });
    expect(r.tipo).toBe('gravado');
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.lote])).toEqual([
      ['create', CAMINHO, 1],
      ['create', PAGAMENTO, 1],
    ]);
    const doc = db.ler(CAMINHO);
    expect(doc?.estado).toBe('pago');
    expect(doc?.numero).toBe(ORDER);
    // The handles' parse filled the schema defaults the mappers leave out.
    expect(Object.hasOwn(doc ?? {}, 'hasUserInteraction')).toBe(true);
    expect(db.ler(PAGAMENTO)).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      marketplace: null,
      liquidacao: null,
    });
    if (r.tipo !== 'gravado') throw new Error('esperava gravado');
    expect(r.writeTime?.isEqual(db.carimboDe(CAMINHO) as never)).toBe(true);
    expect(r.armazenado).toBeNull();
  });

  it('★ an update carries `lastUpdateTime` = the snapshot’s updateTime (tier 2)', async () => {
    await gravar({ status: 'PENDING' });
    const antes = db.carimboDe(CAMINHO);
    const r = await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    expect(r.tipo).toBe('gravado');
    const doPedido = db.escritas.filter((e) => e.caminho === CAMINHO).at(-1);
    expect(doPedido?.verbo).toBe('update');
    expect(doPedido?.comPrecondicao).toBe(true);
    expect(doPedido?.dados?.estado).toBe('pago');
    expect(antes).not.toBeUndefined();
  });

  it('★ an equal redelivery ⇒ sem-mudanca and NO batch is committed (an empty batch never is)', async () => {
    await gravar({ status: 'UNSHIPPED' });
    const r = await gravar({ status: 'UNSHIPPED' });
    expect(r.tipo).toBe('sem-mudanca');
    if (r.tipo !== 'sem-mudanca') throw new Error('esperava sem-mudanca');
    expect(r.writeTime).toBeNull();
    expect(db.commitsDeLote).toHaveLength(1);
    expect(db.escritas).toHaveLength(2);
  });

  it('obsoleto (a newer write landed) ⇒ NOTHING written', async () => {
    await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    const r = await gravar({ status: 'PENDING' });
    expect(r).toMatchObject({ tipo: 'obsoleto', tentativas: 1 });
    expect(db.commitsDeLote).toHaveLength(1);
  });

  it('a first-seen order that is not imported ⇒ NOTHING written, and its motivo', async () => {
    expect(await gravar({ status: 'CANCELLED' })).toMatchObject({
      tipo: 'nao-importado',
      motivo: 'cancelado-nao-importado',
    });
    expect(await gravar({ status: 'SHIPPED', pacotes: ['RETURNED_TO_SELLER'] })).toMatchObject({
      tipo: 'nao-importado',
      motivo: 'reversao-nao-importada',
    });
    expect(db.commitsDeLote).toEqual([]);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('reads the pedido AND its pagamento in one getAll (the CANCELLED predicate needs its status)', async () => {
    await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO);
    expect(db.leituras).toEqual([CAMINHO, PAGAMENTO]);
  });

  it('★ a PENDING order creates the pedido and NO pagamento', async () => {
    const r = await gravar({ status: 'PENDING' });
    expect(r.tipo).toBe('gravado');
    expect(db.escritas.map((e) => e.caminho)).toEqual([CAMINHO]);
    expect(db.ler(PAGAMENTO)).toBeUndefined();
  });
});

describe('★ a lost precondition aborts everything; the retry re-reads and RE-DERIVES', () => {
  it('a concurrent operator edit between the read and the commit ⇒ attempt 2 decides from the NEW snapshot', async () => {
    await gravar({ status: 'PENDING' });
    db.antesDaProximaEscrita(CAMINHO, () => {
      const atual = db.ler(CAMINHO) ?? {};
      db.seed(CAMINHO, { ...atual, hasUserInteraction: true });
    });
    const mapeamentos = { n: 0 };
    const r = await gravar(
      {
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 3, preco: '10.00' })],
      },
      { mapeamentos },
    );
    expect(r.tipo).toBe('gravado');
    if (r.tipo !== 'gravado') throw new Error('esperava gravado');
    expect(r.tentativas).toBe(2);
    expect(mapeamentos.n).toBe(2);
    // Re-derived from the operator's snapshot: the lines are now the operator's.
    expect(r.escrita.decisao.itens).toBe('congeladas');
    expect(db.ler(CAMINHO)?.hasUserInteraction).toBe(true);
    expect(db.commitsDeLote).toHaveLength(3);
  });

  it('a create racing another importer’s create ⇒ 6, then the update path over the winner', async () => {
    db.antesDaProximaEscrita(CAMINHO, async () => {
      const outro = await gravarPedidoAmazon(asDb(db), {
        contaId: CONTA,
        orderId: ORDER,
        pedidoId: PEDIDO,
        primeiraLeitura: await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO),
        nowUs: NOW_US,
        mapear: () => mapearPedidoAmazon(pedidoAmazon({ status: 'PENDING' }), ENTRADAS),
      });
      expect(outro.tipo).toBe('gravado');
    });
    const r = await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    expect(db.ler(CAMINHO)?.estado).toBe('pago');
    expect(db.ler(PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
  });

  it(`three losses in a row ⇒ AmazonPedidoEmConflitoError after EXACTLY ${String(MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON)} commits, NOTHING written`, async () => {
    await gravar({ status: 'PENDING' });
    const antes = db.ler(CAMINHO);
    const escritasAntes = db.escritas.length;
    for (let i = 0; i < MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON + 1; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        db.seed(CAMINHO, { ...(db.ler(CAMINHO) ?? {}) });
      });
    }
    // The bound is a literal: a test relative to the constant would pass any value.
    expect(MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON).toBe(3);
    await expect(gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) })).rejects.toSatisfy(
      (e: unknown) => e instanceof AmazonPedidoEmConflitoError && e.tentativas === 3,
    );
    // The first import's commit + exactly three refused attempts.
    expect(db.commitsDeLote).toHaveLength(1 + 3);
    expect(db.escritas).toHaveLength(escritasAntes);
    expect(db.ler(CAMINHO)).toEqual(antes);
    expect(db.ler(PAGAMENTO)).toBeUndefined();
  });

  it('★ the retry re-reads the PAGAMENTO too: one approved between the read and the commit (beside a pedido change) ⇒ attempt 2 decides estornadoIntegralmente, and the hook sees the re-read snapshot', async () => {
    await gravar({ status: 'UNSHIPPED' }, { decidirPagamentos: SEM_PAGAMENTO });
    expect(db.ler(PAGAMENTO)).toBeUndefined();
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, { ...(db.ler(CAMINHO) ?? {}) });
      db.seed(PAGAMENTO, { status_pagamento: STATUS_PAGAMENTO.aprovado });
    });
    const pagamentosVistos: boolean[] = [];
    const r = await gravar(
      { status: 'CANCELLED', atualizadoEm: depois(60) },
      {
        decidirPagamentos: (snap) => {
          pagamentosVistos.push(snap.exists);
          return [];
        },
      },
    );
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    // NEAR-MISS: from the first read's ABSENT pagamento the predicate answers `cancelado`.
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(pagamentosVistos).toEqual([false, true]);
  });

  it('★ (PR 7) the freight group is re-derived per attempt: an operator checkout landing between the read and the commit ⇒ attempt 2 refuses the PENDING_PICK_UP (regressive), never re-applies attempt 1’s aguardandoPostagem', async () => {
    await gravar({ status: 'UNSHIPPED', invoiceStatus: 'ACCEPTED' });
    expect((db.ler(CAMINHO)?.freteInicial as Record<string, unknown>).estado).toBe(
      'aguardandoAgendamento',
    );
    db.antesDaProximaEscrita(CAMINHO, () => {
      const atual = db.ler(CAMINHO) ?? {};
      db.seed(CAMINHO, {
        ...atual,
        freteInicial: {
          ...(atual.freteInicial as Record<string, unknown>),
          estado: 'checkFinalizado',
        },
      });
    });
    const r = await gravar({
      status: 'UNSHIPPED',
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [
        { packageReferenceId: 'PKG-1', packageStatus: { detailedStatus: 'PENDING_PICK_UP' } },
      ],
    });
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    const frete = db.ler(CAMINHO)?.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe('checkFinalizado');
    // The diary still lands (the package was seen), at the equal order clock.
    expect((frete.pacotes as Record<string, unknown>[]).map((l) => l.numero)).toEqual(['PKG-1']);
  });

  it('★ (PR 7) the CANCELLED goods-out reads THIS attempt’s freight: a pickup stamped between the read and the commit ⇒ attempt 2 KEEPS the estado (cancelado-apos-envio), never attempt 1’s estornadoIntegralmente', async () => {
    await gravar({ status: 'UNSHIPPED', invoiceStatus: 'ACCEPTED' });
    expect(db.ler(PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    db.antesDaProximaEscrita(CAMINHO, () => {
      const atual = db.ler(CAMINHO) ?? {};
      db.seed(CAMINHO, {
        ...atual,
        freteInicial: { ...(atual.freteInicial as Record<string, unknown>), estado: 'postado' },
      });
    });
    const r = await gravar({
      status: 'CANCELLED',
      invoiceStatus: 'ACCEPTED',
      atualizadoEm: depois(60),
    });
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    if (r.tipo !== 'gravado') throw new Error('esperava gravado');
    expect(r.escrita.decisao.incidentes).toContain('cancelado-apos-envio');
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect((db.ler(CAMINHO)?.freteInicial as Record<string, unknown>).estado).toBe('postado');
    expect(db.ler(PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
  });

  it('a non-precondition failure is rethrown at once — never retried', async () => {
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falharEscrita(CAMINHO, falha);
    await expect(gravar({ status: 'UNSHIPPED' })).rejects.toBe(falha);
    expect(db.commitsDeLote).toHaveLength(1);
  });
});

describe('★ (PR 6) the pagamento is proven current at commit — PR 5-d’s residue, flipped', () => {
  /** A stored pedido + pagamento, then a pagamento-only change landing in the read→commit window. */
  async function comMudancaSoNoPagamento(
    pedido: OpcoesPedidoTeste,
    pagamentoGuardado: Record<string, unknown>,
    pagamentoConcorrente: Record<string, unknown>,
    incoming: OpcoesPedidoTeste,
  ) {
    await gravar(pedido, { decidirPagamentos: SEM_PAGAMENTO });
    db.seed(PAGAMENTO, { id: ORDER, valor: 20, ...pagamentoGuardado });
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(PAGAMENTO, { ...(db.ler(PAGAMENTO) ?? {}), ...pagamentoConcorrente });
    });
    return gravar(incoming);
  }

  it('a DECIDED pagamento update (aprovado → estornado) under its stale snapshot ⇒ 9; attempt 2 decides from the operator’s em_disputa: cancelado + pagamento-divergente, the pagamento untouched', async () => {
    const r = await comMudancaSoNoPagamento(
      { status: 'UNSHIPPED' },
      { status_pagamento: STATUS_PAGAMENTO.aprovado },
      { status_pagamento: STATUS_PAGAMENTO.em_disputa },
      { status: 'CANCELLED', atualizadoEm: depois(60) },
    );
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    if (r.tipo !== 'gravado') throw new Error('esperava gravado');
    // Decided from the COMMITTED status (5-d's residue decided estornadoIntegralmente here).
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(r.escrita.decisao.incidentes).toContain('pagamento-divergente');
    expect(db.ler(PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.em_disputa);
    // The winning batch still proved the (untouched) pagamento current: its carrier.
    expect(r.portadorPagamento).toBe(true);
  });

  it('★ the arm that only READ the status — a stored `estornado` KEPT — still carries the pagamento’s precondition: an operator’s em_disputa landing meanwhile ⇒ attempt 2 decides cancelado', async () => {
    const r = await comMudancaSoNoPagamento(
      { status: 'UNSHIPPED' },
      { status_pagamento: STATUS_PAGAMENTO.estornado },
      { status_pagamento: STATUS_PAGAMENTO.em_disputa },
      { status: 'CANCELLED', atualizadoEm: depois(60) },
    );
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2, portadorPagamento: true });
    // Without the carrier, attempt 1 would have committed estornadoIntegralmente.
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.cancelado);
  });

  it('★ the off-ladder arm (an operator’s em_disputa, left alone) carries it too: the operator’s aprovado landing meanwhile ⇒ attempt 2 decides estornadoIntegralmente', async () => {
    const r = await comMudancaSoNoPagamento(
      { status: 'UNSHIPPED' },
      { status_pagamento: STATUS_PAGAMENTO.em_disputa },
      { status_pagamento: STATUS_PAGAMENTO.aprovado },
      { status: 'CANCELLED', atualizadoEm: depois(60) },
    );
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(db.ler(PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('the carrier re-writes ONE stored field exactly as read (status_pagamento), under the pagamento snapshot’s precondition, and moves nothing', async () => {
    await gravar({ status: 'UNSHIPPED' });
    const carimboPagamento = db.carimboDe(PAGAMENTO);
    const guardado = db.ler(PAGAMENTO);
    const r = await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    expect(r).toMatchObject({ tipo: 'gravado', portador: false, portadorPagamento: true });
    const lote = db.escritas.filter((e) => e.lote === 2);
    expect(lote.map((e) => [e.verbo, e.caminho, e.comPrecondicao])).toEqual([
      ['update', CAMINHO, true],
      ['update', PAGAMENTO, true],
    ]);
    expect(lote[1]?.dados).toEqual({ status_pagamento: STATUS_PAGAMENTO.aprovado });
    // Content-identical: the pagamento kept its stamp and its content.
    expect(db.carimboDe(PAGAMENTO)?.isEqual(carimboPagamento)).toBe(true);
    expect(db.ler(PAGAMENTO)).toEqual(guardado);
  });

  it('an ABSENT pagamento carries nothing (a documented residue): a PENDING pedido moving its clock writes the pedido alone', async () => {
    await gravar({ status: 'PENDING' });
    const r = await gravar({ status: 'PENDING', atualizadoEm: depois(60) });
    expect(r).toMatchObject({ tipo: 'gravado', portadorPagamento: false });
    expect(db.escritas.filter((e) => e.lote === 2).map((e) => e.caminho)).toEqual([CAMINHO]);
  });
});

describe('★ (PR 6) the commit’s clock is the LATEST writeTime — a carrier answers the PREVIOUS one', () => {
  it('a pedido carrier FIRST in the batch beside a pagamento create: the result is the commit’s time, never the carrier’s stale answer', async () => {
    await gravar({ status: 'UNSHIPPED' }, { decidirPagamentos: SEM_PAGAMENTO });
    const carimboPedidoAntes = db.carimboDe(CAMINHO);
    const r = await gravar({ status: 'UNSHIPPED' });
    expect(r).toMatchObject({ tipo: 'gravado', portador: true });
    if (r.tipo !== 'gravado' || r.writeTime === null) throw new Error('esperava gravado');
    const lote = db.escritas.filter((e) => e.lote === 2);
    expect(lote.map((e) => [e.verbo, e.caminho])).toEqual([
      ['update', CAMINHO],
      ['create', PAGAMENTO],
    ]);
    // The carrier changed nothing: the pedido keeps its stamp, and its write answered it.
    expect(db.carimboDe(CAMINHO)?.isEqual(carimboPedidoAntes)).toBe(true);
    expect(lote[0]?.writeTime.isEqual(carimboPedidoAntes)).toBe(true);
    // `resultados[0]` would be that stale stamp — the one the previous import's avisos used.
    expect(r.writeTime.isEqual(carimboPedidoAntes as never)).toBe(false);
    expect(r.writeTime.isEqual(db.carimboDe(PAGAMENTO) as never)).toBe(true);
  });
});

describe('the pagamento slot (an injected hook)', () => {
  const pagamentoRef = () => pagamentoCollection.docRef(asDb(db), { pedidoId: PEDIDO }, PEDIDO);

  it('★ an EMPTY pedido patch beside a pagamento write ⇒ the precondition CARRIER (the raw stamp, under the pedido’s precondition)', async () => {
    await gravar({ status: 'UNSHIPPED' }, { decidirPagamentos: SEM_PAGAMENTO });
    const bruto = db.ler(CAMINHO)?.lastMarketplaceUpdate;
    const r = await gravar(
      { status: 'UNSHIPPED' },
      { decidirPagamentos: () => [{ tipo: 'criar', ref: pagamentoRef(), dados: { status: 4 } }] },
    );
    expect(r).toMatchObject({ tipo: 'gravado', portador: true });
    const lote = db.escritas.filter((e) => e.lote === 2);
    expect(lote.map((e) => [e.verbo, e.caminho, e.comPrecondicao])).toEqual([
      ['update', CAMINHO, true],
      ['create', PAGAMENTO, false],
    ]);
    expect(lote[0]?.dados).toEqual({ lastMarketplaceUpdate: bruto });
  });

  it('★ the carrier’s precondition lost ⇒ the pagamento is NOT written either', async () => {
    await gravar({ status: 'UNSHIPPED' }, { decidirPagamentos: SEM_PAGAMENTO });
    for (let i = 0; i < MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        db.seed(CAMINHO, { ...(db.ler(CAMINHO) ?? {}) });
      });
    }
    await expect(
      gravar(
        { status: 'UNSHIPPED' },
        { decidirPagamentos: () => [{ tipo: 'criar', ref: pagamentoRef(), dados: { status: 4 } }] },
      ),
    ).rejects.toBeInstanceOf(AmazonPedidoEmConflitoError);
    expect(db.ler(PAGAMENTO)).toBeUndefined();
  });

  it('a pagamento update rides its OWN snapshot’s precondition, beside the pedido’s', async () => {
    await gravar({ status: 'PENDING' });
    const carimboPagamento = db.seed(PAGAMENTO, { status_pagamento: 4 });
    const r = await gravar(
      { status: 'UNSHIPPED', atualizadoEm: depois(60) },
      {
        decidirPagamentos: (snap) => {
          expect(snap.updateTime?.isEqual(carimboPagamento as never)).toBe(true);
          return [
            {
              tipo: 'atualizar',
              ref: pagamentoRef(),
              dados: { status_pagamento: 8 },
              lastUpdateTime: snap.updateTime as never,
              portador: false,
            },
          ];
        },
      },
    );
    expect(r).toMatchObject({ tipo: 'gravado', portador: false });
    expect(db.escritas.filter((e) => e.lote === 2).map((e) => e.comPrecondicao)).toEqual([
      true,
      true,
    ]);
  });
});

import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { makeEstoqueUid } from '@delfrance/schemas';

import {
  reverterEstoquePedidoExcluido,
  sincronizarEstoquePedido,
} from './sincronizarEstoquePedido';

// Integration test — requires the firestore emulator. Drives the sync core
// directly (the trigger wrapper needs no emulation: its guards are unit-tested
// and it only forwards to the core). Skipped bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

interface EstoqueDoc {
  quantidade?: number;
  quantidadeReservada?: number;
}

function estoqueRef(db: Firestore, produtoId: string, depositoId: string) {
  return db
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(makeEstoqueUid(produtoId, depositoId));
}

async function lerEstoque(db: Firestore, produtoId: string, depositoId: string) {
  const snap = await estoqueRef(db, produtoId, depositoId).get();
  return {
    exists: snap.exists,
    quantidade: (snap.data() as EstoqueDoc | undefined)?.quantidade ?? 0,
    reservada: (snap.data() as EstoqueDoc | undefined)?.quantidadeReservada ?? 0,
  };
}

async function historicos(db: Firestore, produtoId: string, depositoId: string) {
  const snap = await estoqueRef(db, produtoId, depositoId).collection('historicoEstoque').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/**
 * Seed one sales-channel world: depósito + operação + integração + produto(s) +
 * pedido. Every id is unique per call so tests never interfere.
 */
async function seed(
  db: Firestore,
  opts: {
    estado: string;
    ehSaidaOperacao?: boolean;
    movimentaEstoque?: boolean;
    movimentaIndisponivelEstoque?: boolean;
    itens?: Record<string, Array<{ produtoUid: string | null; quantidade: number }>>;
    freteEstado?: string;
    produtos?: Record<string, Record<string, unknown>>;
  },
) {
  const s = randomUUID().replace(/-/g, '').slice(0, 12);
  const produtoId = `prod${s}`;
  const depositoId = `dep${s}`;
  const operacaoId = `op${s}`;
  const integracaoId = `int${s}`;
  const pedidoId = `ped${s}`;

  await db
    .collection('depositos')
    .doc(depositoId)
    .set({ nome: `Dep ${s}`, ativo: true });
  await db
    .collection('operacao')
    .doc(operacaoId)
    .set({
      nome: `Op ${s}`,
      tipo: (opts.ehSaidaOperacao ?? true) ? 1 : 0,
      movimentaEstoque: opts.movimentaEstoque ?? true,
      movimentaIndisponivelEstoque: opts.movimentaIndisponivelEstoque ?? true,
    });
  await db
    .collection('integracao')
    .doc(integracaoId)
    .set({
      nome: `Int ${s}`,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      operacaoOuterRef: `documents/operacao/${operacaoId}`,
      operacaoDevolucaoOuterRef: `documents/operacao/${operacaoId}`,
    });

  const produtos = opts.produtos ?? { [produtoId]: { nome: `Produto ${s}`, ehKit: false } };
  for (const [id, doc] of Object.entries(produtos)) {
    await db.collection('produtos').doc(id).set(doc);
  }

  await db
    .collection('pedidos')
    .doc(pedidoId)
    .set({
      estado: opts.estado,
      ehSaida: opts.ehSaidaOperacao ?? true,
      numero: s,
      itens: opts.itens ?? { [produtoId]: [{ produtoUid: produtoId, quantidade: 5 }] },
      integracaoPedidoOuterRef: `documents/integracao/${integracaoId}`,
      operacaoPedidoOuterRef: null,
      ...(opts.freteEstado ? { freteInicial: { estado: opts.freteEstado } } : {}),
    });

  return { produtoId, depositoId, operacaoId, integracaoId, pedidoId, s };
}

async function mudarPedido(db: Firestore, pedidoId: string, patch: Record<string, unknown>) {
  await db.collection('pedidos').doc(pedidoId).update(patch);
}

describe.skipIf(!EMULATED)('sincronizarEstoquePedido core (emulator)', () => {
  it('full saída lifecycle: reserva → saída (finalizado) → devolução (cancelado)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, {
      estado: 'escolhendoFormaDePagamento',
    });

    // 1. Checkout → reservation.
    let r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    let estoque = await lerEstoque(db, produtoId, depositoId);
    expect(estoque).toMatchObject({ quantidade: 0, reservada: 5 });

    const pedido1 = (await db.collection('pedidos').doc(pedidoId).get()).data()!;
    expect(pedido1.estoqueAplicado).toMatchObject({ depositoId, reservado: { [produtoId]: 5 } });
    expect(pedido1.dataIndisponivelEstoque).not.toBeNull();
    expect(pedido1.dataRemocaoEstoque).toBeNull();

    // 2. Finalizado → physical removal + reservation release, atomically.
    await mudarPedido(db, pedidoId, { estado: 'finalizado' });
    r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    estoque = await lerEstoque(db, produtoId, depositoId);
    expect(estoque).toMatchObject({ quantidade: -5, reservada: 0 });

    const pedido2 = (await db.collection('pedidos').doc(pedidoId).get()).data()!;
    expect(pedido2.estoqueAplicado).toMatchObject({
      removido: { [produtoId]: 5 },
      reservado: null,
    });
    expect(pedido2.dataIndisponivelEstoque).toBeNull();
    expect(pedido2.dataRemocaoEstoque).not.toBeNull();

    // 3. Cancelado → stock returns, snapshot cleared.
    await mudarPedido(db, pedidoId, { estado: 'cancelado' });
    r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    estoque = await lerEstoque(db, produtoId, depositoId);
    expect(estoque).toMatchObject({ quantidade: 0, reservada: 0 });

    const pedido3 = (await db.collection('pedidos').doc(pedidoId).get()).data()!;
    expect(pedido3.estoqueAplicado).toBeNull();
    expect(pedido3.dataRemocaoEstoque).toBeNull();

    // Audit trail: one structured record per movement, exact before/after.
    const trail = await historicos(db, produtoId, depositoId);
    expect(trail).toHaveLength(3);
    const porTipo = Object.fromEntries(trail.map((h) => [h.tipo, h]));
    expect(porTipo.reserva).toMatchObject({
      quantidadeReservadaAntes: 0,
      quantidadeReservadaDepois: 5,
      pedidoOuterRef: `documents/pedidos/${pedidoId}`,
    });
    expect(porTipo.saida).toMatchObject({
      quantidade: -5,
      quantidadeAntes: 0,
      quantidadeDepois: -5,
      quantidadeReservadaAntes: 5,
      quantidadeReservadaDepois: 0,
    });
    expect(porTipo.devolucao).toMatchObject({ quantidade: 5, quantidadeDepois: 0 });
  });

  it('is convergent: a second run writes nothing (loop guard 3, updateTime proof)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, { estado: 'pago' });

    expect((await sincronizarEstoquePedido(db, pedidoId)).status).toBe('aplicado');

    const pedidoRef = db.collection('pedidos').doc(pedidoId);
    const antesPedido = (await pedidoRef.get()).updateTime!;
    const antesEstoque = (await estoqueRef(db, produtoId, depositoId).get()).updateTime!;
    const antesTrail = (await historicos(db, produtoId, depositoId)).length;

    const segunda = await sincronizarEstoquePedido(db, pedidoId);
    expect(segunda).toEqual({ status: 'nada-a-fazer' });

    expect((await pedidoRef.get()).updateTime!.isEqual(antesPedido)).toBe(true);
    expect(
      (await estoqueRef(db, produtoId, depositoId).get()).updateTime!.isEqual(antesEstoque),
    ).toBe(true);
    expect((await historicos(db, produtoId, depositoId)).length).toBe(antesTrail);
  });

  it('adjusts a held reservation when items are edited (legacy drift bug fixed)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, {
      estado: 'escolhendoFormaDePagamento',
    });
    await sincronizarEstoquePedido(db, pedidoId);
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(5);

    await mudarPedido(db, pedidoId, {
      itens: { [produtoId]: [{ produtoUid: produtoId, quantidade: 2 }] },
    });
    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(2);

    const trail = await historicos(db, produtoId, depositoId);
    expect(trail.some((h) => h.tipo === 'ajusteReserva' && h.quantidadeReservada === -3)).toBe(
      true,
    );

    // Cancellation releases the ADJUSTED amount exactly (snapshot, not items).
    await mudarPedido(db, pedidoId, { estado: 'cancelado' });
    await sincronizarEstoquePedido(db, pedidoId);
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(0);
  });

  it('expands kits into limitarEstoque components; the kit produto moves nothing', async () => {
    const db = getDb();
    const s = randomUUID().replace(/-/g, '').slice(0, 12);
    const kitId = `kit${s}`;
    const compA = `compA${s}`;
    const compB = `compB${s}`;
    const { depositoId, pedidoId, produtoId } = await seed(db, {
      estado: 'pago',
      produtos: {
        [kitId]: {
          nome: 'Kit',
          ehKit: true,
          componentesKit: {
            [compA]: { quantidade: 2, limitarEstoque: true },
            [compB]: { quantidade: 1, limitarEstoque: false },
          },
        },
        [compA]: { nome: 'Comp A', ehKit: false },
        [compB]: { nome: 'Comp B', ehKit: false },
      },
      itens: { [kitId]: [{ produtoUid: kitId, quantidade: 3 }] },
    });
    void produtoId;

    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect((await lerEstoque(db, compA, depositoId)).reservada).toBe(6); // 3 kits × 2
    expect((await lerEstoque(db, compB, depositoId)).exists).toBe(false); // not limited
    expect((await lerEstoque(db, kitId, depositoId)).exists).toBe(false); // kit untouched
  });

  it('entrada pedido adds stock and reverts on cancellation', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, {
      estado: 'pago',
      ehSaidaOperacao: false,
    });

    await sincronizarEstoquePedido(db, pedidoId);
    expect(await lerEstoque(db, produtoId, depositoId)).toMatchObject({
      quantidade: 5,
      reservada: 0,
    });

    await mudarPedido(db, pedidoId, { estado: 'cancelado' });
    await sincronizarEstoquePedido(db, pedidoId);
    expect((await lerEstoque(db, produtoId, depositoId)).quantidade).toBe(0);

    const trail = await historicos(db, produtoId, depositoId);
    expect(trail.map((h) => h.tipo).sort()).toEqual(['entrada', 'estorno']);
  });

  it('moves stock on a straight jump to finalizado (legacy hole fixed)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, { estado: 'finalizado' });
    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect((await lerEstoque(db, produtoId, depositoId)).quantidade).toBe(-5);
  });

  it('a shipped frete converts the reservation into a removal while pago', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, { estado: 'pago' });
    await sincronizarEstoquePedido(db, pedidoId);
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(5);

    await mudarPedido(db, pedidoId, { freteInicial: { estado: 'empacotado' } });
    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect(await lerEstoque(db, produtoId, depositoId)).toMatchObject({
      quantidade: -5,
      reservada: 0,
    });
  });

  it('skips a Flutter-era pedido (legacy markers without snapshot)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, { estado: 'pago' });
    await mudarPedido(db, pedidoId, { dataRemocaoEstoque: 1_700_000_000_000_000 });

    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'ignorado', motivo: 'marcadores legados sem snapshot' });
    expect((await lerEstoque(db, produtoId, depositoId)).exists).toBe(false);
  });

  it('reverts a cancelled pedido even when its integração was deleted meanwhile', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId, integracaoId } = await seed(db, { estado: 'pago' });
    await sincronizarEstoquePedido(db, pedidoId);
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(5);

    await db.collection('integracao').doc(integracaoId).delete();
    await mudarPedido(db, pedidoId, { estado: 'cancelado' });

    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(0);
  });

  it('reverts stock when the pedido doc is deleted, idempotently', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, { estado: 'finalizado' });
    await sincronizarEstoquePedido(db, pedidoId);
    expect((await lerEstoque(db, produtoId, depositoId)).quantidade).toBe(-5);

    const before = (await db.collection('pedidos').doc(pedidoId).get()).data()!;
    await db.collection('pedidos').doc(pedidoId).delete();

    const r1 = await reverterEstoquePedidoExcluido(db, pedidoId, before, 'evt1');
    expect(r1).toEqual({ status: 'aplicado', deltas: 1 });
    expect((await lerEstoque(db, produtoId, depositoId)).quantidade).toBe(0);

    // Redelivered delete event: deterministic historico id ⇒ no double restock.
    const r2 = await reverterEstoquePedidoExcluido(db, pedidoId, before, 'evt1-redelivery');
    expect(r2).toEqual({ status: 'aplicado', deltas: 1 }); // planned, but skipped inside the tx
    expect((await lerEstoque(db, produtoId, depositoId)).quantidade).toBe(0);
    const trail = await historicos(db, produtoId, depositoId);
    expect(trail.filter((h) => h.tipo === 'exclusaoPedido')).toHaveLength(1);
  });

  it('a reservation-less operação removes immediately during checkout (legacy parity)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, {
      estado: 'escolhendoFormaDePagamento',
      movimentaIndisponivelEstoque: false,
    });
    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect(await lerEstoque(db, produtoId, depositoId)).toMatchObject({
      quantidade: -5,
      reservada: 0,
    });
  });

  it('records an estoque-drift incidente when the reservada clamp fires (#408)', async () => {
    const db = getDb();
    const { produtoId, depositoId, pedidoId } = await seed(db, { estado: 'pago' });
    await sincronizarEstoquePedido(db, pedidoId); // reserva 5
    const incidentesRef = db.collection('pedidos').doc(pedidoId).collection('incidentes');
    expect((await incidentesRef.get()).size).toBe(0); // clean sync ⇒ no incidente

    // Something OUTSIDE the sync mutates the counter (the drift scenario).
    await estoqueRef(db, produtoId, depositoId).update({ quantidadeReservada: 2 });

    // Cancellation releases the snapshot's 5 over the mutated 2 → clamp at 0.
    await mudarPedido(db, pedidoId, { estado: 'cancelado' });
    const r = await sincronizarEstoquePedido(db, pedidoId);
    expect(r).toEqual({ status: 'aplicado', deltas: 1 });
    expect((await lerEstoque(db, produtoId, depositoId)).reservada).toBe(0);

    const incidentes = (await incidentesRef.get()).docs.map((d) => d.data());
    expect(incidentes).toHaveLength(1);
    expect(incidentes[0]).toMatchObject({ tipo: 'o', subtipo: 'estoque-drift' });
    expect(incidentes[0]!.motivoDoIncidente).toContain(makeEstoqueUid(produtoId, depositoId));
  });
});

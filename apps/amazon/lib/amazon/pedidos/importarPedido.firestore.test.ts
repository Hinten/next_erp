/**
 * The order import on a REAL Firestore — the emulator of `ci-amazon.yml`, not
 * the in-memory fake (master plan step 5, PR 5-d).
 *
 * The offline suites (`escritaPedido.test.ts`, `importarPedido.test.ts`) prove
 * every decision against `testing/fakeDb.ts`, which MODELS the batch. This file
 * proves the model and the import on the real server:
 *
 *  - the batch's semantics as the server applies them: a `create` over an
 *    existing document fails 6 and writes NO sibling; a stale `lastUpdateTime`
 *    fails 9 and writes no sibling; an update naming a document deleted since
 *    its read fails 9 too, and writes no sibling;
 *  - the writer's update path against the server's own error object: a lost
 *    precondition re-reads and re-derives, and attempt 2 lands beside the
 *    concurrent field;
 *  - two interleaved importers of one order converge on ONE pedido;
 *  - the cancellation race (plan §3 decision 12): B sees a recent first-seen
 *    CANCELLED and waits (a retryable throw, zero writes); A's PENDING create
 *    lands; B's retry cancels A's pedido — no reserving pedido is left behind;
 *  - the REAL `findOrCreateCliente` (its own transaction in `packages/data`) and
 *    `ensureEndereco`, with the pedido's refs pointing at what they wrote;
 *  - the collection-group link query with `in` runs (the emulator enforces no
 *    index; the declaration is pinned by `vinculoProdutoAmazon.test.ts`);
 *  - (PR 6) the pagamento in the batch: the PEDIDO's precondition carrier (a
 *    stale pedido precondition writes no pagamento), the PAGAMENTO's carrier on
 *    an arm that only read its status (PR 5-d's residue, closed), and the
 *    commit clock taken as the LATEST `writeTime` — the server answers a
 *    content-identical write with the document's previous update time.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the context as `ambiente`. Never through `process.env` (the lane sets it
 * `off`; the setup refuses `on`; each case asserts it). Amazon is a scripted
 * `fetch` serving model shapes composed in test code; the credential's token is
 * far from expiry, so no LWA exchange can be due; ViaCEP is a fake.
 *
 * ⚠️ The emulator is SHARED: the contas here use ids no other suite seeds, and
 * are INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger the
 * functions emulator loads only reads. Every case wipes what it reads first, and
 * the file leaves nothing behind.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { INTEGRACAO_TIPO, MOTIVO_CONTA_AMAZON, STATUS_PAGAMENTO } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { agoraUsDe, chaveContaPrecisaAtencao } from '../avisos/avisos';
import { loadAmazonContext } from '../core/contexto';
import type { AmbienteAmazon } from '../env';
import type { DepsImportadorAmazon } from '../notificacoes/notificacao';
import { gerarCpf } from '../testing/documentos';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
  respostaJson,
} from '../testing/fixtures';
import { payloadPush, registroTeste } from '../testing/importadorAmazon';
import {
  ATUALIZADO_US,
  depois,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { getOrderBr } from '../testing/sandboxBr';
import { AmazonCancelamentoRecenteError } from './erros';
import { gravarPedidoAmazon, lerPedidoEPagamentoAmazon } from './escritaPedido';
import { importarPedidoAmazon } from './importarPedido';
import { makePedidoIdAmazon } from './orderIds';
import { mapearPedidoAmazon } from './pedidoMapeamento';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds. */
const CONTA = 'conta-amazon-importador-ci';
const ORDER = '171-9876543-2109876';
const PEDIDO = makePedidoIdAmazon(CONTA, ORDER);
const CAMINHO = `pedidos/${PEDIDO}`;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
});

function db() {
  return getAdminFirestore();
}

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(CAMINHO));
  await db().recursiveDelete(
    db().doc(`pedidos/${makePedidoIdAmazon(CONTA, '123-4567890-1234567')}`),
  );
  await db().recursiveDelete(db().collection('clientes'));
  await db().recursiveDelete(db().collection('clienteIdentidades'));
  await db().recursiveDelete(db().doc('produtos/produto-amazon-ci'));
  for (const motivo of Object.values(MOTIVO_CONTA_AMAZON)) {
    await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, motivo)}`)
      .delete();
  }
  const avisosDoPedido = await db()
    .collection('avisos')
    .where('tipo', '==', 'amazonPedidoPrecisaAtencao')
    .get();
  await Promise.all(avisosDoPedido.docs.map((d) => d.ref.delete()));
  await db().doc(caminhoCredencial(CONTA)).delete();
  await db().doc(caminhoConta(CONTA)).delete();
}

/** An active, connected, INCOMPLETE conta (no filial, no dataCadastro) and a fresh credential. */
async function semearConta(): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste do importador',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
}

/** One import of `order`, in-process, with a scripted fetch that refuses anything but getOrder. */
async function importar(order: Record<string, unknown>, agoraMs = Date.now()) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  const log = loggerEspiao();
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith('/orders/2026-01-01/orders/')) {
      return Promise.reject(new TypeError('sem rede: só o getOrder roteirizado'));
    }
    return Promise.resolve(respostaJson(200, { order }));
  });
  const contexto = await loadAmazonContext(db(), CONTA, {
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => agoraMs,
    logger: log.logger,
    fetch,
    gerarCorrelationId: () => 'corr-ci',
  });
  const deps: DepsImportadorAmazon = {
    agora: () => agoraMs,
    increment: (by) => FieldValue.increment(by),
    logger: log.logger,
    viaCep: { buscarCep: () => Promise.resolve(null) },
    registro: registroTeste(0),
  };
  const payload = { ...payloadPush(String(order.orderId)), sellerId: SPID_A };
  const r = await importarPedidoAmazon(db(), contexto, payload, deps);
  // Not one request but the scripted getOrder.
  for (const [input] of fetch.mock.calls) {
    expect(new URL(String(input)).pathname).toMatch(/^\/orders\/2026-01-01\/orders\//);
  }
  return r;
}

/** A parsed builder order, as JSON. */
function corpo(opcoes: OpcoesPedidoTeste = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify(pedidoAmazon(opcoes))) as Record<string, unknown>;
}

/** An ISO instant `ms` before `agoraMs`, whole seconds. */
function antes(agoraMs: number, ms: number): string {
  const seg = Math.floor((agoraMs - ms) / 1000) * 1000;
  return new Date(seg).toISOString().replace('.000Z', 'Z');
}

describe.skipIf(!EMULATED)('the Amazon order import on real Firestore (emulator)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    await limpar();
    await semearConta();
  });

  afterAll(async () => {
    await limpar();
  });

  describe('the batch, as the server applies it', () => {
    const pedidoRef = () => db().doc(CAMINHO);
    const pagamentoRef = () => db().doc(`${CAMINHO}/pagamentos/${PEDIDO}`);

    it('★ a create over an existing document fails 6 and writes NO sibling', async () => {
      await pedidoRef().set({ x: 1 });
      const lote = db().batch();
      lote.create(pagamentoRef(), { y: 1 });
      lote.create(pedidoRef(), { x: 2 });
      await expect(lote.commit()).rejects.toMatchObject({ code: 6 });
      expect((await pagamentoRef().get()).exists).toBe(false);
      expect((await pedidoRef().get()).data()).toEqual({ x: 1 });
    });

    it('★ a stale lastUpdateTime fails 9 and writes NO sibling', async () => {
      await pedidoRef().set({ x: 1 });
      const lido = (await pedidoRef().get()).updateTime;
      await pedidoRef().set({ x: 'outro' });
      const lote = db().batch();
      lote.create(pagamentoRef(), { y: 1 });
      lote.update(pedidoRef(), { x: 2 }, { lastUpdateTime: lido! });
      await expect(lote.commit()).rejects.toMatchObject({ code: 9 });
      expect((await pagamentoRef().get()).exists).toBe(false);
      expect((await pedidoRef().get()).data()).toEqual({ x: 'outro' });
    });

    it('★ an update naming a document deleted since its read fails 9, and writes NO sibling', async () => {
      await pedidoRef().set({ x: 1 });
      const lido = (await pedidoRef().get()).updateTime;
      await pedidoRef().delete();
      const lote = db().batch();
      lote.create(pagamentoRef(), { y: 1 });
      lote.update(pedidoRef(), { x: 2 }, { lastUpdateTime: lido! });
      // The stamp replaces the SDK's `exists` check, so the server answers 9 —
      // the code the fake models. The writer's 5 arm is defensive only: every
      // update it issues carries a stamp.
      await expect(lote.commit()).rejects.toMatchObject({ code: 9 });
      expect((await pagamentoRef().get()).exists).toBe(false);
      expect((await pedidoRef().get()).exists).toBe(false);
    });
  });

  it('★ the writer’s update path on the real server: a lost precondition (9) re-reads and RE-DERIVES, attempt 2 wins', async () => {
    expect((await importar(corpo({ status: 'PENDING' }))).kind).toBe('importado');
    const primeiraLeitura = await lerPedidoEPagamentoAmazon(db(), PEDIDO);
    // A concurrent operator edit lands after that read.
    await db().doc(CAMINHO).update({ observacoesInternas: 'nota do operador' });
    const order = pedidoAmazon({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    const r = await gravarPedidoAmazon(db(), {
      contaId: CONTA,
      orderId: ORDER,
      pedidoId: PEDIDO,
      primeiraLeitura,
      nowUs: agoraUsDe({ nowMs: Date.now() }),
      mapear: () =>
        mapearPedidoAmazon(order, {
          integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
          operacaoPedidoOuterRef: null,
          clientePedidoOuterRef: null,
          enderecoFreteOuterReference: null,
          integracaoFreteOuterRef: null,
          modalidadeFreteImportacao: null,
          vinculos: new Map(),
        }),
    });
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    const final = (await db().doc(CAMINHO).get()).data() ?? {};
    // The concurrent field survived, and the newer read landed over it.
    expect(final.observacoesInternas).toBe('nota do operador');
    expect(final.lastMarketplaceUpdate).toBe(ATUALIZADO_US + 60_000_000);
    expect(final.estado).toBe('pago');
  });

  it('★ two interleaved importers of one order converge on ONE pedido', async () => {
    const order = corpo({ status: 'PENDING' });
    const [a, b] = await Promise.all([importar(order), importar(order)]);
    expect([a.kind, b.kind].sort()).toEqual(['importado', 'sem-mudanca']);
    const pedidos = await db().collection('pedidos').where('numero', '==', ORDER).get();
    expect(pedidos.docs.map((d) => d.id)).toEqual([PEDIDO]);
    expect(pedidos.docs[0]?.data().estado).toBe('aguardandoConfirmacaoDePagamento');
  });

  it('★ the cancellation race: B waits on a recent first-seen CANCELLED, A creates, B’s retry cancels — no reservation left', async () => {
    const agora = Date.now();
    const cancelado = corpo({ status: 'CANCELLED', atualizadoEm: antes(agora, 60_000) });
    const pendente = corpo({ status: 'PENDING', atualizadoEm: antes(agora, 120_000) });
    // B: first seen, cancelled a minute ago ⇒ waits, writing nothing.
    await expect(importar(cancelado, agora)).rejects.toBeInstanceOf(AmazonCancelamentoRecenteError);
    expect((await db().doc(CAMINHO).get()).exists).toBe(false);
    // A: its older PENDING read commits now.
    expect((await importar(pendente, agora)).kind).toBe('importado');
    expect((await db().doc(CAMINHO).get()).data()?.estado).toBe('aguardandoConfirmacaoDePagamento');
    // B's retry re-fetches and re-reads: the pedido exists now, and is cancelled.
    expect((await importar(cancelado, agora + 10_000)).kind).toBe('importado');
    const final = (await db().doc(CAMINHO).get()).data() ?? {};
    expect(final.estado).toBe('cancelado');
  });

  it('★ the REAL cliente resolver and endereço writer, and the link query with `in` (sandbox body + a run-time CPF)', async () => {
    const sandbox = getOrderBr().order;
    await db().doc('produtos/produto-amazon-ci').set({ nome: 'Produto CI' });
    await db()
      .doc('produtos/produto-amazon-ci/prodAmazon/link-ci')
      .set({
        contaAmazonOuterRef: `integracao/${CONTA}`,
        sku: 'SKU-TESTE-0001',
      });
    const order = {
      ...sandbox,
      tax: { taxRegistrations: [{ entityType: 'BUYER', taxRegistrationNumber: gerarCpf() }] },
    };
    const r = await importar(order);
    expect(r.kind).toBe('importado');
    const pedidoId = makePedidoIdAmazon(CONTA, String(sandbox.orderId));
    const pedido = (await db().doc(`pedidos/${pedidoId}`).get()).data() ?? {};
    expect(pedido.estado).toBe('pago');
    // The line bound through the bare-form link doc.
    expect(Object.keys(pedido.itens as object)).toEqual(['produto-amazon-ci']);
    // The cliente the real resolver wrote, and the endereço under it.
    const clienteRef = String(pedido.clientePedidoOuterRef);
    const clienteId = clienteRef.split('/').at(-1) ?? '';
    expect((await db().doc(`clientes/${clienteId}`).get()).exists).toBe(true);
    const endereco = String(
      (pedido.freteInicial as Record<string, unknown>).enderecoFreteOuterReference,
    );
    expect(endereco.startsWith(`documents/clientes/${clienteId}/enderecos/`)).toBe(true);
    const enderecoDoc = await db()
      .doc(endereco.replace(/^documents\//, ''))
      .get();
    expect(enderecoDoc.exists).toBe(true);
    // The recipient's name for the endereço only — never the cliente's.
    expect(enderecoDoc.data()?.nome).toBe('Compradora Ficticia Um');
    // A redelivery converges: nothing changes, nothing new is created.
    expect((await importar(order)).kind).toBe('sem-mudanca');
    expect((await db().collection('clientes').get()).size).toBe(1);
  });

  it('a line with no link doc stays unbound with its incidente, on the real server', async () => {
    const r = await importar(
      corpo({ status: 'UNSHIPPED', linhas: [linhaAmazon('L9', { qtd: 1, preco: '1.00' })] }),
    );
    expect(r.kind).toBe('importado');
    const incidente = await db().doc(`${CAMINHO}/incidentes/amz-prod-L9`).get();
    expect(incidente.data()).toMatchObject({ subtipo: 'unresolved', externalId: 'L9' });
  });
  describe('★ PR 6 — the pagamento in the batch, on the real server', () => {
    const PAGAMENTO = `${CAMINHO}/pagamentos/${PEDIDO}`;
    const ENTRADAS_CI = {
      integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
      operacaoPedidoOuterRef: null,
      clientePedidoOuterRef: null,
      enderecoFreteOuterReference: null,
      integracaoFreteOuterRef: null,
      modalidadeFreteImportacao: null,
      vinculos: new Map<string, string>(),
    };
    const gravar = async (
      order: ReturnType<typeof pedidoAmazon>,
      primeiraLeitura: Awaited<ReturnType<typeof lerPedidoEPagamentoAmazon>>,
    ) =>
      gravarPedidoAmazon(db(), {
        contaId: CONTA,
        orderId: ORDER,
        pedidoId: PEDIDO,
        primeiraLeitura,
        nowUs: agoraUsDe({ nowMs: Date.now() }),
        mapear: () => mapearPedidoAmazon(order, ENTRADAS_CI),
      });

    it('★ the PEDIDO carrier: a stale pedido precondition writes NO pagamento; attempt 2 re-derives from the operator’s cancel and writes none', async () => {
      expect((await importar(corpo({ status: 'UNSHIPPED' }))).kind).toBe('importado');
      expect((await db().doc(PAGAMENTO).get()).data()?.status_pagamento).toBe(
        STATUS_PAGAMENTO.aprovado,
      );
      // The pagamento disappears, so the SAME order decides only its re-create.
      await db().doc(PAGAMENTO).delete();
      const primeiraLeitura = await lerPedidoEPagamentoAmazon(db(), PEDIDO);
      // An operator cancels the pedido after that read.
      await db().doc(CAMINHO).update({ estado: 'cancelado' });
      const r = await gravar(pedidoAmazon({ status: 'UNSHIPPED' }), primeiraLeitura);
      // Attempt 1 (carrier + create) failed whole; attempt 2 keeps the ERP-side cancel.
      expect(r).toMatchObject({ tipo: 'sem-mudanca', tentativas: 2 });
      expect((await db().doc(PAGAMENTO).get()).exists).toBe(false);
      expect((await db().doc(CAMINHO).get()).data()?.estado).toBe('cancelado');
    });

    it('★ the PAGAMENTO carrier on an arm that only READ its status (estornado kept): an operator’s em_disputa landing after the read fails the batch; attempt 2 decides cancelado, and its carrier moves nothing', async () => {
      expect((await importar(corpo({ status: 'UNSHIPPED' }))).kind).toBe('importado');
      await db().doc(PAGAMENTO).update({ status_pagamento: STATUS_PAGAMENTO.estornado });
      const primeiraLeitura = await lerPedidoEPagamentoAmazon(db(), PEDIDO);
      await db().doc(PAGAMENTO).update({ status_pagamento: STATUS_PAGAMENTO.em_disputa });
      const antes = (await db().doc(PAGAMENTO).get()).updateTime;
      const r = await gravar(
        pedidoAmazon({ status: 'CANCELLED', atualizadoEm: depois(60) }),
        primeiraLeitura,
      );
      expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2, portadorPagamento: true });
      // From the read's `estornado` the predicate said estornadoIntegralmente.
      expect((await db().doc(CAMINHO).get()).data()?.estado).toBe('cancelado');
      const pagamento = await db().doc(PAGAMENTO).get();
      expect(pagamento.data()?.status_pagamento).toBe(STATUS_PAGAMENTO.em_disputa);
      // The winning carrier was content-identical: the server moved nothing.
      expect(pagamento.updateTime?.isEqual(antes!)).toBe(true);
    });

    it('★ the commit clock: a content-identical pedido carrier answers the pedido’s PREVIOUS update time; the result is the LATEST (the pagamento create’s)', async () => {
      expect((await importar(corpo({ status: 'UNSHIPPED' }))).kind).toBe('importado');
      await db().doc(PAGAMENTO).delete();
      const antes = (await db().doc(CAMINHO).get()).updateTime;
      const primeiraLeitura = await lerPedidoEPagamentoAmazon(db(), PEDIDO);
      const r = await gravar(pedidoAmazon({ status: 'UNSHIPPED' }), primeiraLeitura);
      expect(r).toMatchObject({ tipo: 'gravado', portador: true, tentativas: 1 });
      if (r.tipo !== 'gravado' || r.writeTime === null) throw new Error('esperava gravado');
      expect((await db().doc(CAMINHO).get()).updateTime?.isEqual(antes!)).toBe(true);
      expect(r.writeTime.isEqual(antes!)).toBe(false);
      const pagamento = await db().doc(PAGAMENTO).get();
      expect(r.writeTime.isEqual(pagamento.updateTime!)).toBe(true);
      expect(pagamento.data()?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    });
  });
});

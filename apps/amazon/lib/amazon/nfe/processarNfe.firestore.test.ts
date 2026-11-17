/**
 * The NF-e task on a REAL Firestore — the emulator of `ci-amazon.yml`, not the
 * in-memory fake (step 14, PR 14-c). The offline suites prove every decision
 * against `testing/fakeDb.ts`; this file proves, on the real server, the two
 * guards that only hold if the server behaves as the fake says:
 *
 *  - **the stamp racing the order import's batch on the same pedido**, both
 *    preconditions, both orders of arrival: the task's tier-1 stamp LOSES to a
 *    batch that moved the freight to `aguardandoPostagem` between its read and
 *    its write (the server answers 9; the stamp re-reads and re-decides
 *    `fora-do-escopo`, writing nothing); and the import's batch LOSES to a
 *    stamp that landed between ITS read and its commit (9; attempt 2 re-derives
 *    from the stamped pedido and keeps `error` — gate 5);
 *  - **the aviso clock on the Firestore timeline**: a raise derived from the
 *    task's pedido read is DROPPED after the import's newer transition resolve
 *    — over an existing open row, and over NO row at all (the import's resolve
 *    leaves a resolved TOMBSTONE).
 *
 * The interleavings are made with a hooked Firestore handle (ONE write of ONE
 * path waits for the concurrent writer first); everything else is the real SDK
 * against the real emulator.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the task and the context as `ambiente`. Never through `process.env` (the
 * lane sets it `off`; the setup refuses `on`; each case asserts it). Amazon is a
 * scripted `fetch` serving model shapes composed in test code (getOrder, the
 * invoice status) — it REFUSES `submitInvoice`: no case here submits; the
 * credential's token is far from expiry, so no LWA exchange can be due.
 *
 * ⚠️ THE FOURTH EMULATOR SHARING RULE (`vitest.tasks.config.ts`): the functions
 * emulator loads `onNfeAprovadaAmazon`, so this suite's READY sale `nfev4`
 * write fires the real trigger. The pedido is therefore seeded FIRST with
 * stored evidence that says NO — a `marketplace` block whose `programs` lack
 * Delivery by Amazon, through the REAL importer — so the trigger stops
 * read-only at T3 (`nao-dba`): no enqueue, no aviso, no race. Every later
 * import here keeps that evidence (its orders carry the same `programs`), while
 * the in-process task decides DBA LIVE from its own scripted `getOrder`. (The
 * plan's example evidence, `fulfilledBy: 'AMAZON'`, would also make the stamp's
 * freight verdict refuse an AFN block — so this suite uses the other.) This is
 * NOT a trigger suite.
 *
 * ⚠️ The emulator is SHARED: the conta here is INCOMPLETE (no filial, no
 * `dataCadastro`), so the conta trigger only reads; its id is seeded by no other
 * suite. Every case wipes what it reads first, and the file leaves nothing behind.
 */
import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { INTEGRACAO_TIPO, MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  agoraUsDe,
  chaveContaPrecisaAtencao,
  chavePedidoPrecisaAtencao,
  relogioDoDocumentoUs,
} from '../avisos/avisos';
import { loadAmazonContext } from '../core/contexto';
import type { AmbienteAmazon } from '../env';
import type { DepsImportadorAmazon } from '../notificacoes/notificacao';
import { gravarPedidoAmazon, lerPedidoEPagamentoAmazon } from '../pedidos/escritaPedido';
import {
  MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON,
  importarPedidoAmazon,
} from '../pedidos/importarPedido';
import { ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON } from '../pedidos/incidentesPedidoAmazon';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { mapearPedidoAmazon } from '../pedidos/pedidoMapeamento';
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
import { filaAgendamentoDeTeste } from '../testing/produtorAgendamento';
import {
  ATUALIZADO_US,
  depois,
  pacoteAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { criarAgendadorNfeAmazon } from './agendadorNfe';
import { chaveAvisoNfeAmazon } from './avisoNfe';
import { processarNfeAmazon } from './processarNfe';
import { type TarefaNfeAmazon, aposEnvioNfeAmazon, tarefaInicialNfeAmazon } from './tarefaNfe';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds. */
const CONTA = 'conta-amazon-nfe-processar-ci';
const ORDER = '171-9876543-2109876';
const PEDIDO = makePedidoIdAmazon(CONTA, ORDER);
const CAMINHO = `pedidos/${PEDIDO}`;
const NFE_ID = 's1';
const AVISO = `avisos/${chaveAvisoNfeAmazon(CONTA, PEDIDO)}`;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
  AMAZON_MODO_NFE: 'on',
  AMAZON_CANARIO_NFE: '*',
});

/** Stored evidence that says NO (rule 4): every IMPORTED read carries these programs. */
const PROGRAMAS_SEM_DBA = ['PRIME'];

/** A synthetic approved SALE proc (tpAmb 1) — no party, no access key. */
const XML =
  '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
  '</infNFe></NFe></nfeProc>';

function db(): Firestore {
  return getAdminFirestore();
}

/* ------------------------------ the hooked handle ------------------------------ */

/** ONE write of ONE path that first waits for a concurrent writer. */
interface Gancho {
  readonly caminho: string;
  readonly metodo: 'update' | 'create';
  readonly antes: () => Promise<void>;
}

/** Bind every other member to the real target (the SDK reads its own fields through `this`). */
function membro(alvo: object, prop: string | symbol): unknown {
  const v: unknown = Reflect.get(alvo, prop, alvo);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
}

/**
 * The real Firestore, except that the FIRST `update`/`create` of a hooked path
 * runs its concurrent writer (through the REAL handle) right before it — the
 * window between a read and its write.
 */
function comGanchos(real: Firestore, ganchos: Gancho[]): Firestore {
  const doc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop === 'update' || prop === 'create') {
          return async (...args: unknown[]) => {
            const i = ganchos.findIndex((g) => g.caminho === alvo.path && g.metodo === prop);
            if (i >= 0) {
              const [g] = ganchos.splice(i, 1);
              await g?.antes();
            }
            const fn = Reflect.get(alvo, prop, alvo) as (...a: unknown[]) => Promise<unknown>;
            return fn.apply(alvo, args);
          };
        }
        return membro(alvo, prop);
      },
    });
  const colecao = (col: CollectionReference): CollectionReference =>
    new Proxy(col, {
      get(alvo, prop) {
        if (prop === 'doc') {
          return (id?: string) => doc(id === undefined ? alvo.doc() : alvo.doc(id));
        }
        return membro(alvo, prop);
      },
    });
  return new Proxy(real, {
    get(alvo, prop) {
      if (prop === 'collection') return (caminho: string) => colecao(alvo.collection(caminho));
      return membro(alvo, prop);
    },
  });
}

/* ---------------------------------- the seeds ---------------------------------- */

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(CAMINHO));
  await db().doc(AVISO).delete();
  // The import's own rows, by KEY (an aviso stores no conta field to query on).
  for (const motivo of Object.values(MOTIVO_CONTA_AMAZON)) {
    await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, motivo)}`)
      .delete();
  }
  for (const motivo of MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON) {
    await db()
      .doc(`avisos/${chavePedidoPrecisaAtencao(CONTA, ORDER, motivo)}`)
      .delete();
  }
  await db().doc(caminhoCredencial(CONTA)).delete();
  await db().doc(caminhoConta(CONTA)).delete();
}

/** An active, connected, INCOMPLETE conta and a fresh credential. */
async function semearConta(): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste da NF-e',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));
}

/** An order as the IMPORTER reads it: the stored programs say NO (rule 4). */
function ordemDoImportador(opcoes: OpcoesPedidoTeste = {}): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(pedidoAmazon({ status: 'UNSHIPPED', programs: PROGRAMAS_SEM_DBA, ...opcoes })),
  ) as Record<string, unknown>;
}

/** A scripted fetch that serves getOrder and the invoice status, and REFUSES everything else. */
function fetchRoteirizado(roteiro: {
  readonly ordem: Record<string, unknown>;
  readonly status?: Record<string, unknown>;
}) {
  return vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(String(input));
    if ((init?.method ?? 'GET') !== 'GET') {
      return Promise.reject(new TypeError('sem rede: nenhum POST neste arquivo'));
    }
    if (url.pathname.startsWith('/orders/2026-01-01/orders/')) {
      return Promise.resolve(respostaJson(200, { order: roteiro.ordem }));
    }
    if (url.pathname === '/delivery/2022-07-01/invoice/status' && roteiro.status !== undefined) {
      return Promise.resolve(respostaJson(200, roteiro.status));
    }
    return Promise.reject(new TypeError(`sem rede: ${url.pathname} não roteirizado`));
  });
}

/** One import of `order`, in-process, through the REAL importer (the module header's seeds). */
async function importar(order: Record<string, unknown>) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  const log = loggerEspiao();
  const contexto = await loadAmazonContext(db(), CONTA, {
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => Date.now(),
    logger: log.logger,
    fetch: fetchRoteirizado({ ordem: order }),
    gerarCorrelationId: () => 'corr-ci',
  });
  const deps: DepsImportadorAmazon = {
    agora: () => Date.now(),
    increment: (by) => FieldValue.increment(by),
    logger: log.logger,
    viaCep: { buscarCep: () => Promise.resolve(null) },
    agendamento: filaAgendamentoDeTeste().produtor,
    registro: registroTeste(0),
  };
  return importarPedidoAmazon(db(), contexto, { ...payloadPush(ORDER), sellerId: SPID_A }, deps);
}

/** A verification at rung 2 after OUR confirmed submit (a `recusada` there stamps). */
function verificacao(): TarefaNfeAmazon {
  return {
    ...aposEnvioNfeAmazon(tarefaInicialNfeAmazon(PEDIDO, NFE_ID), 'sem-nota', false),
    degrau: 2,
  };
}

/** One NF-e dispatch, in-process: the switch on as a literal, Amazon scripted, the queue a recorder. */
async function processar(handle: Firestore, statusAmazon: Record<string, unknown>) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  const fetch = fetchRoteirizado({
    // The task's OWN live read: merchant-fulfilled, Delivery by Amazon, at the
    // stored watermark (never older: the floor would refuse it).
    ordem: JSON.parse(
      JSON.stringify(
        pedidoAmazon({
          status: 'UNSHIPPED',
          programs: ['DELIVERY_BY_AMAZON'],
          atualizadoEm: depois(600),
        }),
      ),
    ) as Record<string, unknown>,
    status: statusAmazon,
  });
  const enfileiradas: TarefaNfeAmazon[] = [];
  const r = await processarNfeAmazon(handle, verificacao(), {
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => Date.now(),
    logger: loggerEspiao().logger,
    increment: (by) => FieldValue.increment(by),
    agendador: () =>
      criarAgendadorNfeAmazon({
        desligado: false,
        fila: () => ({
          enqueue: (t) => {
            enfileiradas.push(t);
            return Promise.resolve();
          },
        }),
      }),
    // Step 15 (PR 15-c): the seam's scheduling producer, a recorder too — no
    // case here reaches `aceita` with a scheduling-eligible order, and none may
    // enqueue a real task.
    agendamento: filaAgendamentoDeTeste().produtor,
    registro: { tentativa: 0, idTarefa: 'tarefa-nfe-ci' },
    fetch,
    gerarCorrelationId: () => 'corr-nfe-ci',
  });
  for (const [input, init] of fetch.mock.calls) {
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new URL(String(input)).pathname).not.toBe('/delivery/2022-07-01/invoice');
  }
  return { r, enfileiradas };
}

/** The pedido as the real importer creates it, then its READY sale NF-e (rule 4 order). */
async function semearPedidoENfe(): Promise<void> {
  const r = await importar(ordemDoImportador({ invoiceStatus: 'NOT_FOUND' }));
  expect(r.kind).toBe('importado');
  const pedido = (await db().doc(CAMINHO).get()).data() ?? {};
  // Rule 4, asserted: the stored evidence says NO before the nfev4 write fires the trigger.
  expect(pedido.marketplace).toMatchObject({ tipo: 'amazon', programs: PROGRAMAS_SEM_DBA });
  expect((pedido.freteInicial as Record<string, unknown>).estado).toBe('aguardandoNFe');
  await db()
    .doc(`${CAMINHO}/nfev4/${NFE_ID}`)
    .set({ estado: 'a', xml_nfe_proc: XML, data_autorizacao: Date.now() });
}

const freteDe = async () =>
  ((await db().doc(CAMINHO).get()).data()?.freteInicial ?? {}) as Record<string, unknown>;

const REJEITADA = { orderInvoicingStatus: 'Rejected' };

describe.skipIf(!EMULATED)('the NF-e task on real Firestore (emulator)', () => {
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

  it('★ the stamp LOSES to the import’s batch (9 on the real server): it re-reads and re-decides fora-do-escopo, writing nothing; the import’s newer transition resolve closes the raise', async () => {
    await semearPedidoENfe();
    const handle = comGanchos(db(), [
      {
        caminho: CAMINHO,
        metodo: 'update',
        // Between the stamp's read and its write: the order was picked up.
        antes: async () => {
          const r = await importar(
            ordemDoImportador({
              atualizadoEm: depois(60),
              invoiceStatus: 'ACCEPTED',
              pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
            }),
          );
          expect(r.kind).toBe('importado');
        },
      },
    ]);
    const { r } = await processar(handle, REJEITADA);
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'nfe-recusada', carimbo: 'fora-do-escopo' });
    expect((await freteDe()).estado).toBe('aguardandoPostagem');
    // The raise (P3's read time) landed BEFORE the import; the import's
    // transition resolve (its batch writeTime, newer) closed it.
    const aviso = (await db().doc(AVISO).get()).data() ?? {};
    expect(aviso.resolucaoMotivo).toBe('frete-despachado');
    expect(aviso.resolvidoEm).not.toBeNull();
  });

  it('★ the import’s batch LOSES to the stamp (9): attempt 2 re-derives from the STAMPED pedido and keeps error (gate 5)', async () => {
    await semearPedidoENfe();
    const primeiraLeitura = await lerPedidoEPagamentoAmazon(db(), PEDIDO);
    // The stamp lands after the import's read.
    const { r: tarefa } = await processar(db(), REJEITADA);
    expect(tarefa).toMatchObject({ motivo: 'nfe-recusada', carimbo: 'carimbado' });
    const carimbado = await freteDe();
    expect(carimbado.estado).toBe('error');
    const order = pedidoAmazon({
      status: 'UNSHIPPED',
      programs: PROGRAMAS_SEM_DBA,
      atualizadoEm: depois(60),
      invoiceStatus: 'ACCEPTED',
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_SCHEDULE')],
    });
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
    const depoisDoLote = (await db().doc(CAMINHO).get()).data() ?? {};
    // The order-level ACCEPTED never clears step 14's stamp.
    expect((depoisDoLote.freteInicial as Record<string, unknown>).estado).toBe('error');
    expect(depoisDoLote.lastMarketplaceUpdate).toBe(ATUALIZADO_US + 60_000_000);
  });

  it('★ the TOMBSTONE: no row, the import’s cancel transition lands between the task’s pedido read and its raise ⇒ the raise is DROPPED, the row stays resolved', async () => {
    await semearPedidoENfe();
    expect((await db().doc(AVISO).get()).exists).toBe(false);
    let relogioDoLoteUs = 0;
    const handle = comGanchos(db(), [
      {
        caminho: AVISO,
        metodo: 'create',
        antes: async () => {
          const r = await importar(
            ordemDoImportador({ status: 'CANCELLED', atualizadoEm: depois(60) }),
          );
          expect(r.kind).toBe('importado');
          relogioDoLoteUs = Number((await db().doc(AVISO).get()).data()?.relogioEvento ?? 0);
        },
      },
    ]);
    const { r } = await processar(handle, REJEITADA);
    expect(r).toMatchObject({ motivo: 'nfe-recusada', aviso: 'ignorado' });
    const aviso = (await db().doc(AVISO).get()).data() ?? {};
    expect(aviso).toMatchObject({
      resolucaoMotivo: 'pedido-cancelado',
      relogioEvento: relogioDoLoteUs,
    });
    expect(aviso.resolvidoEm).not.toBeNull();
    // The import's transition also filed the cancelled-sale incidente (an authorized sale note).
    expect(
      (await db().doc(`${CAMINHO}/incidentes/${ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON}`).get())
        .exists,
    ).toBe(true);
  });

  it('★ an OPEN row: a newer import resolve, then a raise read before it ⇒ DROPPED (an equal-or-older clock never reopens)', async () => {
    await semearPedidoENfe();
    // Dispatch 1 raises the row (clocked by its pedido read).
    const primeira = await processar(db(), REJEITADA);
    expect(primeira.r).toMatchObject({ motivo: 'nfe-recusada', aviso: 'criado' });
    const aberto = (await db().doc(AVISO).get()).data() ?? {};
    expect(aberto.resolvidoEm).toBeNull();
    // Dispatch 2 reads the pedido; the import's cancel lands before its raise.
    const handle = comGanchos(db(), [
      {
        caminho: AVISO,
        metodo: 'create',
        antes: async () => {
          const r = await importar(
            ordemDoImportador({ status: 'CANCELLED', atualizadoEm: depois(60) }),
          );
          expect(r.kind).toBe('importado');
        },
      },
    ]);
    const segunda = await processar(handle, REJEITADA);
    expect(segunda.r).toMatchObject({ motivo: 'nfe-recusada', aviso: 'ignorado' });
    const final = (await db().doc(AVISO).get()).data() ?? {};
    expect(final.resolucaoMotivo).toBe('pedido-cancelado');
    expect(final.resolvidoEm).not.toBeNull();
    expect(Number(final.relogioEvento)).toBeGreaterThan(Number(aberto.relogioEvento));
    // The resolve's clock is a real commit time on the Firestore timeline (µs),
    // never later than the pedido's own last commit.
    const pedidoUs = relogioDoDocumentoUs(
      (await db().doc(CAMINHO).get()).updateTime ?? { seconds: 0, nanoseconds: 0 },
    );
    expect(Number(final.relogioEvento)).toBeLessThanOrEqual(pedidoUs);
  });
});

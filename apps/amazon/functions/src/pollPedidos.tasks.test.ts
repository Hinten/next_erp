/**
 * The backstop poll into the reads queue, end to end, against the real emulators
 * (`ci-amazon.yml`; step-3/4 plan PR 4-b).
 *
 * What runs for real here:
 *
 *   executarPollPedidosAmazon(db, deps)      the real tick, in THIS process
 *     → listarContasAmazon                   the real enumeration (emulator)
 *     → loadAmazonContext                    the real context: conta, credential
 *     → contasPorSellingPartnerId            the real duplicate-seller query
 *     → buscarPedidosAtualizados             the package client, against a SCRIPTED Amazon (deps.fetch)
 *     → the lease, then the final write      on the real poll document
 *     → criarAgendadorAmazonDoAmbiente()     this codebase's own producer root
 *       → the region-qualified queue → Cloud Tasks emulator → Functions emulator
 *       → filaLeituraAmazon                  the real deployed onTaskDispatched
 *       → its pipeline refuses on the READ SWITCH (the job env sets it `off`)
 *       → `adiado/chamadas-desligadas` → a `deferred` row per order
 *
 * ⚠️ The switch is ON in one process and OFF in the other, and that is the
 * point (step-3 plan §3 decision 37). The poll runs here with `ambiente` handed
 * in as a PARAMETER, so its context passes the switch and its client calls the
 * scripted `deps.fetch`, serving rows built from the BR sandbox fixture
 * (`sb-searchorders-br.json`). `process.env` is never touched: the setup refuses
 * to start when the variable is `on` there, because the functions emulator
 * inherits this shell's environment and the DISPATCHED function must stop at
 * the switch — the setup's fetch kill-switch does not reach that process. So
 * the dispatched run refuses before any read, by call order, and still PERSISTS
 * its outcome: the assertions are about documents a different process wrote.
 *
 * What this proves that the offline suites cannot:
 *  - the payload the poll builds survives the real queue hop and the deployed
 *    handler's `taskSchema` (a `deferred` row per order, under the doc id
 *    spelled out below — conta, order id and the µs stamp intact);
 *  - the poll's own producer root resolves the region-qualified queue the
 *    artifact registers (a mismatch is the silent drop of #1108: the wait times
 *    out instead of failing);
 *  - the enumeration, the context, the seller query, the lease and the final
 *    write run against a real Firestore: the cursor and `vistos` are STORED;
 *  - ★ a second tick over the SAME page enqueues nothing (`vistos`), and the
 *    emulator side agrees: after a LATER sentinel tick — a third order, the only
 *    one enqueued — has landed, the queue holds the three rows and nothing else.
 *    Its creation order is the argument (the queue dispatches in order): a row
 *    the second tick had enqueued under any other id would have landed first.
 *
 * ⚠️ NOT covered: the importer (empty until step 5: the dispatched run would
 * defer as `importador-ausente` were its switch on), `onSchedule` (the emulator
 * ignores it), and any real Amazon call (D11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  NOTIFICACAO_RESILIENCIA_STATUS,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '@/lib/amazon/fixtures/wireCorpus';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '@/lib/amazon/testing/fixtures';

import type { AgendadorAmazon } from '../../lib/amazon/notificacoes/agendador';
import type { PayloadNotificacaoAmazon } from '../../lib/amazon/notificacoes/notificacao';
import {
  type DepsPollAmazon,
  executarPollPedidosAmazon,
} from '../../lib/amazon/pedidos/pollPedidos';
import { criarAgendadorAmazonDoAmbiente } from './agendador';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesAmazon';
const CONTAS = 'integracao';
const POLL = 'pollPedidosAmazon';
const AVISOS = 'avisos';

/** An obviously fake conta id, distinct from the other emulator suites' ids. */
const CONTA_ID = 'conta-amazon-poll-ci';
const MINUTO_MS = 60_000;

/** The first tick's clock: 2026-10-20T12:00:00Z; each later tick 15 minutes on. */
const AGORA = Date.UTC(2026, 9, 20, 12, 0, 0);
const INTERVALO_MS = 15 * MINUTO_MS;

/** Invented 3-7-7 order ids; each changed inside every window below. */
const PEDIDO_A = '000-0000000-0000201';
const PEDIDO_B = '000-0000000-0000202';
const PEDIDO_C = '000-0000000-0000203';
/** 2026-10-20T11:30:00.123456Z and 11:40:00.654321Z — sub-millisecond digits on purpose. */
const A_ISO = '2026-10-20T11:30:00.123456Z';
const B_ISO = '2026-10-20T11:40:00.654321Z';
/** The sentinel order, changed between the second and the third tick. */
const C_ISO = '2026-10-20T12:20:00.000001Z';

/** `poll:<conta>:<order>:<µs>` — spelled out, not derived from the code under test. */
const ID_A = 'poll:conta-amazon-poll-ci:000-0000000-0000201:1792495800123456';
const ID_B = 'poll:conta-amazon-poll-ci:000-0000000-0000202:1792496400654321';
const ID_C = 'poll:conta-amazon-poll-ci:000-0000000-0000203:1792498800000001';

/** The window the FIRST tick asks for: the 24-h bootstrap minus the 10-min overlap. */
const JANELA_DO_BOOTSTRAP = '2026-10-19T11:50:00Z';

/* ------------------------------ the BR fixture ------------------------------ */

const ORDEM_DO_EXEMPLO: Record<string, unknown> = (() => {
  const leitura = lerFixtureAmazon(
    readFileSync(join(DIRETORIO_WIRE_AMAZON, 'sb-searchorders-br.json'), 'utf8'),
  );
  if (!leitura.ok) throw new Error('sb-searchorders-br.json não é um envelope válido');
  const corpo = leitura.data.resposta.corpo as { orders?: unknown[] };
  const [ordem] = corpo.orders ?? [];
  if (typeof ordem !== 'object' || ordem === null) throw new Error('o exemplo não tem pedido');
  return ordem as Record<string, unknown>;
})();

/** One row: the BR example with its order id and stamp rewritten. */
function linha(orderId: string, lastUpdatedTime: string): Record<string, unknown> {
  return { ...structuredClone(ORDEM_DO_EXEMPLO), orderId, lastUpdatedTime };
}

/* ------------------------------------ setup ------------------------------------ */

function db(): Firestore {
  return getAdminFirestore();
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll for the row the DISPATCHED function writes: there is no promise to await
 * across the queue hop, only the effect — and waiting on it is also what keeps
 * `emulators:exec` from tearing the dispatch down mid-flight.
 */
async function aguardarDocumento(
  docId: string,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(NOTIF).doc(docId).get();
    if (snap.exists) return snap.data() ?? {};
    if (Date.now() > prazo) {
      const todos = await db().collection(NOTIF).get();
      throw new Error(
        `a notificação ${docId} não chegou em ${String(timeoutMs)}ms. ` +
          `A coleção tem ${String(todos.size)} doc(s): ${todos.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
          'A varredura enfileirou (o resultado do tick diz quantas) e nada chegou: (i) o Cloud ' +
          'Tasks aceitou e nunca entregou — o descarte silencioso de região do #1108: confira que ' +
          'AMAZON_TASKS_REGION é igual ao FUNCTIONS_REGION embutido no bundle e que ' +
          'prepare-deploy.mjs rodou antes do emulators:exec; (ii) a função despachada DESCARTOU o ' +
          'payload sem gravar (`payload-invalido`: a variante `poll` divergiu do taskSchema) — a ' +
          'linha `[amazon] tarefa da fila de leitura` do emulador diz qual.',
      );
    }
    await aguardar(250);
  }
}

async function limpar(): Promise<void> {
  for (const colecao of [NOTIF, CONTAS, POLL, AVISOS]) {
    await db().recursiveDelete(db().collection(colecao));
  }
}

/** The ids of every row in the queue's failure store, sorted. */
async function idsDaColecao(): Promise<string[]> {
  return (await db().collection(NOTIF).get()).docs.map((d) => d.id).sort();
}

describe.skipIf(!EMULATED || !TASKS)(
  'a varredura de pedidos da Amazon → fila de leitura → onTaskDispatched',
  () => {
    /** Every request that reached the GLOBAL fetch — the scripted Amazon is `deps.fetch`. */
    const redeGlobal: string[] = [];

    beforeAll(() => {
      // Initialise the admin app FIRST, with the project the setup pinned: the
      // producer root's `getAdminApp()` reuses the default app.
      db();
    });

    beforeEach(async () => {
      __resetAllReadCaches();
      await limpar();
      // An ACTIVE Amazon conta connected to SPID_A, with a credential whose
      // access token is far from expiry (no LWA refresh is ever due), and NO
      // poll document: the first lease creates it, as at the window's first tick.
      await db().doc(caminhoConta(CONTA_ID)).set({
        tipo: INTEGRACAO_TIPO.amazon,
        nome: 'Conta de teste',
        ativo: true,
        padrao: false,
        selling_partner_id: SPID_A,
      });
      await db()
        .doc(caminhoCredencial(CONTA_ID))
        .set(credencialDoc({ expirationDate: AGORA + 365 * DIA_MS }));

      const anterior = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          redeGlobal.push(url);
          return anterior(input, init);
        },
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      __resetAllReadCaches();
      // Nothing left the process: Amazon was reached ONLY through `deps.fetch`.
      const naoLocais = redeGlobal.filter((u) => {
        const { hostname } = new URL(u);
        return hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]';
      });
      redeGlobal.length = 0;
      expect(naoLocais).toEqual([]);
    });

    // The emulator is shared with every file that runs after this one.
    afterAll(async () => {
      await limpar();
    });

    // Three ticks and three queue hops (~4.5–7.5 s locally: the queue dispatches
    // about one task every two seconds, plus a cold functions emulator on the
    // first hop).
    it(
      '★ the BR rows → the real enqueue → the dispatched function (switch off) writes `deferred` rows; a second tick on the same page adds nothing',
      { timeout: 120_000 },
      async () => {
        // The emulator process must see the switch OFF; this process passes it
        // ON as a parameter only.
        expect(process.env.AMAZON_CHAMADAS).not.toBe('on');

        let agora = AGORA;
        let pagina: Record<string, unknown>[] = [];
        const requisicoes: URL[] = [];
        const outras: string[] = [];
        const amazonFalsa: typeof globalThis.fetch = (input, init) => {
          const url = new URL(String(input));
          if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== '/orders/2026-01-01/orders') {
            outras.push(`${init?.method ?? 'GET'} ${url.pathname}`);
            return Promise.reject(new TypeError('teste: só searchOrders é servido aqui'));
          }
          requisicoes.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ orders: pagina }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        };
        // The REAL producer root, counted: what each tick handed to Cloud Tasks.
        const real = criarAgendadorAmazonDoAmbiente();
        const enfileirados: PayloadNotificacaoAmazon[] = [];
        const agendador: AgendadorAmazon = {
          enfileirar: (p) => {
            enfileirados.push(p);
            return real.enfileirar(p);
          },
        };
        const espiao = loggerEspiao();
        let execucoes = 0;
        const deps: DepsPollAmazon = {
          // ON as a PARAMETER — never through process.env (header).
          ambiente: AMBIENTE_LIGADO,
          importadorPresente: true,
          agendador,
          agora: () => agora,
          increment: (by) => FieldValue.increment(by),
          logger: espiao.logger,
          gerarExecucaoId: () => {
            execucoes += 1;
            return `exec-poll-ci-${String(execucoes)}`;
          },
          esperar: () => Promise.reject(new Error('teste: a varredura nunca espera')),
          fetch: amazonFalsa,
          gerarCorrelationId: () => 'corr-poll-ci',
        };
        const conta = (r: Awaited<ReturnType<typeof executarPollPedidosAmazon>>) => {
          expect(r.portao).toBeNull();
          expect(r.contas).toHaveLength(1);
          return r.contas[0];
        };

        /* ---- tick 1: the bootstrap; both orders go through the real queue ---- */
        pagina = [linha(PEDIDO_A, A_ISO), linha(PEDIDO_B, B_ISO)];
        const r1 = conta(await executarPollPedidosAmazon(db(), deps));

        expect(r1).toMatchObject({
          integracaoId: CONTA_ID,
          desfecho: 'sucesso',
          enfileiradas: 2,
          persistidas: 0,
          paginas: 1,
          cursorAvancou: true,
        });
        expect(requisicoes.map((u) => u.searchParams.get('lastUpdatedAfter'))).toEqual([
          JANELA_DO_BOOTSTRAP,
        ]);
        expect(enfileirados.map((p) => p.amazonOrderId)).toEqual([PEDIDO_A, PEDIDO_B]);
        // The cursor (B's ms) and `vistos` (µs, sub-ms digits intact) are STORED.
        const poll1 = (await db().collection(POLL).doc(CONTA_ID).get()).data();
        expect(poll1).toMatchObject({
          cursorMs: Date.parse(B_ISO),
          vistos: { [PEDIDO_A]: 1_792_495_800_123_456, [PEDIDO_B]: 1_792_496_400_654_321 },
          emExecucaoAteMs: 0,
          execucaoId: null,
          falhasSeguidas: 0,
        });

        for (const [docId, pedido, us] of [
          [ID_A, PEDIDO_A, 1_792_495_800_123_456],
          [ID_B, PEDIDO_B, 1_792_496_400_654_321],
        ] as const) {
          const doc = await aguardarDocumento(docId);
          expect(doc).toMatchObject({
            tipo: TIPO_TAREFA_AMAZON.pedido,
            origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
            sellerId: SPID_A,
            amazonOrderId: pedido,
            contaId: CONTA_ID,
            lastUpdatedUs: us,
            // `deferred` at the dispatched function's switch, not `failed`: had
            // the poll PERSISTED the row itself (a transient enqueue), it would
            // be `failed` with an `enfileiramento/…` reason.
            status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
            tentativas: 0,
            erro: 'adiado/chamadas-desligadas',
          });
          expect(doc.processedAt).toBeGreaterThan(0);
        }

        /* ---- tick 2, 15 minutes on: the SAME page — `vistos` enqueues nothing ---- */
        agora = AGORA + INTERVALO_MS;
        const r2 = conta(await executarPollPedidosAmazon(db(), deps));

        expect(r2).toMatchObject({
          desfecho: 'sucesso',
          enfileiradas: 0,
          persistidas: 0,
          cursorAvancou: false,
        });
        expect(enfileirados).toHaveLength(2);
        // It re-read the overlap: the window starts 10 minutes before B.
        expect(requisicoes.at(-1)?.searchParams.get('lastUpdatedAfter')).toBe(
          '2026-10-20T11:30:00Z',
        );

        /* ---- tick 3, the SENTINEL: a third order, the only one enqueued ---- */
        agora = AGORA + 2 * INTERVALO_MS;
        pagina = [linha(PEDIDO_A, A_ISO), linha(PEDIDO_B, B_ISO), linha(PEDIDO_C, C_ISO)];
        const r3 = conta(await executarPollPedidosAmazon(db(), deps));

        expect(r3).toMatchObject({ desfecho: 'sucesso', enfileiradas: 1 });
        expect(enfileirados.map((p) => p.amazonOrderId)).toEqual([PEDIDO_A, PEDIDO_B, PEDIDO_C]);
        // POSITIVE first: the sentinel landed, so everything enqueued before it
        // has been dispatched (the queue serves in creation order)…
        expect(await aguardarDocumento(ID_C)).toMatchObject({
          amazonOrderId: PEDIDO_C,
          status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
        });
        // …and only then the absence: the second tick wrote no row of its own.
        expect(await idsDaColecao()).toEqual([ID_A, ID_B, ID_C].sort());

        // Every tick spoke to Amazon only through `searchOrders`, and raised nothing.
        expect(requisicoes).toHaveLength(3);
        expect(outras).toEqual([]);
        expect((await db().collection(AVISOS).get()).empty).toBe(true);
        expect(
          espiao.linhas
            .filter((l) => l.meta?.evento === 'poll' && l.meta.desfecho !== undefined)
            .map((l) => l.meta?.desfecho),
        ).toEqual(['sucesso', 'sucesso', 'sucesso']);
      },
    );
  },
);

/**
 * The notification pipeline on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step-3 plan PR 3-e, suites 3 and 4).
 *
 * The offline suite (`notificacao.test.ts`) proves every decision against
 * `testing/fakeDb.ts`, which MODELS the shared core's writes. This file runs the
 * same entry points against the real Admin SDK, where the core's `create`,
 * `merge` and lane query (`status ==`, `processedAt <`, `orderBy`, `limit`) meet
 * the real server:
 *
 *  - the HOT lane: a `failed` row (persisted by the receiver's own writer) is
 *    re-driven with the switch off, learns its real blocker and MIGRATES to the
 *    deferred lane with a fresh count;
 *  - the DEFERRED lane: a `deferred` row stays deferred with `tentativas` + 1,
 *    and one at `MAX_TENTATIVAS_DEFERRED` parks;
 *  - `importado ⇒ resolve` (the master plan's "→ fake import", step-3 plan §3
 *    decision 37): ONE task run IN THIS PROCESS, routed by the real
 *    `(tipo, selling_partner_id, ativo)` query, its context loaded from a real
 *    conta + credential, handed to a FAKE importer — and no row is left.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal the
 * resolve case passes as `ambiente`. Never through `process.env` — the lane
 * env has it `off`, the setup refuses `on`, and the case asserts the process
 * env is still not `on`. The importer is a fake, the credential's access token
 * is far from expiry (no LWA refresh is due), and the client's `fetch` is a spy
 * that refuses and counts — asserted untouched. The setup's kill-switch would
 * refuse any non-local host anyway.
 *
 * ⚠️ An ABSENCE (the resolve case leaves no row) is asserted only after a
 * POSITIVE read through the same handle: a sentinel row written by the same
 * store and read back first, which proves the named `default` database — in the
 * emulator `(default)` silently exists, so a mis-targeted read would find
 * "nothing" for the wrong reason.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  NOTIFICACAO_RESILIENCIA_STATUS,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import type { AmbienteAmazon } from '../env';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  HORA_MS,
  SPID_A,
  SPID_B,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '../testing/fixtures';
import {
  type DepsLeituraAmazon,
  FLUXO_LEITURA_AMAZON,
  type ImportadorPedidoAmazon,
  MAX_TENTATIVAS_DEFERRED,
  type PayloadNotificacaoAmazon,
  camposDoDocumentoAmazon,
  persistirFalhaNotificacaoAmazon,
  reprocessarAdiadasAmazon,
  reprocessarNotificacoesAmazon,
  tratarTarefaLeituraAmazon,
} from './notificacao';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const NOTIF = 'notificacoesAmazon';

/** The conta the resolve case routes to — an id no other suite seeds. */
const CONTA_RESOLVE = 'conta-amazon-resolve-ci';

/** The lane's switch, as an in-process literal: OFF, the value the job env sets. */
const AMBIENTE_DESLIGADO_DA_LANE: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'off',
});

/**
 * The ONE place the switch is on: an object literal handed to the run as
 * `ambiente` (synthetic LWA pair from `testing/fixtures.ts`). Never the process
 * environment.
 */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
});

function db() {
  return getAdminFirestore();
}

function push(
  notificationId: string,
  over: Partial<{ sellerId: string; amazonOrderId: string }> = {},
) {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    sellerId: over.sellerId ?? SPID_A,
    amazonOrderId: over.amazonOrderId ?? '900-0000000-0000010',
    notificationId,
    publishTimeMs: Date.UTC(2026, 9, 20, 12, 0, 0),
  } satisfies PayloadNotificacaoAmazon;
}

function poll(amazonOrderId: string) {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
    sellerId: SPID_A,
    amazonOrderId,
    contaId: 'conta-amazon-ci',
    lastUpdatedUs: Date.UTC(2026, 9, 13, 8, 15, 58) * 1000 + 123_456,
  } satisfies PayloadNotificacaoAmazon;
}

/** The deps of one read run (the functions root's `depsLeitura.ts` shape), with a spy logger. */
function deps(ambiente: AmbienteAmazon, agora: number) {
  const espiao = loggerEspiao();
  const d: DepsLeituraAmazon = {
    ambiente,
    agora: () => agora,
    logger: espiao.logger,
    importador: null,
    increment: (by: number) => FieldValue.increment(by),
  };
  return { deps: d, linhas: espiao.linhas };
}

/** The physical row, read RAW — what the store actually wrote, not the handle's parse. */
async function lerLinha(docId: string): Promise<FirebaseFirestore.DocumentData | null> {
  const snap = await db().collection(NOTIF).doc(docId).get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

async function idsDaColecao(): Promise<string[]> {
  const todos = await db().collection(NOTIF).get();
  return todos.docs.map((d) => d.id).sort();
}

/** The resolve case's conta and credential — the only conta this file seeds. */
async function apagarContaDoResolve(): Promise<void> {
  await db().doc(caminhoCredencial(CONTA_RESOLVE)).delete();
  await db().doc(caminhoConta(CONTA_RESOLVE)).delete();
}

/** A row in the deferred lane, as the task phase or a hot-lane migration leaves it. */
async function semearAdiada(
  p: PayloadNotificacaoAmazon,
  docId: string,
  tentativas: number,
  processedAt: number,
) {
  await db()
    .collection(NOTIF)
    .doc(docId)
    .set({
      ...camposDoDocumentoAmazon(p),
      status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      tentativas,
      erro: 'adiado/chamadas-desligadas',
      processedAt,
    });
}

describe.skipIf(!EMULATED)('o pipeline da Amazon no Firestore real (emulador)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    const refs = await db().collection(NOTIF).listDocuments();
    await Promise.all(refs.map((r) => r.delete()));
    await apagarContaDoResolve();
  });

  // The emulator is SHARED with every file that runs after this one, and only
  // this file seeds a conta: leave none behind, so a later suite that routes or
  // counts contas never depends on the file order.
  afterAll(async () => {
    await apagarContaDoResolve();
  });

  // The file's first emulator round trips, connection included (~0.3 s locally).
  it(
    'raia QUENTE: uma linha `failed` do receptor, com a chave desligada, migra para `deferred` com contagem nova',
    { timeout: 30_000 },
    async () => {
      const id = 'ci-quente-1';
      await persistirFalhaNotificacaoAmazon(
        db(),
        push(id),
        'enfileiramento/AmazonTarefasDesligadasError',
      );
      // POSITIVE first: the receiver's writer landed the row where this suite reads.
      expect(await lerLinha(`push:${id}`)).toMatchObject({
        status: NOTIFICACAO_RESILIENCIA_STATUS.failed,
        tentativas: 0,
      });

      // Past the hot lane's one-hour window (`processedAt` is the store's real clock).
      const agora = Date.now() + 2 * HORA_MS;
      const { deps: d, linhas } = deps(AMBIENTE_DESLIGADO_DA_LANE, agora);
      const r = await reprocessarNotificacoesAmazon(db(), { now: agora, limit: 10 }, d);

      expect(r).toEqual({ processed: 1, outcomes: { deferred: 1 }, errors: [] });
      expect(await lerLinha(`push:${id}`)).toEqual({
        ...camposDoDocumentoAmazon(push(id)),
        // The poll variant's ids, `null` on a push row (one plain document schema).
        contaId: null,
        lastUpdatedUs: null,
        // MIGRATION into the slow lane: the first time anything learned the real
        // blocker, so the deferred horizon starts at 0, stamped by the sweep.
        status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
        tentativas: 0,
        erro: 'adiado/chamadas-desligadas',
        processedAt: agora,
      });
      // The run stopped at the switch: one blocked line, no context, no client.
      expect(linhas.filter((l) => l.meta?.evento === 'chamada-bloqueada')).toHaveLength(1);
    },
  );

  it('raia ADIADA: segue `deferred` com `tentativas` + 1, e estaciona no teto', async () => {
    const agora = Date.now();
    const antes = agora - 2 * DIA_MS;
    // Two rows, two ORDERS: the sweep collapses rows of one order within a run
    // (dedup key `<seller>:<order>`), so the same order twice would skip one.
    await semearAdiada(
      push('ci-adiada-1', { amazonOrderId: '900-0000000-0000011' }),
      'push:ci-adiada-1',
      0,
      antes,
    );
    const ultima = poll('900-0000000-0000012');
    const idUltima = `poll:conta-amazon-ci:900-0000000-0000012:${String(ultima.lastUpdatedUs)}`;
    await semearAdiada(ultima, idUltima, MAX_TENTATIVAS_DEFERRED - 1, antes);

    const { deps: d } = deps(AMBIENTE_DESLIGADO_DA_LANE, agora);
    const r = await reprocessarAdiadasAmazon(db(), { now: agora, limit: 10 }, d);

    expect(r).toEqual({ processed: 2, outcomes: { deferred: 1, parked: 1 }, errors: [] });
    expect(await lerLinha('push:ci-adiada-1')).toMatchObject({
      status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      tentativas: 1,
      erro: 'adiado/chamadas-desligadas',
      processedAt: agora,
    });
    // The poll variant rehydrates through the STRICT `fromDoc` on the real SDK
    // too, and the seventh deferred pass parks it.
    expect(await lerLinha(idUltima)).toMatchObject({
      status: NOTIFICACAO_RESILIENCIA_STATUS.parked,
      tentativas: MAX_TENTATIVAS_DEFERRED,
      erro: 'adiado/chamadas-desligadas',
      contaId: 'conta-amazon-ci',
      lastUpdatedUs: ultima.lastUpdatedUs,
    });
  });

  it('`importado` ⇒ resolve: roteada pela consulta real, contexto real, importador falso — nenhuma linha', async () => {
    // ⚠️ D11: the switch is on ONLY in the literal below, never in this process.
    expect(process.env.AMAZON_CHAMADAS).not.toBe('on');

    // A connected, active Amazon conta for SPID_B and its credential, whose
    // access token is far from expiry: the fake importer never asks for one
    // anyway, so no LWA refresh can be due.
    await db().doc(caminhoConta(CONTA_RESOLVE)).set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste',
      ativo: true,
      padrao: false,
      selling_partner_id: SPID_B,
    });
    await db()
      .doc(caminhoCredencial(CONTA_RESOLVE))
      .set(credencialDoc({ expirationDate: Date.now() + 365 * DIA_MS }));

    // The SENTINEL, through the same store, read back FIRST (module header).
    const sentinela = push('ci-sentinela', { amazonOrderId: '900-0000000-0000020' });
    await persistirFalhaNotificacaoAmazon(db(), sentinela, 'sentinela');
    expect(await lerLinha('push:ci-sentinela')).toMatchObject({ notificationId: 'ci-sentinela' });

    const importador = vi.fn<ImportadorPedidoAmazon>(() => Promise.resolve({ kind: 'importado' }));
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new TypeError('sem rede: nenhuma chamada à Amazon nesta suíte')),
    );
    const payload = push('ci-resolve', { sellerId: SPID_B, amazonOrderId: '900-0000000-0000021' });
    const { deps: d } = deps(AMBIENTE_LIGADO_NO_PROCESSO, Date.now());

    const r = await tratarTarefaLeituraAmazon(db(), payload, {
      ...d,
      importador,
      fetch,
      registro: { fluxo: FLUXO_LEITURA_AMAZON.intake, tentativa: 0, idTarefa: 'tarefa-ci' },
    });

    expect(r).toEqual({
      resultado: 'done',
      detalhe: 'importado',
      contaId: CONTA_RESOLVE,
      amazonOrderId: '900-0000000-0000021',
      origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    });
    // The importer got the context the REAL routing query and loader built.
    expect(importador).toHaveBeenCalledTimes(1);
    const [, contexto, recebido] = importador.mock.calls[0] ?? [];
    expect(contexto?.integracaoId).toBe(CONTA_RESOLVE);
    expect(contexto?.conta.selling_partner_id).toBe(SPID_B);
    expect(recebido).toEqual(payload);
    // Not one request left this process.
    expect(fetch).not.toHaveBeenCalled();
    // `resolve` in the task phase writes NOTHING: only the sentinel is here.
    expect(await idsDaColecao()).toEqual(['push:ci-sentinela']);
  });
});

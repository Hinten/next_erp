/**
 * The feed's UNCERTAIN PATH on a REAL Firestore — the emulator of
 * `ci-amazon.yml` (step 12a, PR 12-c). The offline suite proves every branch
 * against `testing/fakeDb.ts`; this file proves, on the real server:
 *
 *  - the recovery is enqueued while the lease is still `enviando` (the
 *    recorder reads the lease from the emulator at the enqueue), the aviso is
 *    raised before the release, and the aviso's clock is the lease READ's own
 *    `readTime` (recorded by the hooked handle) — never a later read;
 *  - a SMALLER start turned away between the read and the release makes the
 *    release lose its precondition (9), re-read, and hand that start to its own
 *    NAMED `vez` recovery BEFORE the write lands;
 *  - before the deadline nothing is written (the lease's `updateTime` does not
 *    move) and the task re-enqueues itself unnamed.
 *
 * ⚠️ D11: the path makes no SP-API call; nothing enqueues onto a real queue
 * (the producer's transport is a recorder). The lease is not a trigger path;
 * this file seeds no conta, and its conta id is seeded by no other suite.
 * Every case wipes what it reads first; the file leaves nothing behind.
 */
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FLUXO_FEED_AMAZON,
  MOTIVO_CONTA_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { loggerEspiao } from '../testing/fixtures';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from './agendadorLotes';
import { processarIncertoFeedAmazon, tarefaIncertoFeed } from './incertoFeed';
import type { ProvedorLoteAmazon } from './provedorLote';
import { PRAZO_FEED_MS } from './registroFeed';
import { type TarefaLoteAmazon, nomeRecuperacaoFeed, referenciaVezFeed } from './tarefaLote';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds (no conta document is written). */
const CONTA = 'conta-amazon-feed-incerto-ci';
const CAMINHO_VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const CAMINHO_AVISO = `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.contaSemOperacao)}`;
const EXEC = 'exec-incerto-ci';
const MIN = 60_000;
const HORA = 60 * MIN;
/** Our clock (ms), fixed. */
const AGORA = 1_800_000_000_000;
const ANTES = AGORA - PRAZO_FEED_MS;

function db(): Firestore {
  return getAdminFirestore();
}

/* ------------------------------ the hooked handle ------------------------------ */

/** Bind every other member to the real target (the SDK reads its own fields through `this`). */
function membro(alvo: object, prop: string | symbol): unknown {
  const v: unknown = Reflect.get(alvo, prop, alvo);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
}

/**
 * The real Firestore, except that every `get` of the lease records its
 * `readTime`, and its FIRST `update` first runs `antesDoUpdate` (a concurrent
 * writer, through the REAL handle).
 */
function comEspiao(
  real: Firestore,
  leituras: Timestamp[],
  antesDoUpdate: (() => Promise<unknown>) | null,
): Firestore {
  let gancho = antesDoUpdate;
  const doc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (alvo.path === CAMINHO_VEZ && prop === 'get') {
          return async () => {
            const snap = (await alvo.get()) as DocumentSnapshot;
            leituras.push(snap.readTime);
            return snap;
          };
        }
        if (alvo.path === CAMINHO_VEZ && prop === 'update') {
          return async (...args: unknown[]) => {
            const g = gancho;
            gancho = null;
            if (g !== null) await g();
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

async function limpar(): Promise<void> {
  await db().doc(CAMINHO_VEZ).delete();
  for (const motivo of Object.values(MOTIVO_CONTA_AMAZON)) {
    await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, motivo)}`)
      .delete();
  }
}

/** This run's maybe-submitted feed, expired in place. */
function incerta(campos: Partial<VezFeedAmazon> = {}): VezFeedAmazon {
  return {
    estado: ESTADO_VEZ_FEED_AMAZON.enviando,
    execucaoId: EXEC,
    feedId: null,
    snapshotEmMs: ANTES - MIN,
    antesDoEnvioMs: ANTES,
    mensagens: 40,
    bytes: 4_000,
    ateMs: ANTES,
    atualizadoEmMs: ANTES,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: {
      desdeMs: ANTES - 20 * MIN,
      ateMs: ANTES - 15 * MIN,
      manterDesdeMs: ANTES - 20 * MIN,
      commitAposMs: null,
      depositoId: 'deposito-ci',
    },
    pendenteDesdeMs: null,
    falhasSeguidas: 0,
    ultimaFalhaEmMs: null,
    ultimoEnvioMs: ANTES,
    ultimoFeedConcluidoEmMs: null,
    ...campos,
  };
}

async function vezArmazenada(): Promise<VezFeedAmazon | undefined> {
  return (await db().doc(CAMINHO_VEZ).get()).data() as VezFeedAmazon | undefined;
}

interface Enfileirada {
  readonly tarefa: TarefaLoteAmazon;
  readonly nome: string | null;
  readonly atrasoS: number;
  readonly vez: VezFeedAmazon | undefined;
  readonly avisoExiste: boolean;
}

/** One `feed-incerto` dispatch, in-process: the queue a recorder that reads the server. */
async function rodar(handle: Firestore) {
  const enfileiradas: Enfileirada[] = [];
  const ids = new Set<string>();
  const provedor: ProvedorLoteAmazon<'estoque', unknown> = {
    fluxo: 'estoque',
    membros: () => Promise.reject(new Error('o caminho incerto não monta')),
    montar: () => Promise.reject(new Error('o caminho incerto não monta')),
    gravarResultado: () => Promise.resolve(),
    recuperar: () => Promise.resolve({ nada: true }),
    repassarParaPatches: () => Promise.resolve({ tarefas: 0 }),
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
  const r = await processarIncertoFeedAmazon(
    handle,
    tarefaIncertoFeed({ fluxo: FLUXO_FEED_AMAZON.estoque, contaId: CONTA, execucaoId: EXEC }),
    {
      agora: () => AGORA,
      logger: loggerEspiao().logger,
      increment: (by) => FieldValue.increment(by),
      agendador: () =>
        criarAgendadorLotesAmazon({
          desligado: false,
          fila: (): FilaLotesAmazon => ({
            enqueue: async (tarefa, opcoes) => {
              const id = opcoes?.id;
              if (id !== undefined) {
                if (ids.has(id)) throw falhaDeTarefaJaExistente(id);
                ids.add(id);
              }
              enfileiradas.push({
                tarefa,
                nome: id ?? null,
                atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                vez: await vezArmazenada(),
                avisoExiste: (await db().doc(CAMINHO_AVISO).get()).exists,
              });
            },
          }),
        }),
      provedor,
      registro: { tentativa: 0, idTarefa: 'tarefa-incerto-ci' },
    },
  );
  return { r, enfileiradas };
}

/* ---------------------------------- the cases ---------------------------------- */

describe.skipIf(!EMULATED)('the feed’s uncertain path on real Firestore (emulator)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ at the deadline: the recovery while the lease is STILL enviando, the aviso clocked by the lease read’s readTime, then the release', async () => {
    const pendente = ANTES + 30 * MIN;
    await db()
      .doc(CAMINHO_VEZ)
      .set(incerta({ pendenteDesdeMs: pendente }));
    const leituras: Timestamp[] = [];
    const { r, enfileiradas } = await rodar(comEspiao(db(), leituras, null));

    expect(r.desfecho).toMatchObject({ tipo: 'recuperado', liberacao: 'liberada', aviso: true });
    expect(enfileiradas).toHaveLength(1);
    expect(enfileiradas[0]).toMatchObject({
      nome: nomeRecuperacaoFeed(CONTA, EXEC, pendente),
      tarefa: { desfecho: 'incerto', pendenteDesdeMs: pendente, snapshotEmMs: ANTES - MIN },
      vez: { estado: 'enviando', pendenteDesdeMs: pendente },
      avisoExiste: false,
    });
    const [primeira] = leituras;
    expect(primeira).toBeDefined();
    const aviso = (await db().doc(CAMINHO_AVISO).get()).data();
    expect(aviso).toMatchObject({
      resolvidoEm: null,
      relogioEvento: relogioDoDocumentoUs(primeira as Timestamp),
    });
    expect(await vezArmazenada()).toMatchObject({
      estado: 'livre',
      pendenteDesdeMs: null,
      falhasSeguidas: 1,
      ultimaFalhaEmMs: AGORA,
      ultimoFeedConcluidoEmMs: AGORA,
    });
  });

  it('★ a SMALLER start written between the read and the release ⇒ 9 on the server, re-read, its NAMED vez recovery BEFORE the write', async () => {
    const dobrado = ANTES + 30 * MIN;
    const menor = ANTES + 5 * MIN;
    await db()
      .doc(CAMINHO_VEZ)
      .set(incerta({ pendenteDesdeMs: dobrado }));
    const leituras: Timestamp[] = [];
    const { r, enfileiradas } = await rodar(
      comEspiao(db(), leituras, () => db().doc(CAMINHO_VEZ).update({ pendenteDesdeMs: menor })),
    );

    expect(r.desfecho).toMatchObject({ tipo: 'recuperado', vezPara: menor, liberacao: 'liberada' });
    // One read for the path, one for the first release attempt, one after its 9.
    expect(leituras.length).toBe(3);
    expect(enfileiradas.map((e) => e.nome)).toEqual([
      nomeRecuperacaoFeed(CONTA, EXEC, dobrado),
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(EXEC), menor),
    ]);
    expect(enfileiradas[1]?.vez).toMatchObject({ estado: 'enviando', pendenteDesdeMs: menor });
    expect(await vezArmazenada()).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('before the deadline: re-enqueued UNNAMED for the remainder, and the lease’s updateTime does not move', async () => {
    await db()
      .doc(CAMINHO_VEZ)
      .set(incerta({ antesDoEnvioMs: AGORA - 11 * HORA - 59 * MIN }));
    const antes = (await db().doc(CAMINHO_VEZ).get()).updateTime;
    const { r, enfileiradas } = await rodar(db());
    expect(r.desfecho).toEqual({ tipo: 'cedo', atrasoS: 60, reenfileirado: true });
    expect(enfileiradas).toEqual([
      expect.objectContaining({
        nome: null,
        atrasoS: 60,
        tarefa: expect.objectContaining({ tipo: 'feed-incerto' }),
      }),
    ]);
    const depois = (await db().doc(CAMINHO_VEZ).get()).updateTime;
    expect(depois?.isEqual(antes as Timestamp)).toBe(true);
    expect((await db().doc(CAMINHO_AVISO).get()).exists).toBe(false);
  });

  it('another run’s lease ⇒ sem-vez: nothing enqueued, nothing written', async () => {
    await db()
      .doc(CAMINHO_VEZ)
      .set(incerta({ execucaoId: 'exec-outro-ci' }));
    const antes = (await db().doc(CAMINHO_VEZ).get()).updateTime;
    const { r, enfileiradas } = await rodar(db());
    expect(r.desfecho).toEqual({ tipo: 'sem-vez' });
    expect(enfileiradas).toEqual([]);
    expect((await db().doc(CAMINHO_VEZ).get()).updateTime?.isEqual(antes as Timestamp)).toBe(true);
  });
});

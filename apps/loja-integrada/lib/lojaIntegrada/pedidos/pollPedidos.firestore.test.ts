/**
 * The order poller's LEASE and PRECONDITIONS on a real Firestore — the
 * emulator of `ci-loja-integrada.yml`, not the in-memory fake.
 *
 * Every write the poller makes to `pollPedidosLojaIntegrada/{id}` is a native
 * precondition on ONE document (root rule 7, tier 1): `create`, or
 * `update(…, { lastUpdateTime })`. The offline suite (`pollPedidos.test.ts`)
 * proves the decisions against `testing/fakeDb.ts`, which MODELS how the server
 * applies those preconditions. This file proves the model:
 *
 *  - the primitives answer with the codes the poller narrows on — `create` on
 *    an existing document 6 (ALREADY_EXISTS), a stale `lastUpdateTime` 9
 *    (FAILED_PRECONDITION) — and a DELETED document fails a `lastUpdateTime`
 *    precondition with 9, not 5, as the fake claims (`APP/CLAUDE.md`, "Store and
 *    writes"): the SDK replaces its default `{ exists: true }` with the stamp;
 *  - two runs that both decided on the same snapshot (`Promise.all`, held at a
 *    barrier until BOTH reached their lease write) → exactly one lease lands, on
 *    an absent document and on an expired lease alike, and the loser exits with
 *    zero platform calls;
 *  - a stale final write cannot move the cursor back nor clear another run's
 *    lease, and the one still owning the lease re-derives `max(cursor)`;
 *  - the refusal record is skipped against a held lease, and against a lease
 *    taken between its read and its write.
 *
 * What runs for real: the context loader, the package client and paging, the
 * poller, `escreverAviso`, the collection handle — all against the emulator.
 * What is injected: Loja Integrada (a scripted `fetch` serving the public
 * document's two example rows), the queue (a recorder), the clock and the
 * pacer's sleep. The read switch is ON as a PARAMETER (`ambiente`), never
 * through `process.env`: the setup refuses the variable.
 *
 * ⚠️ The interleavings. A real Firestore offers no "between your read and your
 * write" hook, so {@link comGanchos} wraps the Admin `Firestore` in a Proxy that
 * runs ONE queued callback right before the next `create`/`update` of the poll
 * document — the emulator's counterpart of the fake's `antesDaProximaEscrita`.
 * Everything else passes straight through to the real SDK objects, and every
 * other collection is untouched. The callbacks write through the UNWRAPPED
 * handle, so they never consume a hook themselves.
 *
 * ⚠️ No network: the global `fetch` is wrapped to record and refuse every
 * non-local request, and each test ends by asserting it saw none.
 */
import {
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  type Timestamp,
  type WriteResult,
} from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  INTEGRACAO_TIPO,
  MOTIVO_IMPORTACAO_PARADA_LI,
  ORIGEM_NOTIFICACAO_LI,
  TIPO_TAREFA_LI,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveImportacaoParada, relogioDoDocumentoUs } from '../avisos/avisos';
import type { ContaLojaIntegradaResumo } from '../core/contas';
import type { PayloadNotificacaoLi } from '../notificacoes/notificacao';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  type LinhaGravada,
  credencialDoc,
  gravadorDeLog,
} from '../testing/fixtures';
import { DURACAO_LEASE_POLL_MS, ORCAMENTO_CONTA_MS } from './orcamentoPoll';
import { type DepsPollLi, type ResultadoContaPollLi, executarContaPollLi } from './pollPedidos';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const POLL = 'pollPedidosLojaIntegrada';
const CONTAS = 'integracao';
const AVISOS = 'avisos';
const NOTIF = 'notificacoesLojaIntegrada';

/** An obviously fake conta id, distinct from the round-trip suites' ids. */
const ID = 'conta-li-lease-ci';
const NOME = 'Loja de teste';

/** The stored cursor of a conta already polling: the example rows are inside its window. */
const CURSOR = '2022-10-31T12:00:00';
/** The max of the example rows' stamps, floored to the second: where a clean run leaves the cursor. */
const CURSOR_DOS_EXEMPLOS = '2022-10-31T12:28:12';
/** A cursor LATER than any this run can reach — what another writer left behind. */
const CURSOR_POSTERIOR = '2022-10-31T13:00:00';
/** `AGORA_MS − 72 h`, rendered in São Paulo time: the bootstrap bound of a cursorless conta. */
const BOOTSTRAP_72H = '2027-01-12T12:00:00';

/** The public document's two example rows (`GET /v1/pedido/search`), verbatim stamps. */
const EXEMPLO_164 = {
  numero: 164,
  data_modificacao: '2022-10-31T12:17:58.949670',
  resource_uri: '/api/v1/pedido/164',
};
const EXEMPLO_165 = {
  numero: 165,
  data_modificacao: '2022-10-31T12:28:12.653648',
  resource_uri: '/api/v1/pedido/165',
};
const VISTOS_DOS_EXEMPLOS = {
  '164': '2022-10-31T12:17:58.949670',
  '165': '2022-10-31T12:28:12.653648',
};

function db(): Firestore {
  return getAdminFirestore();
}

function pollRef(): DocumentReference {
  return db().collection(POLL).doc(ID);
}

async function lerPoll(): Promise<DocumentSnapshot> {
  return pollRef().get();
}

/** A snapshot's commit stamp — present on every snapshot of an existing document. */
function carimbo(snap: DocumentSnapshot): Timestamp {
  if (snap.updateTime === undefined) {
    throw new Error(`teste: ${snap.ref.path} não existe — não há updateTime`);
  }
  return snap.updateTime;
}

/** A poll document as the poller leaves one between runs. */
function docPoll(over: DocumentData = {}): DocumentData {
  return {
    cursor: CURSOR,
    emExecucaoAteMs: 0,
    execucaoId: null,
    ultimaVarreduraEmMs: null,
    ultimoErro: null,
    falhasSeguidas: 0,
    vistos: {},
    ...over,
  };
}

async function semearConta(opts: { readonly credencial: boolean }): Promise<void> {
  const conta = db().collection(CONTAS).doc(ID);
  await conta.set({ tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: NOME, ativo: true });
  if (opts.credencial) {
    await conta.collection('credenciaisLojaIntegrada').doc('current').set(credencialDoc());
  }
}

async function limpar(): Promise<void> {
  for (const colecao of [POLL, CONTAS, AVISOS, NOTIF]) {
    await db().recursiveDelete(db().collection(colecao));
  }
}

/* -------------------------------------------------------------------------- */
/*                  The real Firestore, with ONE interleaving seam             */
/* -------------------------------------------------------------------------- */

type OperacaoDeEscrita = 'create' | 'update';

/** One `create`/`update` of the poll document and how the SERVER answered it. */
interface EscritaObservada {
  readonly op: OperacaoDeEscrita;
  /** `null` when it landed; the gRPC status code when the server refused it. */
  readonly codigo: number | null;
}

interface FirestoreComGanchos {
  /** Hand this to the poller: the real database, with the seam on the poll document. */
  readonly db: Firestore;
  /** Run `fn` right before the next `create`/`update` of the poll document is sent. */
  antesDaProximaEscrita(fn: () => Promise<void> | void): void;
  /** Every `create`/`update` of the poll document, in the order the server answered. */
  readonly escritas: EscritaObservada[];
}

/** A property of a real SDK object, methods bound to it (they read private state off `this`). */
function encaminhar(alvo: object, prop: string | symbol): unknown {
  const valor: unknown = Reflect.get(alvo, prop, alvo);
  return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
}

function comGanchos(real: Firestore): FirestoreComGanchos {
  const ganchos: (() => Promise<void> | void)[] = [];
  const escritas: EscritaObservada[] = [];

  async function escrever(
    op: OperacaoDeEscrita,
    ref: DocumentReference,
    args: unknown[],
  ): Promise<WriteResult> {
    const gancho = ganchos.shift();
    if (gancho !== undefined) await gancho();
    try {
      const metodo = ref[op] as (...a: unknown[]) => Promise<WriteResult>;
      const r = await metodo.apply(ref, args);
      escritas.push({ op, codigo: null });
      return r;
    } catch (err) {
      escritas.push({ op, codigo: isGrpcStatusError(err) ? err.code : -1 });
      throw err;
    }
  }

  const embrulharDoc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop === 'create' || prop === 'update') {
          return (...args: unknown[]) => escrever(prop, alvo, args);
        }
        return encaminhar(alvo, prop);
      },
    });

  const proxy = new Proxy(real, {
    get(alvo, prop) {
      if (prop !== 'collection') return encaminhar(alvo, prop);
      return (caminho: string) => {
        const colecao = alvo.collection(caminho);
        if (caminho !== POLL) return colecao;
        return new Proxy(colecao, {
          get(c, p) {
            if (p === 'doc') return (id: string) => embrulharDoc(c.doc(id));
            return encaminhar(c, p);
          },
        });
      };
    },
  });

  return {
    db: proxy,
    antesDaProximaEscrita: (fn) => {
      ganchos.push(fn);
    },
    escritas,
  };
}

/**
 * The writes as a sorted multiset, `<op>:<code | ok>`: two concurrent runs'
 * answers arrive in no fixed order.
 */
function resumo(escritas: readonly EscritaObservada[]): string[] {
  return escritas.map((e) => `${e.op}:${e.codigo === null ? 'ok' : String(e.codigo)}`).sort();
}

/** Each caller waits until `n` of them arrived: both runs are then past their read. */
function barreira(n: number): () => Promise<void> {
  let chegadas = 0;
  let liberar: () => void = () => undefined;
  const aberta = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return () => {
    chegadas += 1;
    if (chegadas === n) liberar();
    return aberta;
  };
}

/* -------------------------------------------------------------------------- */
/*                       Loja Integrada, scripted; one run                     */
/* -------------------------------------------------------------------------- */

interface Plataforma {
  readonly fetch: typeof globalThis.fetch;
  /** Every request this run's scripted platform answered. */
  readonly urls: string[];
}

/**
 * One page of `GET /v1/pedido/search/` with `rows`, `meta.limit` read back as
 * 15 and no `next`. `aoChamar` runs before the answer: the window a concurrent
 * writer lands in, mid-drain.
 */
function plataforma(
  rows: readonly object[],
  aoChamar: () => Promise<void> = () => Promise.resolve(),
): Plataforma {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      await aoChamar();
      const corpo = {
        meta: { limit: 15, offset: 0, next: null, previous: null, total_count: rows.length },
        objects: rows,
      };
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

interface Run {
  readonly plataforma: Plataforma;
  readonly enfileirados: PayloadNotificacaoLi[];
  readonly linhas: LinhaGravada[];
  readonly deps: DepsPollLi;
}

function run(execucaoId: string, p: Plataforma, over: Partial<DepsPollLi> = {}): Run {
  const enfileirados: PayloadNotificacaoLi[] = [];
  const gravador = gravadorDeLog();
  return {
    plataforma: p,
    enfileirados,
    linhas: gravador.linhas,
    deps: {
      // The read switch ON, as a parameter: never through process.env.
      ambiente: AMBIENTE_LIGADO,
      importadorPresente: true,
      lookbackHoras: 72,
      agendador: {
        enfileirar: (payload) => {
          enfileirados.push(payload);
          return Promise.resolve();
        },
      },
      agoraMs: () => AGORA_MS,
      esperar: () => Promise.resolve(),
      increment: (by) => FieldValue.increment(by),
      gerarExecucaoId: () => execucaoId,
      escrever: gravador.escrever,
      fetch: p.fetch,
      ...over,
    },
  };
}

const CONTA: ContaLojaIntegradaResumo = { integracaoId: ID, nome: NOME, ativo: true };

function executar(alvo: Firestore, r: Run): Promise<ResultadoContaPollLi> {
  return executarContaPollLi(alvo, CONTA, ORCAMENTO_CONTA_MS, r.deps);
}

function payload(numero: string, dataModificacaoLi: string): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: ID,
    numero,
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi,
  };
}

function alertas(r: Run, alerta: string): LinhaGravada[] {
  return r.linhas.filter((l) => l.campos.evento === 'poll' && l.campos.alerta === alerta);
}

/* -------------------------------------------------------------------------- */
/*                                  The suite                                 */
/* -------------------------------------------------------------------------- */

describe.skipIf(!EMULATED)('the order poller’s lease and preconditions on real Firestore', () => {
  /** Every request that reached the global fetch, local or not. */
  const redeGlobal: string[] = [];

  beforeAll(() => {
    // Initialise the admin app with the project the setup pinned.
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    await limpar();
    const anterior = globalThis.fetch;
    vi.stubGlobal('fetch', (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      redeGlobal.push(url);
      return anterior(input, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAllReadCaches();
    // Nothing left the process: not Loja Integrada, not anything else.
    const naoLocais = redeGlobal.filter((u) => {
      const { hostname } = new URL(u);
      return hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1';
    });
    redeGlobal.length = 0;
    expect(naoLocais).toEqual([]);
  });

  afterAll(async () => {
    await limpar();
  });

  /* ------------------------------ The primitives ----------------------------- */

  describe('the primitives the fake models, as the server answers them', () => {
    it('create on an existing document → 6; a stale lastUpdateTime → 9; the fresh stamp lands', async () => {
      const ref = pollRef();
      await ref.create(docPoll());
      await expect(ref.create(docPoll())).rejects.toMatchObject({ code: 6 });

      const lido = await ref.get();
      await ref.update({ falhasSeguidas: 1 });
      await expect(
        ref.update({ falhasSeguidas: 5 }, { lastUpdateTime: carimbo(lido) }),
      ).rejects.toMatchObject({ code: 9 });
      expect((await ref.get()).get('falhasSeguidas')).toBe(1);

      // Near-miss: the stamp of the CURRENT version passes.
      const atual = await ref.get();
      await ref.update({ falhasSeguidas: 5 }, { lastUpdateTime: carimbo(atual) });
      expect((await ref.get()).get('falhasSeguidas')).toBe(5);
    });

    it('a DELETED document fails a lastUpdateTime precondition with 9, NOT 5 — a plain update with 5 — and neither resurrects it', async () => {
      const ref = pollRef();
      await ref.create(docPoll());
      const lido = await ref.get();
      await ref.delete();

      // The fake's claim (`testing/fakeDb.ts`, `APP/CLAUDE.md`): the stamp
      // REPLACES the SDK's default `{ exists: true }`, so the server sees an
      // update-time precondition only, and a document that is gone fails it.
      await expect(
        ref.update({ falhasSeguidas: 1 }, { lastUpdateTime: carimbo(lido) }),
      ).rejects.toMatchObject({ code: 9 });
      // Without the stamp the SDK's `exists` precondition is what fails.
      await expect(ref.update({ falhasSeguidas: 1 })).rejects.toMatchObject({ code: 5 });
      expect((await ref.get()).exists).toBe(false);
    });
  });

  /* ------------------------------ The lease race ----------------------------- */

  describe('two lease takers past the same read (Promise.all): exactly one wins', () => {
    it('on an ABSENT document: one create lands, the other gets 6 and exits with zero calls', async () => {
      await semearConta({ credencial: true });
      const g = comGanchos(db());
      const ambos = barreira(2);
      g.antesDaProximaEscrita(ambos);
      g.antesDaProximaEscrita(ambos);
      const a = run('exec-a', plataforma([]));
      const b = run('exec-b', plataforma([]));

      const [ra, rb] = await Promise.all([executar(g.db, a), executar(g.db, b)]);

      expect([ra.desfecho, rb.desfecho].sort()).toEqual(['janela-vazia', 'lease-ocupado']);
      // Two creates: one landed, one refused 6 — then the winner's final write.
      expect(resumo(g.escritas)).toEqual(['create:6', 'create:ok', 'update:ok']);
      // The loser never reached the platform; the winner made its one call.
      expect([a.plataforma.urls.length, b.plataforma.urls.length].sort()).toEqual([0, 1]);
      // The winner's create anchored the bootstrap, and its final write released the lease.
      const snap = await lerPoll();
      expect(snap.exists).toBe(true);
      expect(snap.data()).toMatchObject({
        cursor: BOOTSTRAP_72H,
        emExecucaoAteMs: 0,
        execucaoId: null,
        falhasSeguidas: 0,
        ultimaVarreduraEmMs: AGORA_MS,
      });
    });

    it('on an EXPIRED lease: one update lands, the other gets 9 and exits with zero calls', async () => {
      await semearConta({ credencial: true });
      await pollRef().set(docPoll({ emExecucaoAteMs: AGORA_MS - 1, execucaoId: 'antigo' }));
      const g = comGanchos(db());
      const ambos = barreira(2);
      g.antesDaProximaEscrita(ambos);
      g.antesDaProximaEscrita(ambos);
      const a = run('exec-a', plataforma([EXEMPLO_164, EXEMPLO_165]));
      const b = run('exec-b', plataforma([EXEMPLO_164, EXEMPLO_165]));

      const [ra, rb] = await Promise.all([executar(g.db, a), executar(g.db, b)]);

      expect([ra.desfecho, rb.desfecho].sort()).toEqual(['lease-ocupado', 'sucesso']);
      // Two lease updates on the SAME stamp: one landed, one refused 9 — then
      // the winner's final write landed.
      expect(resumo(g.escritas)).toEqual(['update:9', 'update:ok', 'update:ok']);
      expect([a.plataforma.urls.length, b.plataforma.urls.length].sort()).toEqual([0, 1]);
      // Only the winner enqueued, and each example row exactly once.
      expect([...a.enfileirados, ...b.enfileirados]).toEqual([
        payload('164', '2022-10-31T12:17:58.949670'),
        payload('165', '2022-10-31T12:28:12.653648'),
      ]);
      const snap = await lerPoll();
      expect(snap.data()).toMatchObject({
        cursor: CURSOR_DOS_EXEMPLOS,
        emExecucaoAteMs: 0,
        execucaoId: null,
        falhasSeguidas: 0,
      });
      expect(snap.get('vistos')).toEqual(VISTOS_DOS_EXEMPLOS);
    });

    it('a lease update that loses to a write landing after its read exits with zero calls, and the write stands', async () => {
      await semearConta({ credencial: true });
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      g.antesDaProximaEscrita(async () => {
        await pollRef().update({ falhasSeguidas: 4 });
      });
      const a = run('exec-a', plataforma([EXEMPLO_164]));

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('lease-ocupado');
      expect(g.escritas).toEqual([{ op: 'update', codigo: 9 }]);
      expect(a.plataforma.urls).toEqual([]);
      expect((await lerPoll()).data()).toMatchObject({
        falhasSeguidas: 4,
        execucaoId: null,
        emExecucaoAteMs: 0,
      });
    });
  });

  /* ---------------------------- The final write ------------------------------ */

  describe('a stale final write', () => {
    it('taken over mid-drain: its final write fails 9 and it writes NOTHING — the taker’s cursor and lease stand', async () => {
      await semearConta({ credencial: true });
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      const tomada = docPoll({
        cursor: CURSOR_POSTERIOR,
        emExecucaoAteMs: AGORA_MS + 600_000,
        execucaoId: 'outro',
        vistos: { '7': '2022-10-31T12:59:00.000000' },
      });
      // While this run drains, another run takes the lease over and moves the cursor on.
      const a = run(
        'exec-a',
        plataforma([EXEMPLO_164, EXEMPLO_165], async () => {
          await pollRef().set(tomada);
        }),
      );

      const r = await executar(g.db, a);

      expect(r).toMatchObject({ desfecho: 'lease-perdido', enfileiradas: 2 });
      // Its lease landed; its final write was refused; nothing was retried over the taker.
      expect(g.escritas).toEqual([
        { op: 'update', codigo: null },
        { op: 'update', codigo: 9 },
      ]);
      const snap = await lerPoll();
      expect(snap.data()).toEqual(tomada);
      expect(alertas(a, 'lease-perdido')).toHaveLength(1);
    });

    it('still ours after a lost precondition: RE-DERIVED from the re-read — max(cursor), merged vistos, the cursor never moves back', async () => {
      await semearConta({ credencial: true });
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      g.antesDaProximaEscrita(() => undefined); // the lease
      g.antesDaProximaEscrita(async () => {
        // Same owner, a later cursor and another entry, landed after the lease:
        // the final write's stamp is stale, but the lease is still this run's.
        await pollRef().update({
          cursor: CURSOR_POSTERIOR,
          vistos: { '7': '2022-10-31T12:59:00.000000' },
        });
      });
      const a = run('exec-a', plataforma([EXEMPLO_164, EXEMPLO_165]));

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('sucesso');
      expect(g.escritas).toEqual([
        { op: 'update', codigo: null },
        { op: 'update', codigo: 9 },
        { op: 'update', codigo: null },
      ]);
      const snap = await lerPoll();
      expect(snap.data()).toMatchObject({
        cursor: CURSOR_POSTERIOR,
        emExecucaoAteMs: 0,
        execucaoId: null,
        falhasSeguidas: 0,
      });
      expect(snap.get('vistos')).toEqual({
        '7': '2022-10-31T12:59:00.000000',
        ...VISTOS_DOS_EXEMPLOS,
      });
    });

    it('the document DELETED mid-drain: the final write fails 9 (not 5), the run writes nothing and never resurrects it', async () => {
      await semearConta({ credencial: true });
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      const a = run(
        'exec-a',
        plataforma([EXEMPLO_164], async () => {
          await pollRef().delete();
        }),
      );

      const r = await executar(g.db, a);

      // A 5 here would escape `isFailedPrecondition` and reject the run instead.
      expect(r.desfecho).toBe('lease-perdido');
      expect(g.escritas).toEqual([
        { op: 'update', codigo: null },
        { op: 'update', codigo: 9 },
      ]);
      expect((await lerPoll()).exists).toBe(false);
      expect(alertas(a, 'lease-perdido')).toHaveLength(1);
    });
  });

  /* ---------------------------- The refusal record --------------------------- */

  describe('the refusal record (an active conta with no credential)', () => {
    it('a HELD lease skips it: the document keeps its version', async () => {
      await semearConta({ credencial: false });
      await pollRef().set(
        docPoll({ emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outro', falhasSeguidas: 2 }),
      );
      const antes = await lerPoll();
      const g = comGanchos(db());
      const a = run('exec-a', plataforma([]));

      const r = await executar(g.db, a);

      expect(r).toMatchObject({
        desfecho: 'recusa-adiada',
        motivo: MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente,
      });
      expect(g.escritas).toEqual([]);
      const depois = await lerPoll();
      expect(carimbo(depois).isEqual(carimbo(antes))).toBe(true);
      expect(depois.data()).toEqual(antes.data());
      expect((await db().collection(AVISOS).doc(chaveImportacaoParada(ID)).get()).exists).toBe(
        false,
      );
    });

    it('near-miss: a FREE lease is counted — and the third count raises the aviso clocked by the record’s own commit', async () => {
      await semearConta({ credencial: false });
      await pollRef().set(docPoll({ falhasSeguidas: 2, execucaoId: null, emExecucaoAteMs: 0 }));
      const g = comGanchos(db());
      const a = run('exec-a', plataforma([]));

      const r = await executar(g.db, a);

      expect(r).toMatchObject({
        desfecho: 'recusa',
        motivo: MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente,
      });
      expect(g.escritas).toEqual([{ op: 'update', codigo: null }]);
      const snap = await lerPoll();
      // Counted, never a cursor, never a lease.
      expect(snap.data()).toMatchObject({
        cursor: CURSOR,
        falhasSeguidas: 3,
        ultimoErro: MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente,
        ultimaVarreduraEmMs: AGORA_MS,
        emExecucaoAteMs: 0,
        execucaoId: null,
      });
      const aviso = await db().collection(AVISOS).doc(chaveImportacaoParada(ID)).get();
      expect(aviso.exists).toBe(true);
      expect(aviso.data()).toMatchObject({
        resolvidoEm: null,
        params: { loja: NOME, motivo: MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente },
        // The record was the last write to the poll document: its commit time
        // is the poll document's version now, and the aviso's clock.
        relogioEvento: relogioDoDocumentoUs(carimbo(snap)),
      });
    });

    it('a lease taken between its read and its write: 9 on the real server, the record skipped, the lease untouched', async () => {
      await semearConta({ credencial: false });
      await pollRef().set(docPoll({ falhasSeguidas: 1 }));
      const g = comGanchos(db());
      const lease = { emExecucaoAteMs: AGORA_MS + DURACAO_LEASE_POLL_MS, execucaoId: 'outro' };
      g.antesDaProximaEscrita(async () => {
        await pollRef().update(lease);
      });
      const a = run('exec-a', plataforma([]));

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('recusa-adiada');
      expect(g.escritas).toEqual([{ op: 'update', codigo: 9 }]);
      expect((await lerPoll()).data()).toMatchObject({ ...lease, falhasSeguidas: 1 });
    });

    it('an absent document whose create loses to another run’s first lease: 6, the record skipped', async () => {
      await semearConta({ credencial: false });
      const g = comGanchos(db());
      const primeiroLease = docPoll({
        cursor: BOOTSTRAP_72H,
        emExecucaoAteMs: AGORA_MS + DURACAO_LEASE_POLL_MS,
        execucaoId: 'outro',
      });
      g.antesDaProximaEscrita(async () => {
        await pollRef().create(primeiroLease);
      });
      const a = run('exec-a', plataforma([]));

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('recusa-adiada');
      expect(g.escritas).toEqual([{ op: 'create', codigo: 6 }]);
      expect((await lerPoll()).data()).toEqual(primeiroLease);
    });
  });
});

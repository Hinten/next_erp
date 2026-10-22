/**
 * The backstop poll's LEASE and PRECONDITIONS on a real Firestore — the emulator
 * of `ci-amazon.yml`, not the in-memory fake (step-3/4 plan PR 4-b).
 *
 * Every write the poll makes to `pollPedidosAmazon/{id}` is a native
 * precondition on ONE document (root rule 7, tier 1): `create`, or
 * `update(…, { lastUpdateTime })`. The offline suite (`pollPedidos.test.ts`)
 * proves the decisions against `testing/fakeDb.ts`, which MODELS how the server
 * applies those preconditions. This file proves the model on the real server:
 *
 *  - the primitives answer with the codes the poll narrows on: `create` on an
 *    existing document 6 (ALREADY_EXISTS); a stale `lastUpdateTime` 9
 *    (FAILED_PRECONDITION); a plain `update` of a missing document 5
 *    (NOT_FOUND) — and a stamped `update` of a DELETED document 9, not 5, as the
 *    fake claims (the stamp REPLACES the SDK's default `{ exists: true }`);
 *  - a full lease → final-write cycle, on an absent document (the bootstrap
 *    anchored in the lease's `create`) and on an expired lease (`update`);
 *  - the RE-DERIVE branch: a concurrent write between the lease and the final
 *    write (same owner) fails the final write 9, and the retry derives from the
 *    re-read — `max(cursor)`, merged `vistos` — never the captured patch; a
 *    taken-over lease writes NOTHING;
 *  - the poll's FIRST write losing to another writer that landed between the
 *    poll's read and that write: the lease (`update` 9, `create` 6) and the
 *    refusal record (the same two) each give up, write nothing and leave the
 *    winner's state standing.
 *
 * What runs for real: the context loader, the package client and the
 * `searchOrders` helper, the poll, the collection handle — all against the
 * emulator. What is injected: Amazon (a scripted `fetch` serving rows built from
 * the BR sandbox fixture), the queue (a recorder), the clock. The read switch is
 * ON only as a PARAMETER (`ambiente`), never through `process.env`: the setup
 * refuses the variable, and the case asserts the process still has it off.
 *
 * ⚠️ The interleavings. A real Firestore offers no "between your read and your
 * write" hook, so {@link comGanchos} wraps the Admin `Firestore` in a Proxy that
 * records every `create`/`update` of the poll document and the server's answer
 * to it — the emulator's counterpart of the fake's write log — and can run ONE
 * concurrent writer just before the first of them. Everything else passes
 * straight through to the real SDK objects. Concurrent writers write through the
 * UNWRAPPED handle, so they are never counted.
 *
 * ⚠️ No network: the global `fetch` is wrapped to record, and each test ends by
 * asserting no request left for a non-local host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
  pollPedidosAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import type { ContaAmazonResumo } from '../core/contas';
import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import type { PayloadNotificacaoAmazon } from '../notificacoes/notificacao';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  HORA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '../testing/fixtures';
import { LOOKBACK_POLL_ENV_AMAZON } from './janelaPoll';
import { LEASE_POLL_MS, ORCAMENTO_CONTA_MS } from './orcamentoPoll';
import {
  type DepsPollAmazon,
  type ResultadoContaPollAmazon,
  executarContaPollAmazon,
} from './pollPedidos';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const POLL = 'pollPedidosAmazon';
const CONTAS = 'integracao';
const AVISOS = 'avisos';
const NOTIF = 'notificacoesAmazon';

/** An obviously fake conta id, distinct from every other emulator suite's. */
const ID = 'conta-amazon-poll-lease-ci';
const NOME = 'Conta de teste';
const MINUTO_MS = 60_000;

/** The run's clock: 2026-10-20T12:00:00Z. */
const AGORA = Date.UTC(2026, 9, 20, 12, 0, 0);
/** The stored cursor of a conta already polling, and the window it asks for (−10 min). */
const CURSOR = AGORA - 2 * HORA_MS;
const JANELA_DO_CURSOR = '2026-10-20T09:50:00Z';
/** A cursorless conta's bootstrap (the default 24 h), and its window. */
const BOOTSTRAP = AGORA - 24 * HORA_MS;
const JANELA_DO_BOOTSTRAP = '2026-10-19T11:50:00Z';

/** Two orders changed inside both windows; the cursor lands on the later one (below the 5-min cap). */
const PEDIDO_A = '000-0000000-0000101';
const PEDIDO_B = '000-0000000-0000102';
const A_MS = AGORA - 30 * MINUTO_MS;
const B_MS = AGORA - 20 * MINUTO_MS;
/** What another writer of the SAME run left behind: a later cursor and an order of its own. */
const CURSOR_POSTERIOR = AGORA - 10 * MINUTO_MS;
const PEDIDO_C = '000-0000000-0000103';
const C_MS = AGORA - 12 * MINUTO_MS;

const iso = (ms: number) => new Date(ms).toISOString();

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
function linha(orderId: string, ms: number): Record<string, unknown> {
  return { ...structuredClone(ORDEM_DO_EXEMPLO), orderId, lastUpdatedTime: iso(ms) };
}

/* ------------------------------------ setup ------------------------------------ */

function db(): Firestore {
  return getAdminFirestore();
}

function pollRef(): DocumentReference {
  return db().collection(POLL).doc(ID);
}

/** A snapshot's commit stamp — present on every snapshot of an existing document. */
function carimbo(snap: DocumentSnapshot): Timestamp {
  if (snap.updateTime === undefined) {
    throw new Error(`teste: ${snap.ref.path} não existe — não há updateTime`);
  }
  return snap.updateTime;
}

/** A poll document as the poll leaves one between runs, from the schema's defaults. */
function docPoll(over: DocumentData = {}): DocumentData {
  return pollPedidosAmazonSchema.parse({ cursorMs: CURSOR, ...over });
}

/** An active conta connected to `SPID_A`, with a credential whose access token is far from expiry. */
async function semearConta(): Promise<void> {
  await db().doc(caminhoConta(ID)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: NOME,
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
  });
  await db()
    .doc(caminhoCredencial(ID))
    .set(credencialDoc({ expirationDate: AGORA + 365 * DIA_MS }));
}

async function limpar(): Promise<void> {
  for (const colecao of [POLL, CONTAS, AVISOS, NOTIF]) {
    await db().recursiveDelete(db().collection(colecao));
  }
}

/* -------------------------------------------------------------------------- */
/*                  The real Firestore, with ONE observation seam              */
/* -------------------------------------------------------------------------- */

type OperacaoDeEscrita = 'create' | 'update';

/** One `create`/`update` of the poll document and how the SERVER answered it. */
interface EscritaObservada {
  readonly op: OperacaoDeEscrita;
  /** `null` when it landed; the gRPC status code when the server refused it. */
  readonly codigo: number | null;
}

/** A property of a real SDK object, methods bound to it (they read private state off `this`). */
function encaminhar(alvo: object, prop: string | symbol): unknown {
  const valor: unknown = Reflect.get(alvo, prop, alvo);
  return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
}

/**
 * The real database, recording every `create`/`update` of the poll document.
 * `antesDaPrimeiraEscrita` runs ONCE, before the first of them reaches the
 * server: the window between the poll's read of the document and its own write.
 */
function comGanchos(
  real: Firestore,
  antesDaPrimeiraEscrita?: () => Promise<void>,
): { db: Firestore; escritas: EscritaObservada[] } {
  const escritas: EscritaObservada[] = [];
  let gancho = antesDaPrimeiraEscrita;

  async function escrever(
    op: OperacaoDeEscrita,
    ref: DocumentReference,
    args: unknown[],
  ): Promise<WriteResult> {
    if (gancho !== undefined) {
      const concorrente = gancho;
      gancho = undefined;
      await concorrente();
    }
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

  return { db: proxy, escritas };
}

/** The writes as `<op>:<code | ok>`, in the order the server answered them. */
function resumo(escritas: readonly EscritaObservada[]): string[] {
  return escritas.map((e) => `${e.op}:${e.codigo === null ? 'ok' : String(e.codigo)}`);
}

/* -------------------------------------------------------------------------- */
/*                          Amazon, scripted; one run                          */
/* -------------------------------------------------------------------------- */

interface Run {
  /** Every `searchOrders` request the scripted platform answered. */
  readonly requisicoes: URL[];
  /** Every request that was NOT a `searchOrders` GET (an LWA exchange, anything else). */
  readonly outras: string[];
  readonly enfileirados: PayloadNotificacaoAmazon[];
  readonly deps: DepsPollAmazon;
  readonly linhas: ReturnType<typeof loggerEspiao>['linhas'];
}

/**
 * One run: Amazon answers ONE page holding `rows` and no `nextToken`.
 * `aoChamar` runs before the answer — the window a concurrent writer lands in,
 * after the lease and before the final write.
 */
function run(
  execucaoId: string,
  rows: readonly Record<string, unknown>[],
  aoChamar: () => Promise<void> = () => Promise.resolve(),
): Run {
  const requisicoes: URL[] = [];
  const outras: string[] = [];
  const enfileirados: PayloadNotificacaoAmazon[] = [];
  const espiao = loggerEspiao();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== '/orders/2026-01-01/orders') {
      outras.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      throw new TypeError('teste: só searchOrders é servido aqui');
    }
    requisicoes.push(url);
    await aoChamar();
    return new Response(JSON.stringify({ orders: rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    requisicoes,
    outras,
    enfileirados,
    linhas: espiao.linhas,
    deps: {
      // ⚠️ ON as a PARAMETER — never through process.env (module header).
      ambiente: AMBIENTE_LIGADO,
      importadorPresente: true,
      agendador: {
        enfileirar: (p) => {
          enfileirados.push(p);
          return Promise.resolve();
        },
      },
      agora: () => AGORA,
      increment: (by) => FieldValue.increment(by),
      logger: espiao.logger,
      gerarExecucaoId: () => execucaoId,
      esperar: () => Promise.reject(new Error('teste: a varredura nunca espera')),
      fetch,
      gerarCorrelationId: () => 'corr-poll-ci',
    },
  };
}

const CONTA: ContaAmazonResumo = { integracaoId: ID, nome: NOME, ativo: true };

function executar(alvo: Firestore, r: Run): Promise<ResultadoContaPollAmazon> {
  return executarContaPollAmazon(alvo, CONTA, ORCAMENTO_CONTA_MS, r.deps);
}

function payload(amazonOrderId: string, ms: number): PayloadNotificacaoAmazon {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
    sellerId: SPID_A,
    amazonOrderId,
    contaId: ID,
    lastUpdatedUs: ms * 1000,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The suite                                 */
/* -------------------------------------------------------------------------- */

describe.skipIf(!EMULATED)('the backstop poll’s lease and preconditions on real Firestore', () => {
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
    // Nothing left the process: not Amazon, not anything else.
    const naoLocais = redeGlobal.filter((u) => {
      const { hostname } = new URL(u);
      return hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]';
    });
    redeGlobal.length = 0;
    expect(naoLocais).toEqual([]);
  });

  // The emulator is shared with every file that runs after this one: leave no
  // conta, poll document or aviso behind.
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

    it('a plain update of a MISSING document → 5; a stamped update of a DELETED one → 9, not 5 — and neither creates it', async () => {
      const ref = pollRef();
      await expect(ref.update({ falhasSeguidas: 1 })).rejects.toMatchObject({ code: 5 });

      await ref.create(docPoll());
      const lido = await ref.get();
      await ref.delete();
      // The fake's claim (`testing/fakeDb.ts`): the stamp REPLACES the SDK's
      // default `{ exists: true }`, so the server checks only the update time,
      // and a document that is gone fails it with 9.
      await expect(
        ref.update({ falhasSeguidas: 1 }, { lastUpdateTime: carimbo(lido) }),
      ).rejects.toMatchObject({ code: 9 });
      expect((await ref.get()).exists).toBe(false);
    });
  });

  /* ---------------------------- The full cycle ------------------------------- */

  describe('a full lease → final-write cycle', () => {
    it('on an ABSENT document: the lease creates it anchored at now − 24 h; the final write advances the cursor and releases the lease', async () => {
      // D11: the switch is on only in the literal the run carries.
      expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
      await semearConta();
      const g = comGanchos(db());
      const a = run('exec-a', [linha(PEDIDO_A, A_MS), linha(PEDIDO_B, B_MS)]);

      const r = await executar(g.db, a);

      expect(r).toMatchObject({ desfecho: 'sucesso', enfileiradas: 2, persistidas: 0, paginas: 1 });
      expect(resumo(g.escritas)).toEqual(['create:ok', 'update:ok']);
      // The window was built from the bootstrap the lease's create anchored.
      expect(a.requisicoes.map((u) => u.searchParams.get('lastUpdatedAfter'))).toEqual([
        JANELA_DO_BOOTSTRAP,
      ]);
      expect(a.outras).toEqual([]);
      expect(a.enfileirados).toEqual([payload(PEDIDO_A, A_MS), payload(PEDIDO_B, B_MS)]);
      const snap = await pollRef().get();
      expect(snap.exists).toBe(true);
      expect(pollPedidosAmazonSchema.parse(snap.data())).toEqual({
        cursorMs: B_MS,
        pendente: null,
        vistos: { [PEDIDO_A]: A_MS * 1000, [PEDIDO_B]: B_MS * 1000 },
        emExecucaoAteMs: 0,
        execucaoId: null,
        ultimaVarreduraEmMs: AGORA,
        ultimoErro: null,
        falhasSeguidas: 0,
      });
      // The bootstrap anchor never moved backwards: the cursor is past it.
      expect(B_MS).toBeGreaterThan(BOOTSTRAP);
    });

    it('on an EXPIRED lease: one stamped update takes it, the window comes from the STORED cursor, and the final write lands', async () => {
      await semearConta();
      await pollRef().set(docPoll({ emExecucaoAteMs: AGORA - 1, execucaoId: 'antigo' }));
      const g = comGanchos(db());
      const a = run('exec-a', [linha(PEDIDO_A, A_MS), linha(PEDIDO_B, B_MS)]);

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('sucesso');
      expect(resumo(g.escritas)).toEqual(['update:ok', 'update:ok']);
      expect(a.requisicoes.map((u) => u.searchParams.get('lastUpdatedAfter'))).toEqual([
        JANELA_DO_CURSOR,
      ]);
      expect((await pollRef().get()).data()).toMatchObject({
        cursorMs: B_MS,
        emExecucaoAteMs: 0,
        execucaoId: null,
      });
    });

    it('near-miss: a HELD lease is left alone — no write, no request', async () => {
      await semearConta();
      const held = docPoll({ emExecucaoAteMs: AGORA + LEASE_POLL_MS, execucaoId: 'outro' });
      await pollRef().set(held);
      const antes = await pollRef().get();
      const g = comGanchos(db());
      const a = run('exec-a', [linha(PEDIDO_A, A_MS)]);

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('lease-ocupado');
      expect(g.escritas).toEqual([]);
      expect(a.requisicoes).toEqual([]);
      expect(carimbo(await pollRef().get()).isEqual(carimbo(antes))).toBe(true);
    });
  });

  /* ---------------------------- The re-derive branch ------------------------- */

  describe('a concurrent write between the lease and the final write', () => {
    it('★ still ours: the final write fails 9, and the retry is RE-DERIVED from the re-read — max(cursor), merged vistos', async () => {
      await semearConta();
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      // Same owner, a LATER cursor and an order of its own, landed after the
      // lease (through the unwrapped handle): the final write's stamp is stale,
      // but the lease is still this run's.
      const a = run('exec-a', [linha(PEDIDO_A, A_MS), linha(PEDIDO_B, B_MS)], async () => {
        await pollRef().update({
          cursorMs: CURSOR_POSTERIOR,
          vistos: { [PEDIDO_C]: C_MS * 1000 },
        });
      });

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('sucesso');
      expect(resumo(g.escritas)).toEqual(['update:ok', 'update:9', 'update:ok']);
      const estado = pollPedidosAmazonSchema.parse((await pollRef().get()).data());
      // The captured patch would have written B_MS over the later cursor.
      expect(estado.cursorMs).toBe(CURSOR_POSTERIOR);
      expect(estado.vistos).toEqual({
        [PEDIDO_A]: A_MS * 1000,
        [PEDIDO_B]: B_MS * 1000,
        [PEDIDO_C]: C_MS * 1000,
      });
      expect(estado).toMatchObject({ emExecucaoAteMs: 0, execucaoId: null, falhasSeguidas: 0 });
    });

    it('near-miss: TAKEN OVER mid-drain — the final write fails 9 and the run writes NOTHING; the taker’s state stands', async () => {
      await semearConta();
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      const tomada = docPoll({
        cursorMs: CURSOR_POSTERIOR,
        emExecucaoAteMs: AGORA + LEASE_POLL_MS,
        execucaoId: 'outro',
        vistos: { [PEDIDO_C]: C_MS * 1000 },
      });
      const a = run('exec-a', [linha(PEDIDO_A, A_MS), linha(PEDIDO_B, B_MS)], async () => {
        await pollRef().set(tomada);
      });

      const r = await executar(g.db, a);

      expect(r).toMatchObject({ desfecho: 'lease-perdido', enfileiradas: 2 });
      // Its lease landed, its final write was refused, nothing was retried over the taker.
      expect(resumo(g.escritas)).toEqual(['update:ok', 'update:9']);
      expect((await pollRef().get()).data()).toEqual(tomada);
      expect(a.linhas.filter((l) => l.meta?.alerta === 'lease-perdido')).toHaveLength(1);
    });

    it('the document DELETED mid-drain: 9 (not 5) on the real server, nothing written, never resurrected', async () => {
      await semearConta();
      await pollRef().set(docPoll());
      const g = comGanchos(db());
      const a = run('exec-a', [linha(PEDIDO_A, A_MS)], async () => {
        await pollRef().delete();
      });

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('lease-perdido');
      expect(resumo(g.escritas)).toEqual(['update:ok', 'update:9']);
      expect((await pollRef().get()).exists).toBe(false);
    });
  });

  /* ------------------ Another writer before the poll's FIRST write ------------------ */

  describe('another writer between the poll’s read and its FIRST write', () => {
    /** Another run's lease: the state that must stand. */
    const LEASE_ALHEIO = { execucaoId: 'outro', emExecucaoAteMs: AGORA + LEASE_POLL_MS };
    /** Another run's refusal record, landed first. */
    const RECUSA_ALHEIA = {
      falhasSeguidas: 1,
      ultimoErro: MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido,
      ultimaVarreduraEmMs: AGORA - MINUTO_MS,
    };

    /** One run whose look-back is invalid: a cursorless document is REFUSED, never leased. */
    function executarSemLookback(alvo: Firestore, r: Run): Promise<ResultadoContaPollAmazon> {
      return executarContaPollAmazon(alvo, CONTA, ORCAMENTO_CONTA_MS, {
        ...r.deps,
        ambiente: { ...AMBIENTE_LIGADO, [LOOKBACK_POLL_ENV_AMAZON]: '1e2' },
      });
    }

    it('★ an EXPIRED lease taken first by another run: the lease update fails 9 — lease-ocupado, no request, the taker’s lease stands', async () => {
      await semearConta();
      await pollRef().set(docPoll({ emExecucaoAteMs: AGORA - 1, execucaoId: 'antigo' }));
      const g = comGanchos(db(), async () => {
        await pollRef().update(LEASE_ALHEIO);
      });
      const a = run('exec-a', [linha(PEDIDO_A, A_MS)]);

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('lease-ocupado');
      expect(resumo(g.escritas)).toEqual(['update:9']);
      expect(a.requisicoes).toEqual([]);
      expect(a.enfileirados).toEqual([]);
      expect(pollPedidosAmazonSchema.parse((await pollRef().get()).data())).toEqual(
        docPoll(LEASE_ALHEIO),
      );
    });

    it('an ABSENT document created first by another run: the lease create fails 6 — lease-ocupado, the creator’s document stands', async () => {
      await semearConta();
      const doOutro = docPoll(LEASE_ALHEIO);
      const g = comGanchos(db(), async () => {
        await pollRef().create(doOutro);
      });
      const a = run('exec-a', [linha(PEDIDO_A, A_MS)]);

      const r = await executar(g.db, a);

      expect(r.desfecho).toBe('lease-ocupado');
      expect(resumo(g.escritas)).toEqual(['create:6']);
      expect(a.requisicoes).toEqual([]);
      expect((await pollRef().get()).data()).toEqual(doOutro);
    });

    it('★ a REFUSAL record losing to another run’s record: update 9 — recusa-adiada, the winner’s count stands, no aviso', async () => {
      await semearConta();
      await pollRef().set(docPoll({ cursorMs: null }));
      const g = comGanchos(db(), async () => {
        await pollRef().update(RECUSA_ALHEIA);
      });
      const a = run('exec-a', []);

      const r = await executarSemLookback(g.db, a);

      expect(r).toMatchObject({
        desfecho: 'recusa-adiada',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido,
      });
      expect(resumo(g.escritas)).toEqual(['update:9']);
      expect(a.requisicoes).toEqual([]);
      expect(pollPedidosAmazonSchema.parse((await pollRef().get()).data())).toEqual(
        docPoll({ cursorMs: null, ...RECUSA_ALHEIA }),
      );
      expect((await db().collection(AVISOS).get()).empty).toBe(true);
    });

    it('a REFUSAL record on an ABSENT document created first by another run: create 6 — recusa-adiada, the creator’s document stands', async () => {
      await semearConta();
      const doOutro = docPoll({ cursorMs: null, ...RECUSA_ALHEIA });
      const g = comGanchos(db(), async () => {
        await pollRef().create(doOutro);
      });
      const a = run('exec-a', []);

      const r = await executarSemLookback(g.db, a);

      expect(r.desfecho).toBe('recusa-adiada');
      expect(resumo(g.escritas)).toEqual(['create:6']);
      expect((await pollRef().get()).data()).toEqual(doOutro);
      expect((await db().collection(AVISOS).get()).empty).toBe(true);
    });

    it('near-miss: with NO other writer the same refusal record lands under its stamp — counted once, aviso raised', async () => {
      await semearConta();
      await pollRef().set(docPoll({ cursorMs: null }));
      const g = comGanchos(db());
      const a = run('exec-a', []);

      const r = await executarSemLookback(g.db, a);

      expect(r.desfecho).toBe('recusa');
      expect(resumo(g.escritas)).toEqual(['update:ok']);
      expect(pollPedidosAmazonSchema.parse((await pollRef().get()).data())).toEqual(
        docPoll({
          cursorMs: null,
          falhasSeguidas: 1,
          ultimoErro: MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido,
          ultimaVarreduraEmMs: AGORA,
        }),
      );
      const avisos = await db().collection(AVISOS).get();
      expect(avisos.size).toBe(1);
      expect(avisos.docs[0]?.get('params')).toMatchObject({
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido,
      });
    });
  });
});

/**
 * The feed LEASE's I/O on a REAL Firestore — the emulator of `ci-amazon.yml`
 * (step 12a, PR 12-c). The pure state machine is proved offline
 * (`vezFeed.test.ts`); this file proves, on the real server, that every write
 * is tier 1 and re-decided when it loses:
 *
 *  - a lost `create` (ALREADY_EXISTS) and a lost `update` precondition
 *    (FAILED_PRECONDITION) are RE-READ and RE-DECIDED, never re-applied;
 *  - three losses in a row are `AmazonVezFeedEmConflitoError`, two are not;
 *  - a release by a non-holder writes nothing;
 *  - the pending start is MIN-merged, never overwritten;
 *  - the NAMED `vez` recovery is enqueued BEFORE the write that consumes the
 *    start, a smaller start found on a re-read gets its own, and an enqueue
 *    that throws leaves the lease untouched.
 *
 * The interleavings are made with a hooked Firestore handle (the NEXT write of
 * the lease waits for a concurrent writer first); everything else is the real
 * SDK against the real emulator. No network and no Cloud Tasks: the `vez`
 * enqueue is a recording function, and nothing here calls Amazon (D11).
 *
 * ⚠️ The emulator is SHARED: the lease's conta id is seeded by no other suite,
 * every case wipes the one document this file writes first, and the file leaves
 * nothing behind. The lease is not a trigger path, so no function fires.
 */
import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import { FLUXO_FEED_AMAZON, type VezFeedAmazon, idVezFeedAmazon } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  type TarefaEnviarFeedAmazon,
  nomeRecuperacaoFeed,
  referenciaVezFeed,
  tarefaEnviarFeedAmazonSchema,
} from './tarefaLote';
import { VALIDADE_VEZ_ENVIADO_MS, VALIDADE_VEZ_MS } from './vezFeed';
import {
  type AlvoVezFeed,
  AmazonVezFeedEmConflitoError,
  AmazonVezFeedInvalidaError,
  MAX_TENTATIVAS_VEZ_FEED,
  type RecuperacaoVezFeed,
  consumirPendenteVezFeed,
  entrarNaVezFeed,
  expirarIncertoVezFeed,
  lerVezFeed,
  liberarVezFeed,
  marcarEnviadoVezFeed,
  marcarEnviandoVezFeed,
  voltarParaMontandoVezFeed,
} from './vezFeedFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds. */
const CONTA = 'conta-amazon-vez-feed-ci';
const ALVO: AlvoVezFeed = { fluxo: FLUXO_FEED_AMAZON.estoque, contaId: CONTA };
const CAMINHO = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;

/** Our clock (ms), fixed: every decision here reads it. */
const AGORA = 1_800_000_000_000;
const agora = () => AGORA;
const MIN = 60_000;

const FEED = '50001234567';
const DONO = 'exec-dono-ci';
const PENDENTE = AGORA - 15 * MIN;

function db(): Firestore {
  return getAdminFirestore();
}

/** A failure of the caller's own enqueue: its class, so the test tells it from the SDK's. */
class FalhaDoEnfileiramentoDeTeste extends Error {
  constructor() {
    super('teste: o enqueue da recuperação vez falhou');
    this.name = 'FalhaDoEnfileiramentoDeTeste';
  }
}

/* ------------------------------ the hooked handle ------------------------------ */

/** The NEXT `create`/`update` of the lease first waits for a concurrent writer. */
interface Gancho {
  readonly metodo: 'update' | 'create';
  readonly antes: () => Promise<unknown>;
}

/** Bind every other member to the real target (the SDK reads its own fields through `this`). */
function membro(alvo: object, prop: string | symbol): unknown {
  const v: unknown = Reflect.get(alvo, prop, alvo);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
}

/**
 * The real Firestore, except that each lease write first runs the FIRST hook
 * of its method (through the REAL handle) — the window between a read and its
 * write. Each hook fires once.
 */
function comGanchos(real: Firestore, ganchos: Gancho[]): Firestore {
  const doc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop === 'update' || prop === 'create') {
          return async (...args: unknown[]) => {
            const i = ganchos.findIndex((g) => alvo.path === CAMINHO && g.metodo === prop);
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

const ref = () => db().doc(CAMINHO);

async function limpar(): Promise<void> {
  await ref().delete();
}

/** A whole lease, through the schema (unset fields take their defaults). */
function vez(campos: Partial<VezFeedAmazon> = {}): VezFeedAmazon {
  return vezFeedAmazonCollection.parse({
    estado: 'livre',
    ateMs: 0,
    atualizadoEmMs: AGORA - 60 * MIN,
    ...campos,
  });
}

/** Another run building its batch, unexpired. */
const montandoDe = (execucaoId: string, campos: Partial<VezFeedAmazon> = {}) =>
  vez({
    estado: 'montando',
    execucaoId,
    ateMs: AGORA + VALIDADE_VEZ_MS,
    atualizadoEmMs: AGORA - MIN,
    origem: 'reconciliacao',
    tipoLote: 'blocos',
    ...campos,
  });

/** The feed `FEED`, submitted a minute ago by `DONO`: a fresh holder. */
const enviado = (campos: Partial<VezFeedAmazon> = {}) =>
  vez({
    estado: 'enviado',
    execucaoId: DONO,
    feedId: FEED,
    snapshotEmMs: AGORA - 2 * MIN,
    antesDoEnvioMs: AGORA - MIN,
    mensagens: 40,
    bytes: 4_000,
    ateMs: AGORA - MIN + VALIDADE_VEZ_ENVIADO_MS,
    atualizadoEmMs: AGORA - MIN,
    origem: 'delta',
    tipoLote: 'janela',
    janela: {
      desdeMs: AGORA - 30 * MIN,
      ateMs: AGORA - 25 * MIN,
      manterDesdeMs: AGORA - 30 * MIN,
      commitAposMs: null,
      depositoId: 'deposito-ci',
    },
    ultimoEnvioMs: AGORA - MIN,
    ...campos,
  });

async function semear(v: VezFeedAmazon): Promise<void> {
  await ref().set(v);
}

async function lido() {
  const snap = await ref().get();
  expect(snap.exists).toBe(true);
  return { dados: snap.data() as VezFeedAmazon, updateTime: snap.updateTime };
}

/** A TICK-born window batch of `execucaoId` starting at `desdeMs`. */
function janelaDoTick(execucaoId: string, desdeMs: number): TarefaEnviarFeedAmazon {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'estoque',
    contaId: CONTA,
    execucaoId,
    origem: 'delta',
    lote: {
      tipo: 'janela',
      desdeMs,
      ateMs: desdeMs + 5 * MIN,
      manterDesdeMs: desdeMs,
      commitAposMs: null,
      esperaAteMs: null,
      depositoId: 'deposito-ci',
    },
  });
}

/** A BLOCK batch of `execucaoId`. */
function blocos(execucaoId: string): TarefaEnviarFeedAmazon {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'estoque',
    contaId: CONTA,
    execucaoId,
    origem: 'reconciliacao',
    lote: { tipo: 'blocos', partes: 2, esperaAteMs: AGORA + 6 * 60 * MIN },
  });
}

/** A `vez` enqueue that records what it was handed and the lease as it stood at that moment. */
function enfileiramentoGravador() {
  const vistos: { readonly recuperacao: RecuperacaoVezFeed; readonly vez: VezFeedAmazon }[] = [];
  const enfileirarVez = vi.fn(async (recuperacao: RecuperacaoVezFeed) => {
    const snap = await ref().get();
    vistos.push({ recuperacao, vez: snap.data() as VezFeedAmazon });
  });
  return { enfileirarVez, vistos };
}

/** A concurrent writer that only moves the lease's clock (the precondition alone loses). */
const tocar = (n: number) => () => ref().update({ atualizadoEmMs: AGORA - 60 * MIN + n });

/* ---------------------------------- the cases ---------------------------------- */

describe.skipIf(!EMULATED)('the feed lease on real Firestore (emulator)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('reads the lease: absent ⇒ no document and no updateTime, but a readTime; present ⇒ parsed with both stamps', async () => {
    const ausente = await lerVezFeed(db(), ALVO);
    expect(ausente.vez).toBeNull();
    expect(ausente.updateTime).toBeNull();
    expect(typeof ausente.readTime.toMillis()).toBe('number');

    await semear(enviado());
    const presente = await lerVezFeed(db(), ALVO);
    expect(presente.vez).toMatchObject({ estado: 'enviado', feedId: FEED, execucaoId: DONO });
    expect(presente.updateTime?.isEqual((await lido()).updateTime!)).toBe(true);
    expect(presente.readTime.toMillis()).toBeGreaterThanOrEqual(presente.updateTime!.toMillis());
  });

  it('★ a lost create (ALREADY_EXISTS) ⇒ re-read and re-decided: the batch is recorded behind the run that won', async () => {
    const ganchos: Gancho[] = [
      { metodo: 'create', antes: () => ref().create(montandoDe('exec-vencedor-ci')) },
    ];
    const r = await entrarNaVezFeed(
      comGanchos(db(), ganchos),
      janelaDoTick('exec-perdedor-ci', PENDENTE),
      { agora },
    );

    expect(ganchos).toEqual([]);
    expect(r).toMatchObject({
      tipo: 'pendente-registrado',
      tomada: { tipo: 'ocupada' },
      pendenteDesdeMs: PENDENTE,
      escrito: true,
    });
    const { dados } = await lido();
    expect(dados).toMatchObject({
      estado: 'montando',
      execucaoId: 'exec-vencedor-ci',
      pendenteDesdeMs: PENDENTE,
    });
  });

  it('NEAR-MISS (anti-vacuity): without the race the same batch TAKES the lease, creating it', async () => {
    const r = await entrarNaVezFeed(db(), janelaDoTick('exec-perdedor-ci', PENDENTE), { agora });

    expect(r).toMatchObject({ tipo: 'tomada', sonda: false });
    const { dados } = await lido();
    expect(dados).toMatchObject({
      estado: 'montando',
      execucaoId: 'exec-perdedor-ci',
      ateMs: AGORA + VALIDADE_VEZ_MS,
      pendenteDesdeMs: null,
      falhasSeguidas: 0,
    });
  });

  it('★ a concurrent take between the read and the update ⇒ 9 ⇒ re-decided: recorded behind the winner, its counts kept', async () => {
    await semear(
      vez({
        falhasSeguidas: 1,
        ultimaFalhaEmMs: AGORA - 10 * MIN,
        ultimoEnvioMs: AGORA - 10 * MIN,
      }),
    );
    const ganchos: Gancho[] = [
      {
        metodo: 'update',
        antes: () =>
          ref().update({
            estado: 'montando',
            execucaoId: 'exec-vencedor-ci',
            ateMs: AGORA + VALIDADE_VEZ_MS,
            atualizadoEmMs: AGORA,
          }),
      },
    ];
    const r = await entrarNaVezFeed(
      comGanchos(db(), ganchos),
      janelaDoTick('exec-perdedor-ci', PENDENTE),
      { agora },
    );

    expect(ganchos).toEqual([]);
    expect(r).toMatchObject({
      tipo: 'pendente-registrado',
      pendenteDesdeMs: PENDENTE,
      escrito: true,
    });
    const { dados } = await lido();
    expect(dados).toMatchObject({
      estado: 'montando',
      execucaoId: 'exec-vencedor-ci',
      pendenteDesdeMs: PENDENTE,
      falhasSeguidas: 1,
    });
  });

  it('NEAR-MISS: a BLOCK batch that loses the same race writes nothing at all (it waits)', async () => {
    await semear(vez({ ultimoEnvioMs: AGORA - 10 * MIN }));
    const ganchos: Gancho[] = [
      {
        metodo: 'update',
        antes: () =>
          ref().update({
            estado: 'montando',
            execucaoId: 'exec-vencedor-ci',
            ateMs: AGORA + VALIDADE_VEZ_MS,
            // Not our clock: a write of the loser's own stamp would move the document.
            atualizadoEmMs: AGORA - 1,
          }),
      },
    ];
    const r = await entrarNaVezFeed(comGanchos(db(), ganchos), blocos('exec-perdedor-ci'), {
      agora,
    });
    const depoisDoVencedor = await lido();

    expect(r).toMatchObject({
      tipo: 'recusada',
      tomada: { tipo: 'ocupada' },
      destino: { tipo: 'aguardar' },
    });
    expect(depoisDoVencedor.dados).toMatchObject({
      execucaoId: 'exec-vencedor-ci',
      pendenteDesdeMs: null,
      atualizadoEmMs: AGORA - 1,
    });
    // The winner's write is the last one: the loser added nothing.
    expect(r.lida.updateTime?.isEqual(depoisDoVencedor.updateTime!)).toBe(true);
  });

  it.each<[string, Partial<VezFeedAmazon>, string]>([
    ['a slow holder (≥ 30 min)', { antesDoEnvioMs: AGORA - 31 * MIN }, 'ocupada-lenta'],
    ['an overdue holder (≥ 12 h)', { antesDoEnvioMs: AGORA - 12 * 60 * MIN }, 'ocupada-vencida'],
  ])(
    '★ a window batch routed to patches behind %s writes NOTHING (the handler hands its members on)',
    async (_c, campos, motivo) => {
      await semear(enviado({ ...campos, pendenteDesdeMs: PENDENTE }));
      const antes = await lido();

      const r = await entrarNaVezFeed(db(), janelaDoTick('exec-a-ci', PENDENTE - MIN), { agora });

      expect(r).toMatchObject({
        tipo: 'recusada',
        destino: { tipo: 'repassar-para-patches', motivo },
      });
      const depois = await lido();
      expect(depois.updateTime?.isEqual(antes.updateTime!)).toBe(true);
      // The holder's start is left for the repasse's own consumption, untouched here.
      expect(depois.dados).toEqual(antes.dados);
    },
  );

  it(`★ ${String(MAX_TENTATIVAS_VEZ_FEED)} lost preconditions in a row ⇒ AmazonVezFeedEmConflitoError, the lease never released`, async () => {
    await semear(enviado());
    const ganchos: Gancho[] = [1, 2, 3].map((n) => ({ metodo: 'update', antes: tocar(n) }));
    const { enfileirarVez } = enfileiramentoGravador();

    const erro = await liberarVezFeed(
      comGanchos(db(), ganchos),
      ALVO,
      { feedId: FEED },
      'concluido',
      {
        agora,
        pendenteDobrado: null,
        enfileirarVez,
      },
    ).then(
      () => expect.unreachable('a liberação deveria ter desistido'),
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(AmazonVezFeedEmConflitoError);
    expect((erro as AmazonVezFeedEmConflitoError).tentativas).toBe(3);
    expect(ganchos).toEqual([]);
    expect((await lido()).dados).toMatchObject({ estado: 'enviado', feedId: FEED });
  });

  it('NEAR-MISS: two lost preconditions, then the third attempt lands the release', async () => {
    await semear(enviado({ falhasSeguidas: 2, ultimaFalhaEmMs: AGORA - 90 * MIN }));
    const ganchos: Gancho[] = [1, 2].map((n) => ({ metodo: 'update', antes: tocar(n) }));
    const { enfileirarVez } = enfileiramentoGravador();

    const r = await liberarVezFeed(comGanchos(db(), ganchos), ALVO, { feedId: FEED }, 'concluido', {
      agora,
      pendenteDobrado: null,
      enfileirarVez,
    });

    expect(r.tipo).toBe('escrito');
    expect((await lido()).dados).toMatchObject({
      estado: 'livre',
      feedId: null,
      execucaoId: DONO,
      falhasSeguidas: 0,
      ultimoFeedConcluidoEmMs: AGORA,
    });
    expect(enfileirarVez).not.toHaveBeenCalled();
  });

  it('★ a release by a NON-holder writes nothing: another run, another feed', async () => {
    const { enfileirarVez } = enfileiramentoGravador();

    await semear(montandoDe(DONO, { pendenteDesdeMs: PENDENTE }));
    const antes = await lido();
    const porRun = await liberarVezFeed(
      db(),
      ALVO,
      { execucaoId: 'exec-outro-ci' },
      'sem-escrita',
      {
        agora,
        pendenteDobrado: null,
        enfileirarVez,
      },
    );
    expect(porRun).toMatchObject({ tipo: 'recusado', motivo: 'outro-dono' });
    expect((await lido()).updateTime?.isEqual(antes.updateTime!)).toBe(true);

    await semear(enviado({ pendenteDesdeMs: PENDENTE }));
    const antesDoFeed = await lido();
    const porFeed = await liberarVezFeed(db(), ALVO, { feedId: '99999' }, 'concluido', {
      agora,
      pendenteDobrado: null,
      enfileirarVez,
    });
    expect(porFeed).toMatchObject({ tipo: 'recusado', motivo: 'outro-dono' });
    expect((await lido()).updateTime?.isEqual(antesDoFeed.updateTime!)).toBe(true);
    // Not even the pending start's recovery: a refusal hands nothing on.
    expect(enfileirarVez).not.toHaveBeenCalled();
  });

  it('NEAR-MISS (anti-vacuity): the HOLDER’s release of the same lease lands', async () => {
    await semear(montandoDe(DONO));
    const { enfileirarVez } = enfileiramentoGravador();
    const r = await liberarVezFeed(db(), ALVO, { execucaoId: DONO }, 'sem-escrita', {
      agora,
      pendenteDobrado: null,
      enfileirarVez,
    });
    expect(r.tipo).toBe('escrito');
    expect((await lido()).dados).toMatchObject({ estado: 'livre', ateMs: AGORA, origem: null });
  });

  it('★ the pending start is MIN-merged: a smaller start lowers it; NEAR-MISS a LARGER one writes nothing', async () => {
    await semear(enviado({ pendenteDesdeMs: PENDENTE }));

    const menor = await entrarNaVezFeed(db(), janelaDoTick('exec-a-ci', PENDENTE - 5 * MIN), {
      agora,
    });
    expect(menor).toMatchObject({
      tipo: 'pendente-registrado',
      pendenteDesdeMs: PENDENTE - 5 * MIN,
      escrito: true,
    });
    const aposMenor = await lido();
    expect(aposMenor.dados.pendenteDesdeMs).toBe(PENDENTE - 5 * MIN);

    const maior = await entrarNaVezFeed(db(), janelaDoTick('exec-b-ci', PENDENTE + 5 * MIN), {
      agora,
    });
    expect(maior).toMatchObject({
      tipo: 'pendente-registrado',
      pendenteDesdeMs: PENDENTE - 5 * MIN,
      escrito: false,
    });
    const aposMaior = await lido();
    expect(aposMaior.dados.pendenteDesdeMs).toBe(PENDENTE - 5 * MIN);
    expect(aposMaior.updateTime?.isEqual(aposMenor.updateTime!)).toBe(true);
    // The holder is untouched by either.
    expect(aposMaior.dados).toMatchObject({ estado: 'enviado', feedId: FEED, execucaoId: DONO });
  });

  it('★ the vez recovery is enqueued BEFORE the release write, NAMED by the holder and the start it read', async () => {
    await semear(enviado({ pendenteDesdeMs: PENDENTE }));
    const { enfileirarVez, vistos } = enfileiramentoGravador();

    const r = await liberarVezFeed(db(), ALVO, { feedId: FEED }, 'concluido', {
      agora,
      pendenteDobrado: null,
      enfileirarVez,
    });

    expect(r).toMatchObject({
      tipo: 'escrito',
      liberacao: { vezPara: PENDENTE, pendenteDesdeMs: PENDENTE },
    });
    expect(vistos).toHaveLength(1);
    // At enqueue time the lease was still held, its start still stored.
    expect(vistos[0]?.vez).toMatchObject({ estado: 'enviado', pendenteDesdeMs: PENDENTE });
    expect(vistos[0]?.recuperacao.nome).toBe(
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(FEED), PENDENTE),
    );
    expect(vistos[0]?.recuperacao.tarefa).toEqual({
      v: 1,
      tipo: 'feed-recuperar',
      fluxo: 'estoque',
      contaId: CONTA,
      desfecho: 'vez',
      feedId: FEED,
      execucaoId: DONO,
      snapshotEmMs: null,
      pendenteDesdeMs: PENDENTE,
      janela: null,
    });
    expect((await lido()).dados).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('★ a vez enqueue that THROWS leaves the lease untouched', async () => {
    await semear(enviado({ pendenteDesdeMs: PENDENTE }));
    const antes = await lido();
    const falha = new FalhaDoEnfileiramentoDeTeste();

    await expect(
      liberarVezFeed(db(), ALVO, { feedId: FEED }, 'concluido', {
        agora,
        pendenteDobrado: null,
        enfileirarVez: () => Promise.reject(falha),
      }),
    ).rejects.toBe(falha);

    const depois = await lido();
    expect(depois.updateTime?.isEqual(antes.updateTime!)).toBe(true);
    expect(depois.dados).toEqual(antes.dados);
  });

  it('★ a 9 re-read that finds a SMALLER start than the folded one hands it to its own vez, then releases', async () => {
    await semear(enviado({ pendenteDesdeMs: PENDENTE }));
    const menor = PENDENTE - 3 * MIN;
    const ganchos: Gancho[] = [
      {
        metodo: 'update',
        // A batch turned away AFTER the tail folded PENDENTE.
        antes: () => ref().update({ pendenteDesdeMs: menor, atualizadoEmMs: AGORA }),
      },
    ];
    const { enfileirarVez, vistos } = enfileiramentoGravador();

    const r = await liberarVezFeed(comGanchos(db(), ganchos), ALVO, { feedId: FEED }, 'concluido', {
      agora,
      pendenteDobrado: PENDENTE,
      enfileirarVez,
    });

    expect(r.tipo).toBe('escrito');
    expect(vistos.map((v) => v.recuperacao.tarefa.pendenteDesdeMs)).toEqual([menor]);
    expect(vistos[0]?.recuperacao.nome).toBe(
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(FEED), menor),
    );
    expect((await lido()).dados).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('NEAR-MISS: a 9 re-read whose start is still the folded one hands nothing on (the tail’s recovery covers it)', async () => {
    await semear(enviado({ pendenteDesdeMs: PENDENTE }));
    const ganchos: Gancho[] = [{ metodo: 'update', antes: tocar(7) }];
    const { enfileirarVez } = enfileiramentoGravador();

    const r = await liberarVezFeed(comGanchos(db(), ganchos), ALVO, { feedId: FEED }, 'concluido', {
      agora,
      pendenteDobrado: PENDENTE,
      enfileirarVez,
    });

    expect(ganchos).toEqual([]);
    expect(r.tipo).toBe('escrito');
    expect(enfileirarVez).not.toHaveBeenCalled();
    expect((await lido()).dados).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('★ marcarEnviando: the caller’s enqueue runs BEFORE the write and ONCE across a lost precondition; the concurrent start survives', async () => {
    await semear(montandoDe(DONO));
    const ganchos: Gancho[] = [
      {
        metodo: 'update',
        // A turned-away batch's MIN-merge lands between the read and the write.
        antes: () => ref().update({ pendenteDesdeMs: PENDENTE, atualizadoEmMs: AGORA }),
      },
    ];
    const estados: string[] = [];
    const antesDaEscrita = vi.fn(async () => {
      estados.push(String((await ref().get()).data()?.estado));
    });
    const envio = {
      snapshotEmMs: AGORA - 3 * MIN,
      antesDoEnvioMs: AGORA,
      mensagens: 31,
      bytes: 3_100,
    };

    const r = await marcarEnviandoVezFeed(
      comGanchos(db(), ganchos),
      ALVO,
      { execucaoId: DONO, envio, antesDoEnvioAnteriorMs: null },
      { agora, antesDaEscrita },
    );

    expect(r.tipo).toBe('escrito');
    expect(antesDaEscrita).toHaveBeenCalledTimes(1);
    expect(estados).toEqual(['montando']);
    expect((await lido()).dados).toMatchObject({
      estado: 'enviando',
      execucaoId: DONO,
      antesDoEnvioMs: AGORA,
      ultimoEnvioMs: AGORA,
      snapshotEmMs: AGORA - 3 * MIN,
      pendenteDesdeMs: PENDENTE,
    });
  });

  it('★ marcarEnviando: an enqueue that throws leaves the lease montando; a refused take runs no enqueue at all', async () => {
    await semear(montandoDe(DONO));
    const antes = await lido();
    const falha = new FalhaDoEnfileiramentoDeTeste();
    const envio = {
      snapshotEmMs: AGORA - 3 * MIN,
      antesDoEnvioMs: AGORA,
      mensagens: 31,
      bytes: 3_100,
    };

    await expect(
      marcarEnviandoVezFeed(
        db(),
        ALVO,
        { execucaoId: DONO, envio, antesDoEnvioAnteriorMs: null },
        { agora, antesDaEscrita: () => Promise.reject(falha) },
      ),
    ).rejects.toBe(falha);
    expect((await lido()).updateTime?.isEqual(antes.updateTime!)).toBe(true);

    const antesDaEscrita = vi.fn(() => Promise.resolve());
    const outro = await marcarEnviandoVezFeed(
      db(),
      ALVO,
      { execucaoId: 'exec-outro-ci', envio, antesDoEnvioAnteriorMs: null },
      { agora, antesDaEscrita },
    );
    expect(outro).toMatchObject({ tipo: 'recusado', motivo: 'outro-dono' });
    expect(antesDaEscrita).not.toHaveBeenCalled();
    expect((await lido()).dados.estado).toBe('montando');
  });

  it('marcarEnviado names the feed (expiry 49 h after the stamp); voltarParaMontando clears the submission', async () => {
    const enviando = montandoDe(DONO, {
      estado: 'enviando',
      snapshotEmMs: AGORA - 3 * MIN,
      antesDoEnvioMs: AGORA - MIN,
      mensagens: 31,
      bytes: 3_100,
      ultimoEnvioMs: AGORA - MIN,
    });
    await semear(enviando);
    expect(
      await marcarEnviadoVezFeed(
        db(),
        ALVO,
        { execucaoId: 'exec-outro-ci', feedId: FEED },
        { agora },
      ),
    ).toMatchObject({ tipo: 'recusado', motivo: 'outro-dono' });
    const r = await marcarEnviadoVezFeed(db(), ALVO, { execucaoId: DONO, feedId: FEED }, { agora });
    expect(r).toMatchObject({ tipo: 'escrito', vez: { estado: 'enviado', feedId: FEED } });
    expect((await lido()).dados).toMatchObject({
      estado: 'enviado',
      feedId: FEED,
      ateMs: AGORA - MIN + VALIDADE_VEZ_ENVIADO_MS,
    });

    await semear(enviando);
    await voltarParaMontandoVezFeed(db(), ALVO, DONO, { agora });
    expect((await lido()).dados).toMatchObject({
      estado: 'montando',
      antesDoEnvioMs: null,
      snapshotEmMs: null,
      ultimoEnvioMs: AGORA - MIN,
    });
  });

  it('★ the uncertain outcome: the vez first, then the lease expired IN PLACE (still enviando, no feedId), its start cleared', async () => {
    await semear(
      montandoDe(DONO, {
        estado: 'enviando',
        snapshotEmMs: AGORA - 3 * MIN,
        antesDoEnvioMs: AGORA - MIN,
        mensagens: 31,
        bytes: 3_100,
        pendenteDesdeMs: PENDENTE,
      }),
    );
    const { enfileirarVez, vistos } = enfileiramentoGravador();

    const r = await expirarIncertoVezFeed(db(), ALVO, DONO, { agora, enfileirarVez });

    expect(r).toMatchObject({ tipo: 'escrito', vezPara: PENDENTE });
    expect(vistos).toHaveLength(1);
    expect(vistos[0]?.vez).toMatchObject({ estado: 'enviando', pendenteDesdeMs: PENDENTE });
    expect(vistos[0]?.recuperacao.nome).toBe(
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(DONO), PENDENTE),
    );
    expect((await lido()).dados).toMatchObject({
      estado: 'enviando',
      feedId: null,
      execucaoId: DONO,
      ateMs: AGORA,
      pendenteDesdeMs: null,
    });
  });

  it('a rung past the slow bound consumes the start (the vez first), the lease still enviado; with none, nothing is written', async () => {
    await semear(enviado({ antesDoEnvioMs: AGORA - 31 * MIN, pendenteDesdeMs: PENDENTE }));
    const { enfileirarVez, vistos } = enfileiramentoGravador();

    const r = await consumirPendenteVezFeed(
      db(),
      ALVO,
      { tipo: 'rodada', feedId: FEED },
      {
        agora,
        enfileirarVez,
      },
    );
    expect(r).toMatchObject({ tipo: 'escrito', vezPara: PENDENTE });
    expect(vistos.map((v) => v.vez.pendenteDesdeMs)).toEqual([PENDENTE]);
    const aposConsumo = await lido();
    expect(aposConsumo.dados).toMatchObject({
      estado: 'enviado',
      feedId: FEED,
      pendenteDesdeMs: null,
    });

    const nada = await consumirPendenteVezFeed(
      db(),
      ALVO,
      { tipo: 'rodada', feedId: FEED },
      {
        agora,
        enfileirarVez,
      },
    );
    expect(nada.tipo).toBe('nada');
    expect(enfileirarVez).toHaveBeenCalledTimes(1);
    expect((await lido()).updateTime?.isEqual(aposConsumo.updateTime!)).toBe(true);
  });

  it('a stored lease that no longer parses is AmazonVezFeedInvalidaError naming its FIELDS, and nothing is written', async () => {
    await ref().set({ estado: 'quebrado', ateMs: 'nunca', atualizadoEmMs: 0 });
    const antes = await ref().get();

    const erro = await entrarNaVezFeed(db(), blocos('exec-a-ci'), { agora }).then(
      () => expect.unreachable('uma vez inválida deveria ser recusada'),
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(AmazonVezFeedInvalidaError);
    expect((erro as AmazonVezFeedInvalidaError).campos).toEqual(['ateMs', 'estado']);
    expect((await ref().get()).updateTime?.isEqual(antes.updateTime!)).toBe(true);
  });
});

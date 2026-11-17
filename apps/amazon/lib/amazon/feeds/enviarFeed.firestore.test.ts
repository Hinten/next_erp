/**
 * The feed SEND handler on a REAL Firestore — the emulator of `ci-amazon.yml`
 * (step 12a, PR 12-c). The offline suite proves every branch against
 * `testing/fakeDb.ts`; this file proves, on the real server, the orderings that
 * only hold if the server behaves as the fake says — each read off the STORED
 * state at the moment it matters:
 *
 *  - at `createFeed`'s call the lease is already `enviando` (with this
 *    attempt's stamp and the submission floor's clock) and the NAMED
 *    `feed-incerto` is already enqueued — a spy on the scripted `createFeed`
 *    reads the lease from the emulator when it is called;
 *  - a failed uncertain-wait enqueue leaves the lease `montando`, and the
 *    retry resumes it;
 *  - a crash between the lease `enviado` and the record leaves the `feedId` on
 *    the lease, and the retry re-creates the record from it;
 *  - the uncertain outcome expires the lease AT ONCE, its recorded start handed
 *    to a NAMED `vez` recovery while the start is still stored;
 *  - a lost lease `create` (ALREADY_EXISTS) is re-read and re-decided;
 *  - a forced refresh's re-run re-enters `enviando` with its OWN stamp;
 *  - a duplicate copy whose document fails while another copy is inside
 *    `createFeed` frees nothing (the stamp keys the attempt).
 *
 * The interleavings are made with a hooked Firestore handle (ONE write of ONE
 * path first runs a concurrent writer); everything else is the real SDK against
 * the real emulator.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the handler as `ambiente` (never `process.env`: the lane sets it `off`).
 * Amazon is a scripted `fetch` serving `createFeedDocument`, the upload (an
 * S3-shaped fake URL) and `createFeed`, refusing anything else; the
 * credential's token is far from expiry, so no LWA exchange is due unless a
 * case scripts one. Nothing enqueues onto a real queue: the producer's
 * transport is a recorder.
 *
 * ⚠️ The emulator is SHARED: the conta here is INCOMPLETE (no filial, no
 * `dataCadastro`), so the conta trigger only reads; its id is seeded by no
 * other suite. Every case wipes what it reads first; the file leaves nothing
 * behind. The lease and the record are not trigger paths.
 */
import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { URL_BASE_SP_API, URL_TOKEN_LWA } from '@delfrance/integrations-amazon-sp-api';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  type VezFeedAmazon,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { falhaDoFunctions, falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
  respostaJson,
  tokenDeAcesso,
} from '../testing/fixtures';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from './agendadorLotes';
import { ACAO_ENVIO_FEED, type ResultadoEnvioFeedAmazon, enviarFeedAmazon } from './enviarFeed';
import type { ProvedorLoteAmazon } from './provedorLote';
import {
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  nomeIncertoFeed,
  nomeRecuperacaoFeed,
  referenciaVezFeed,
  tarefaEnviarFeedAmazonSchema,
} from './tarefaLote';
import { VALIDADE_VEZ_MS } from './vezFeed';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds. */
const CONTA = 'conta-amazon-feed-envio-ci';
const CAMINHO_VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const FEED = '50001234567';
const CAMINHO_REGISTRO = `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`;
const CAMINHO_AVISO = `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.contaSemOperacao)}`;
const URL_UPLOAD = 'https://example-bucket.s3.amazonaws.com/entrada?X-Amz-Signature=0000ci';
const MIN = 60_000;
const EXEC = 'exec-envio-ci';
const SKUS = Array.from({ length: 31 }, (_, i) => `SKU-CI-${String(i + 1).padStart(2, '0')}`);

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
  [VALVULA_ENV_AMAZON.estoque]: 'on',
  [CANARIO_ENV_AMAZON.estoque]: '*',
});

function db(): Firestore {
  return getAdminFirestore();
}

/* ------------------------------ the hooked handle ------------------------------ */

/** ONE write of ONE path that first waits for a concurrent writer (or fails). */
interface Gancho {
  readonly caminho: string;
  readonly metodo: 'update' | 'create';
  readonly antes: () => Promise<unknown>;
}

/** Bind every other member to the real target (the SDK reads its own fields through `this`). */
function membro(alvo: object, prop: string | symbol): unknown {
  const v: unknown = Reflect.get(alvo, prop, alvo);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
}

/** The real Firestore, except that the FIRST hooked write of a path runs its hook first. */
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

async function limpar(): Promise<void> {
  await db().doc(CAMINHO_VEZ).delete();
  await db().doc(CAMINHO_REGISTRO).delete();
  for (const motivo of Object.values(MOTIVO_CONTA_AMAZON)) {
    await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, motivo)}`)
      .delete();
  }
  await db().doc(caminhoCredencial(CONTA)).delete();
  await db().doc(caminhoConta(CONTA)).delete();
}

/** An active, connected, INCOMPLETE conta and a credential far from expiry. */
async function semearConta(): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste do feed',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: AGORA_MS + 365 * DIA_MS }));
}

async function vezArmazenada(): Promise<VezFeedAmazon | undefined> {
  return (await db().doc(CAMINHO_VEZ).get()).data() as VezFeedAmazon | undefined;
}

/** A TICK-born window batch. */
function janelaDoTick(execucaoId = EXEC, desdeMs = AGORA_MS - 10 * MIN): TarefaEnviarFeedAmazon {
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

/* ---------------------------------- the world ---------------------------------- */

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  readonly rede?: true;
}

interface Mundo {
  relogio: number;
  readonly chamadas: string[];
  readonly enfileiradas: {
    readonly tarefa: TarefaLoteAmazon;
    readonly nome: string | null;
    readonly atrasoS: number;
    readonly vez: VezFeedAmazon | undefined;
  }[];
  /** The lease as STORED on the emulator when `createFeed` was called. */
  readonly vistosNoCriarFeed: {
    readonly vez: VezFeedAmazon | undefined;
    readonly enfileiradas: number;
  }[];
  documento: Roteiro[];
  feed: Roteiro[];
  falhasDaFila: (() => Error)[];
  aoDocumento: ((n: number) => Promise<void>) | null;
  aoCriarFeed: (() => Promise<void>) | null;
  rodar(handle: Firestore, t: TarefaEnviarFeedAmazon): Promise<ResultadoEnvioFeedAmazon>;
}

function proxima(fila: Roteiro[]): Roteiro {
  const r = fila.length > 1 ? fila.shift() : fila[0];
  if (r === undefined) throw new Error('teste: rota sem resposta');
  return r;
}

/** A fake window provider: it imports no stock module. */
function provedorDeTeste(): ProvedorLoteAmazon<'estoque', number> {
  return {
    fluxo: 'estoque',
    membros: (ctx) => Promise.resolve({ skus: SKUS, dados: ctx.agora() }),
    montar: (_ctx, _e, on, snapshotEmMs) =>
      Promise.resolve({
        mensagens: on.map((sku) => ({
          sku,
          patches: [
            {
              op: 'merge' as const,
              path: '/attributes/fulfillment_availability',
              value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3 }],
            },
          ],
        })),
        snapshotEmMs,
        diff: { acao: 'enviaria', skusMudados: on.length },
      }),
    gravarResultado: () => Promise.resolve(),
    recuperar: () => Promise.resolve({ nada: true }),
    repassarParaPatches: (_c, _e, skus) => Promise.resolve({ tarefas: skus.length }),
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
}

function mundo(): Mundo {
  const ids = new Set<string>();
  let documentos = 0;
  const m: Mundo = {
    relogio: AGORA_MS,
    chamadas: [],
    enfileiradas: [],
    vistosNoCriarFeed: [],
    documento: [{ status: 201 }],
    feed: [{ status: 202, corpo: { feedId: FEED } }],
    falhasDaFila: [],
    aoDocumento: null,
    aoCriarFeed: null,
    rodar: (handle, t) => {
      expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
      return enviarFeedAmazon(handle, t, {
        ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
        agora: () => m.relogio,
        logger: loggerEspiao().logger,
        increment: (by) => FieldValue.increment(by),
        agendador: () =>
          criarAgendadorLotesAmazon({
            desligado: false,
            fila: (): FilaLotesAmazon => ({
              enqueue: async (tarefa, opcoes) => {
                const falha = m.falhasDaFila.shift();
                if (falha !== undefined) throw falha();
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (ids.has(id)) throw falhaDeTarefaJaExistente(id);
                  ids.add(id);
                }
                m.enfileiradas.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                  vez: await vezArmazenada(),
                });
              },
            }),
          }),
        provedor: provedorDeTeste(),
        registro: { tentativa: 0, idTarefa: 'tarefa-feed-ci' },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const metodo = init?.method ?? 'GET';
          if (url.href === URL_TOKEN_LWA) {
            m.chamadas.push('LWA');
            return tokenDeAcesso();
          }
          if (url.origin === new URL(URL_UPLOAD).origin && metodo === 'PUT') {
            m.chamadas.push('PUT upload');
            return new Response(null, { status: 200 });
          }
          if (url.origin === URL_BASE_SP_API && metodo === 'POST') {
            if (url.pathname === '/feeds/2021-06-30/documents') {
              documentos += 1;
              m.chamadas.push('POST documento');
              await m.aoDocumento?.(documentos);
              const r = proxima(m.documento);
              return respostaJson(
                r.status ?? 201,
                r.corpo ?? { feedDocumentId: `doc-ci-${String(documentos)}`, url: URL_UPLOAD },
              );
            }
            if (url.pathname === '/feeds/2021-06-30/feeds') {
              m.chamadas.push('POST feed');
              m.vistosNoCriarFeed.push({
                vez: await vezArmazenada(),
                enfileiradas: m.enfileiradas.length,
              });
              await m.aoCriarFeed?.();
              const r = proxima(m.feed);
              if (r.rede === true) throw new TypeError('fetch failed');
              return respostaJson(r.status ?? 202, r.corpo ?? {});
            }
          }
          m.chamadas.push(`fora do roteiro: ${metodo} ${url.pathname}`);
          throw new TypeError('sem rede: requisição fora do roteiro');
        },
        gerarCorrelationId: () => 'corr-feed-ci',
      });
    },
  };
  return m;
}

const criarFeeds = (m: Mundo) => m.chamadas.filter((c) => c === 'POST feed').length;

/* ---------------------------------- the cases ---------------------------------- */

describe.skipIf(!EMULATED)('the feed send handler on real Firestore (emulator)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    __setRelogioDoCacheParaTestes(() => AGORA_MS);
    await limpar();
    await semearConta();
  });

  afterAll(async () => {
    await limpar();
    __resetAllReadCaches();
    __setRelogioDoCacheParaTestes();
  });

  it('★ at createFeed’s call the STORED lease is already enviando and the NAMED feed-incerto already enqueued; then enviado → record → rung 0', async () => {
    const m = mundo();
    const r = await m.rodar(db(), janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, feedId: FEED, registro: 'criado' });
    expect(m.vistosNoCriarFeed).toHaveLength(1);
    expect(m.vistosNoCriarFeed[0]).toMatchObject({
      enfileiradas: 1,
      vez: {
        estado: 'enviando',
        execucaoId: EXEC,
        feedId: null,
        antesDoEnvioMs: AGORA_MS,
        ultimoEnvioMs: AGORA_MS,
        ateMs: AGORA_MS + VALIDADE_VEZ_MS,
      },
    });
    const [incerto] = m.enfileiradas;
    expect(incerto).toMatchObject({ nome: nomeIncertoFeed(CONTA, EXEC), atrasoS: 43_200 });
    // The enqueue read the lease still `montando`: it came FIRST.
    expect(incerto?.vez).toMatchObject({ estado: 'montando' });

    expect(await vezArmazenada()).toMatchObject({ estado: 'enviado', feedId: FEED });
    const registro = (await db().doc(CAMINHO_REGISTRO).get()).data();
    expect(registro).toMatchObject({
      status: 'enviado',
      antesDoEnvioMs: AGORA_MS,
      execucaoId: EXEC,
    });
    // The TTL stamp is a real Timestamp on the server, never a number.
    expect(typeof (registro?.expiraEm as { toMillis?: unknown } | undefined)?.toMillis).toBe(
      'function',
    );
    expect(m.enfileiradas.map((e) => e.tarefa.tipo)).toEqual(['feed-incerto', 'feed-resultado']);
  });

  it('★ the feed-incerto enqueue failing ⇒ throws, the STORED lease still montando, ZERO createFeed; the retry resumes it and submits once', async () => {
    const m = mundo();
    m.falhasDaFila.push(() => falhaDoFunctions('unavailable'));
    await expect(m.rodar(db(), janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(m)).toBe(0);
    expect(await vezArmazenada()).toMatchObject({ estado: 'montando', execucaoId: EXEC });

    const r = await m.rodar(db(), janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'retomar' });
    expect(criarFeeds(m)).toBe(1);
  });

  it('★ a crash between the lease enviado and the record ⇒ the retry re-creates the record FROM THE LEASE, ZERO createFeed', async () => {
    const m = mundo();
    const ganchos: Gancho[] = [
      {
        caminho: CAMINHO_REGISTRO,
        metodo: 'create',
        antes: () => Promise.reject(new Error('teste: a instância caiu antes do registro')),
      },
    ];
    await expect(m.rodar(comGanchos(db(), ganchos), janelaDoTick())).rejects.toThrow();
    expect(await vezArmazenada()).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect((await db().doc(CAMINHO_REGISTRO).get()).exists).toBe(false);

    m.relogio += MIN;
    const r = await m.rodar(db(), janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.consultaRetomada, registro: 'criado' });
    expect(criarFeeds(m)).toBe(1);
    expect((await db().doc(CAMINHO_REGISTRO).get()).data()).toMatchObject({
      feedId: FEED,
      execucaoId: EXEC,
      antesDoEnvioMs: AGORA_MS,
      tipoLote: 'janela',
    });
  });

  it('★ the uncertain outcome EXPIRES the stored lease at once; a start recorded meanwhile goes to its NAMED vez recovery while still stored', async () => {
    const m = mundo();
    m.feed = [{ rede: true }];
    const pendente = AGORA_MS - 4 * MIN;
    // Another run's tick batch records its start while this run is inside createFeed.
    m.aoCriarFeed = async () => {
      await db().doc(CAMINHO_VEZ).update({ pendenteDesdeMs: pendente });
    };
    const r = await m.rodar(db(), janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.incerto, vezPara: pendente });
    const armazenada = await vezArmazenada();
    expect(armazenada).toMatchObject({ estado: 'enviando', feedId: null, pendenteDesdeMs: null });
    expect(armazenada?.ateMs).toBeLessThanOrEqual(m.relogio);
    const vez = m.enfileiradas.find((e) => e.tarefa.tipo === 'feed-recuperar');
    expect(vez).toMatchObject({
      nome: nomeRecuperacaoFeed(CONTA, referenciaVezFeed(EXEC), pendente),
      vez: { pendenteDesdeMs: pendente },
    });
    expect((await db().doc(CAMINHO_AVISO).get()).data()).toMatchObject({ resolvidoEm: null });
  });

  it('★ a lost lease create (ALREADY_EXISTS) on the server ⇒ re-read and re-decided: recorded behind the winner', async () => {
    const m = mundo();
    const ganchos: Gancho[] = [
      {
        caminho: CAMINHO_VEZ,
        metodo: 'create',
        antes: () =>
          db()
            .doc(CAMINHO_VEZ)
            .create({
              estado: 'montando',
              execucaoId: 'exec-vencedor-ci',
              feedId: null,
              snapshotEmMs: null,
              antesDoEnvioMs: null,
              mensagens: null,
              bytes: null,
              ateMs: AGORA_MS + VALIDADE_VEZ_MS,
              atualizadoEmMs: AGORA_MS,
              origem: 'delta',
              tipoLote: 'janela',
              janela: null,
              pendenteDesdeMs: null,
              falhasSeguidas: 0,
              ultimaFalhaEmMs: null,
              ultimoEnvioMs: null,
              ultimoFeedConcluidoEmMs: null,
            }),
      },
    ];
    const r = await m.rodar(comGanchos(db(), ganchos), janelaDoTick(EXEC, AGORA_MS - 9 * MIN));
    expect(ganchos).toEqual([]);
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.pendenteRegistrado, tomada: 'ocupada' });
    expect(await vezArmazenada()).toMatchObject({
      execucaoId: 'exec-vencedor-ci',
      pendenteDesdeMs: AGORA_MS - 9 * MIN,
    });
    expect(m.chamadas).toEqual([]);
  });

  it('★ 401 then 202: the forced refresh’s re-run re-enters enviando with ITS OWN stamp, stored at its createFeed', async () => {
    const m = mundo();
    m.feed = [
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      { status: 202, corpo: { feedId: FEED } },
    ];
    m.aoCriarFeed = () => {
      m.relogio += 7_000;
      return Promise.resolve();
    };
    const r = await m.rodar(db(), janelaDoTick());
    expect(r.acao).toBe(ACAO_ENVIO_FEED.enviado);
    expect(m.chamadas).toContain('LWA');
    expect(m.vistosNoCriarFeed.map((v) => v.vez?.antesDoEnvioMs)).toEqual([
      AGORA_MS,
      AGORA_MS + 7_000,
    ]);
    expect((await db().doc(CAMINHO_REGISTRO).get()).data()).toMatchObject({
      antesDoEnvioMs: AGORA_MS + 7_000,
    });
  });

  it('★ a duplicate COPY whose document fails while another copy is inside createFeed frees NOTHING on the server', async () => {
    const m = mundo();
    let b: Promise<ResultadoEnvioFeedAmazon> | null = null;
    let liberarB: () => void = () => undefined;
    const portaDeB = new Promise<void>((resolve) => {
      liberarB = resolve;
    });
    let bChegou: () => void = () => undefined;
    const bNoDocumento = new Promise<void>((resolve) => {
      bChegou = resolve;
    });
    m.aoDocumento = async (n) => {
      if (n !== 2) return;
      m.documento = [{ status: 400, corpo: { errors: [] } }];
      bChegou();
      await portaDeB;
    };
    // Right before copy A writes `enviando`, copy B reads the lease `montando` and builds.
    const ganchos: Gancho[] = [
      {
        caminho: CAMINHO_VEZ,
        metodo: 'update',
        antes: async () => {
          b = m.rodar(db(), janelaDoTick());
          await bNoDocumento;
        },
      },
    ];
    m.aoCriarFeed = async () => {
      liberarB();
      const rb = await (b ?? Promise.reject(new Error('B não rodou')));
      expect(rb).toMatchObject({ motivo: 'documento-falhou', recusa: 'outro-estado' });
      expect(await vezArmazenada()).toMatchObject({
        estado: 'enviando',
        execucaoId: EXEC,
        antesDoEnvioMs: AGORA_MS,
      });
    };
    const ra = await m.rodar(comGanchos(db(), ganchos), janelaDoTick());
    expect(ra.acao).toBe(ACAO_ENVIO_FEED.enviado);
    expect(criarFeeds(m)).toBe(1);
    expect(await vezArmazenada()).toMatchObject({ estado: 'enviado', feedId: FEED });
  });
});

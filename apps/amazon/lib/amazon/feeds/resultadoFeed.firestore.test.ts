/**
 * The feed RESULT handler on a REAL Firestore — the emulator of
 * `ci-amazon.yml` (step 12a, PR 12-c). The offline suite proves every branch
 * against `testing/fakeDb.ts`; this file proves, on the real server, what only
 * holds if the server behaves as the fake says — each read off the STORED state
 * at the moment it matters:
 *
 *  - the tail's outcome clock is stored as a real `Timestamp` (the record read's
 *    own `readTime`) BEFORE the download, handed to the write-back as stored,
 *    and REUSED unchanged by a retried attempt;
 *  - the tail's recovery is enqueued while the STORED lease still names the
 *    feed and the STORED record is still open; the terminal status lands last;
 *  - a SMALLER start written between the tail's lease read and its release
 *    makes the release lose its precondition (9), re-read, and hand that start
 *    to its own NAMED `vez` recovery while it is still stored;
 *  - a rung write that loses its precondition to a concurrent record write is
 *    re-derived from the fresh read (`rodadas` max-merged, never overwritten).
 *
 * The interleavings are made with a hooked Firestore handle (ONE write of ONE
 * path first runs a concurrent writer); everything else is the real SDK against
 * the real emulator.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the handler as `ambiente` (never `process.env`: the lane sets it `off`).
 * Amazon is a scripted `fetch` serving `getFeed`, `getFeedDocument` and the
 * report (an S3-shaped fake URL), refusing anything else; the credential's
 * token is far from expiry, so no LWA exchange is due. Nothing enqueues onto a
 * real queue: the producer's transport is a recorder.
 *
 * ⚠️ The emulator is SHARED: the conta here is INCOMPLETE (no filial, no
 * `dataCadastro`), so the conta trigger only reads; its id is seeded by no
 * other suite. Every case wipes what it reads first; the file leaves nothing
 * behind. The lease and the record are not trigger paths.
 */
import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { URL_BASE_SP_API, URL_TOKEN_LWA } from '@delfrance/integrations-amazon-sp-api';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
  registroFeedAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import type { AmbienteAmazon } from '../env';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
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
import type { ProvedorLoteAmazon, ResultadoLoteAmazon } from './provedorLote';
import { PRAZO_FEED_MS } from './registroFeed';
import { type ResultadoConsultaFeedAmazon, processarResultadoFeedAmazon } from './resultadoFeed';
import {
  ORIGEM_RESULTADO_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaLoteAmazon,
  type TarefaResultadoFeedAmazon,
  nomeRecuperacaoFeed,
  referenciaVezFeed,
  tarefaResultadoFeedAmazonSchema,
} from './tarefaLote';
import { VALIDADE_VEZ_ENVIADO_MS } from './vezFeed';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds. */
const CONTA = 'conta-amazon-feed-resultado-ci';
const FEED = '50002468024';
const EXEC = 'exec-resultado-ci';
const CAMINHO_VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const CAMINHO_REGISTRO = `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`;
const URL_RELATORIO = 'https://example-bucket.s3.amazonaws.com/relatorio-ci?X-Amz-Signature=0000ci';
const MIN = 60_000;
const ANTES = AGORA_MS - 2 * MIN;
const JANELA = {
  desdeMs: ANTES - 10 * MIN,
  ateMs: ANTES - 5 * MIN,
  manterDesdeMs: ANTES - 10 * MIN,
  commitAposMs: null,
  depositoId: 'deposito-ci',
};
const RELATORIO = {
  issues: [{ messageId: 1, sku: 'SKU-CI-01', code: '90220', severity: 'ERROR', message: 'x' }],
  summary: {
    errors: 1,
    warnings: 0,
    messagesProcessed: 31,
    messagesAccepted: 30,
    messagesInvalid: 1,
  },
};

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
});

function db(): Firestore {
  return getAdminFirestore();
}

/* ------------------------------ the hooked handle ------------------------------ */

/** ONE write of ONE path that first waits for a concurrent writer. */
interface Gancho {
  readonly caminho: string;
  readonly antes: () => Promise<unknown>;
}

/** Bind every other member to the real target (the SDK reads its own fields through `this`). */
function membro(alvo: object, prop: string | symbol): unknown {
  const v: unknown = Reflect.get(alvo, prop, alvo);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
}

/** The real Firestore, except that the FIRST hooked `update` of a path runs its hook first. */
function comGanchos(real: Firestore, ganchos: Gancho[]): Firestore {
  const doc = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop === 'update') {
          return async (...args: unknown[]) => {
            const i = ganchos.findIndex((g) => g.caminho === alvo.path);
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

/** An active, connected, INCOMPLETE conta, a credential far from expiry, the record and the lease. */
async function semear(vez: Partial<VezFeedAmazon> = {}): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste do resultado',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: AGORA_MS + 365 * DIA_MS }));
  await db()
    .doc(CAMINHO_REGISTRO)
    .set(
      registroFeedAmazonSchema.parse({
        contaId: CONTA,
        feedId: FEED,
        fluxo: FLUXO_FEED_AMAZON.estoque,
        execucaoId: EXEC,
        origem: 'delta',
        tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
        janela: JANELA,
        snapshotEmMs: ANTES - MIN,
        antesDoEnvioMs: ANTES,
        mensagens: 31,
        bytes: 3_100,
        status: STATUS_REGISTRO_FEED_AMAZON.enviado,
        criadoEmMs: ANTES,
        atualizadoEmMs: ANTES,
        prazoEmMs: ANTES + PRAZO_FEED_MS,
        expiraEm: new Date(ANTES + 180 * DIA_MS),
      }),
    );
  await db()
    .doc(CAMINHO_VEZ)
    .set({
      estado: ESTADO_VEZ_FEED_AMAZON.enviado,
      execucaoId: EXEC,
      feedId: FEED,
      snapshotEmMs: ANTES - MIN,
      antesDoEnvioMs: ANTES,
      mensagens: 31,
      bytes: 3_100,
      ateMs: ANTES + VALIDADE_VEZ_ENVIADO_MS,
      atualizadoEmMs: ANTES,
      origem: 'delta',
      tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
      janela: JANELA,
      pendenteDesdeMs: null,
      falhasSeguidas: 1,
      ultimaFalhaEmMs: null,
      ultimoEnvioMs: ANTES,
      ultimoFeedConcluidoEmMs: null,
      ...vez,
    });
}

async function armazenado(caminho: string): Promise<Record<string, unknown> | undefined> {
  return (await db().doc(caminho).get()).data();
}

function rodada(n: number): TarefaResultadoFeedAmazon {
  return tarefaResultadoFeedAmazonSchema.parse({
    v: 1,
    tipo: TIPO_TAREFA_LOTE_AMAZON.resultado,
    contaId: CONTA,
    feedId: FEED,
    rodada: n,
    origem: ORIGEM_RESULTADO_FEED_AMAZON.consulta,
  });
}

/* ---------------------------------- the world ---------------------------------- */

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
}

function proxima(fila: Roteiro[]): Roteiro {
  const r = fila.length > 1 ? fila.shift() : fila[0];
  if (r === undefined) throw new Error('teste: rota sem resposta');
  return r;
}

function mundo() {
  const ids = new Set<string>();
  const gravacoes: ResultadoLoteAmazon[] = [];
  const m = {
    relogio: AGORA_MS,
    chamadas: [] as string[],
    enfileiradas: [] as {
      readonly tarefa: TarefaLoteAmazon;
      readonly nome: string | null;
      readonly vez: Record<string, unknown> | undefined;
      readonly registro: Record<string, unknown> | undefined;
    }[],
    gravacoes,
    feed: [
      {
        status: 200,
        corpo: { feedId: FEED, processingStatus: 'DONE', resultFeedDocumentId: 'doc-rel-ci' },
      },
    ] as Roteiro[],
    relatorio: [{ status: 200 }] as Roteiro[],
    rodar(handle: Firestore, t: TarefaResultadoFeedAmazon): Promise<ResultadoConsultaFeedAmazon> {
      expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
      const provedor: ProvedorLoteAmazon<'estoque', number> = {
        fluxo: 'estoque',
        membros: () => Promise.reject(new Error('o resultado não monta')),
        montar: () => Promise.reject(new Error('o resultado não monta')),
        gravarResultado: (_ctx, r) => {
          gravacoes.push(r);
          return Promise.resolve();
        },
        recuperar: () => Promise.resolve({ nada: true }),
        repassarParaPatches: () => Promise.resolve({ tarefas: 0 }),
        motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
      };
      return processarResultadoFeedAmazon(handle, t, {
        ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
        agora: () => m.relogio,
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
                m.enfileiradas.push({
                  tarefa,
                  nome: id ?? null,
                  vez: await armazenado(CAMINHO_VEZ),
                  registro: await armazenado(CAMINHO_REGISTRO),
                });
              },
            }),
          }),
        provedorDe: () => provedor,
        registro: { tentativa: 0, idTarefa: 'tarefa-resultado-ci' },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const metodo = init?.method ?? 'GET';
          if (url.href === URL_TOKEN_LWA) {
            m.chamadas.push('LWA');
            return tokenDeAcesso();
          }
          if (url.origin === new URL(URL_RELATORIO).origin && metodo === 'GET') {
            m.chamadas.push('GET relatorio');
            const r = proxima(m.relatorio);
            return new Response(JSON.stringify(RELATORIO), { status: r.status ?? 200 });
          }
          if (url.origin === URL_BASE_SP_API && metodo === 'GET') {
            if (url.pathname.startsWith('/feeds/2021-06-30/feeds/')) {
              m.chamadas.push('GET feed');
              const r = proxima(m.feed);
              return respostaJson(r.status ?? 200, r.corpo ?? {});
            }
            if (url.pathname.startsWith('/feeds/2021-06-30/documents/')) {
              m.chamadas.push('GET documento');
              return respostaJson(200, { feedDocumentId: 'doc-rel-ci', url: URL_RELATORIO });
            }
          }
          m.chamadas.push(`fora do roteiro: ${metodo} ${url.pathname}`);
          throw new TypeError('sem rede: requisição fora do roteiro');
        },
        gerarCorrelationId: () => 'corr-resultado-ci',
      });
    },
  };
  return m;
}

const recuperacoes = (m: ReturnType<typeof mundo>) =>
  m.enfileiradas.filter((e) => e.tarefa.tipo === TIPO_TAREFA_LOTE_AMAZON.recuperar);

/* ---------------------------------- the cases ---------------------------------- */

describe.skipIf(!EMULATED)('the feed result handler on real Firestore (emulator)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    __setRelogioDoCacheParaTestes(() => AGORA_MS);
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    __resetAllReadCaches();
    __setRelogioDoCacheParaTestes();
  });

  it('★ DONE: the outcome clock stored as a real Timestamp and handed to the write-back; the recovery enqueued while the STORED lease names the feed and the record is open; the record still open at the release; the terminal LAST', async () => {
    await semear();
    const m = mundo();
    // The STORED record's status when the tail's release (the lease's first update) is sent.
    let statusNaLiberacao: unknown = null;
    const handle = comGanchos(db(), [
      {
        caminho: CAMINHO_VEZ,
        antes: async () => {
          statusNaLiberacao = (await armazenado(CAMINHO_REGISTRO))?.status;
        },
      },
    ]);
    const r = await m.rodar(handle, rodada(0));
    expect(r).toMatchObject({ acao: 'encerrado', desfecho: 'concluido', relatorio: 'baixado' });
    expect(statusNaLiberacao).toBe('processando');

    const registro = await armazenado(CAMINHO_REGISTRO);
    expect(registro?.relogioDesfecho).toBeInstanceOf(Timestamp);
    expect(registro).toMatchObject({
      status: 'concluido',
      skusComProblema: 1,
      resultado: { erros: 1, aceitas: 30 },
    });
    const [gravado] = m.gravacoes;
    expect((registro?.relogioDesfecho as Timestamp).isEqual(gravado?.relogio as Timestamp)).toBe(
      true,
    );
    expect([...(gravado?.problemas.keys() ?? [])]).toEqual(['SKU-CI-01']);

    const [recuperacao] = recuperacoes(m);
    expect(recuperacao?.vez).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect(recuperacao?.registro).toMatchObject({ status: 'processando' });
    expect(await armazenado(CAMINHO_VEZ)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });
  });

  it('★ a retried attempt REUSES the stored clock: the first stores it before its download fails, the second keeps it unchanged', async () => {
    await semear();
    const m = mundo();
    m.relatorio = [{ status: 503 }, { status: 200 }];
    await expect(m.rodar(db(), rodada(0))).rejects.toThrow();
    const primeiro = (await armazenado(CAMINHO_REGISTRO))?.relogioDesfecho as Timestamp;
    expect(primeiro).toBeInstanceOf(Timestamp);
    expect((await armazenado(CAMINHO_REGISTRO))?.status).toBe('enviado');

    m.relogio += MIN;
    await m.rodar(db(), rodada(0));
    const depois = (await armazenado(CAMINHO_REGISTRO))?.relogioDesfecho as Timestamp;
    expect(depois.isEqual(primeiro)).toBe(true);
    expect((m.gravacoes[0]?.relogio as Timestamp).isEqual(primeiro)).toBe(true);
  });

  it('★ a SMALLER start written between the tail’s lease read and its release ⇒ 9 ⇒ re-read ⇒ ONE vez recovery while it is still stored, then the release', async () => {
    const dobrado = AGORA_MS - 3 * MIN;
    const menor = AGORA_MS - 8 * MIN;
    await semear({ pendenteDesdeMs: dobrado });
    const m = mundo();
    const handle = comGanchos(db(), [
      {
        caminho: CAMINHO_VEZ,
        antes: () =>
          db()
            .doc(CAMINHO_VEZ)
            .update({ pendenteDesdeMs: menor, atualizadoEmMs: AGORA_MS - 1 }),
      },
    ]);
    const r = await m.rodar(handle, rodada(0));
    expect(r).toMatchObject({ pendenteDobrado: dobrado, vezPara: menor, liberacao: 'liberada' });
    expect(recuperacoes(m).map((e) => e.nome)).toEqual([
      nomeRecuperacaoFeed(CONTA, FEED, dobrado),
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(FEED), menor),
    ]);
    expect(recuperacoes(m)[1]?.vez).toMatchObject({ estado: 'enviado', pendenteDesdeMs: menor });
    expect(await armazenado(CAMINHO_VEZ)).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('★ a rung write that loses its precondition to a concurrent record write is RE-DERIVED from the fresh read', async () => {
    await semear();
    const m = mundo();
    m.feed = [{ status: 200, corpo: { feedId: FEED, processingStatus: 'IN_PROGRESS' } }];
    m.relogio = ANTES + 17 * MIN;
    const handle = comGanchos(db(), [
      {
        caminho: CAMINHO_REGISTRO,
        antes: () =>
          db()
            .doc(CAMINHO_REGISTRO)
            .update({ rodadas: 5, atualizadoEmMs: ANTES + MIN }),
      },
    ]);
    const r = await m.rodar(handle, rodada(2));
    expect(r).toMatchObject({ acao: 'processando' });
    expect(await armazenado(CAMINHO_REGISTRO)).toMatchObject({
      status: 'processando',
      rodadas: 5,
      atualizadoEmMs: ANTES + 17 * MIN,
      processingStatus: 'IN_PROGRESS',
    });
  });
});

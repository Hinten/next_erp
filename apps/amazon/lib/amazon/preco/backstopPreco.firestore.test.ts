/**
 * The DAILY price step on a REAL Firestore — the emulator of `ci-amazon.yml`
 * (step 13, PR 13-f). The offline suite drives every branch against
 * `testing/fakeDb.ts`; this file runs the step IN-PROCESS on the real server
 * and proves what only holds if the server behaves as the fake says:
 *
 *  - ★ its OWN conta enumeration (the existing `(tipo, nome)` query) finds this
 *    conta, and a stuck PRICE feed (its lease `enviado`, its record still for
 *    seven hours) gets ONE adoption rung, named by the São Paulo date;
 *  - ★ a price run stalled past the re-kick mark is never READ by the step
 *    (the server sees no read of it) and never written;
 *  - NEAR-MISS: a record that moved within six hours is alive, nothing enqueued.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the step. The step makes no Amazon call at all. The jobs producer is a
 * RECORDER: nothing is enqueued onto a queue the lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-preco-backstop-`, which no other suite seeds; the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; no `nfev4` is written. The conta query may also see another suite's
 * contas: every assertion is about THIS conta. Every case wipes what it reads
 * first, and the file leaves nothing behind. PLACEHOLDERS ONLY (public
 * repository).
 */
import { DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FASE_EXECUCAO_PRECO_AMAZON,
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import type { AmbienteAmazon } from '../env';
import { criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import { dataSaoPauloAmazon } from '../feeds/resultadoFeed';
import { type TarefaLoteAmazon, nomeConsultaFeed } from '../feeds/tarefaLote';
import { AMBIENTE_LIGADO, caminhoConta, loggerEspiao } from '../testing/fixtures';
import { executarBackstopDiarioPrecoAmazon } from './backstopPreco';
import { RETOMADA_EXECUCAO_PRECO_MS } from './inicioExecucaoPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-backstop-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const FEED = '50003579135';
const MIN = 60_000;
const HORA = 60 * MIN;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, CONTA)}`;
const REG = `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`;
const RUN = `precosAmazon/${CONTA}`;

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
  AMAZON_MODO_PRECO: 'dry-run',
});

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  await Promise.all([VEZ, REG, RUN, caminhoConta(CONTA)].map((c) => db().doc(c).delete()));
}

/** An active INCOMPLETE conta, and its PRICE lease naming a submitted feed sent 8 h ago. */
async function semear(agoraMs: number): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste do passo diário de preço',
    ativo: true,
    padrao: false,
    selling_partner_id: null,
  });
  const antes = agoraMs - 8 * HORA;
  await db()
    .doc(VEZ)
    .set({
      estado: ESTADO_VEZ_FEED_AMAZON.enviado,
      execucaoId: `${P}exec-feed`,
      feedId: FEED,
      snapshotEmMs: antes - MIN,
      antesDoEnvioMs: antes,
      mensagens: 12,
      bytes: 1_200,
      ateMs: antes + 49 * HORA,
      atualizadoEmMs: antes,
      origem: 'execucao-preco',
      tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
    });
}

/** The feed's record, last moved `paradoHaMs` before `agoraMs`. */
async function registro(agoraMs: number, paradoHaMs: number): Promise<void> {
  const antes = agoraMs - 8 * HORA;
  await db()
    .doc(REG)
    .set({
      contaId: CONTA,
      feedId: FEED,
      fluxo: 'preco',
      execucaoId: `${P}exec-feed`,
      origem: 'execucao-preco',
      tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
      janela: null,
      snapshotEmMs: antes - MIN,
      antesDoEnvioMs: antes,
      mensagens: 12,
      bytes: 1_200,
      status: STATUS_REGISTRO_FEED_AMAZON.processando,
      criadoEmMs: antes,
      atualizadoEmMs: agoraMs - paradoHaMs,
      prazoEmMs: agoraMs + 4 * HORA,
      rodadas: 3,
      expiraEm: new Date(agoraMs + 180 * 86_400_000),
    });
}

/** The step, in-process: the switch on as a literal, the jobs queue a recorder. */
async function rodar(agoraMs: number) {
  expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
  const lotes: { readonly tarefa: TarefaLoteAmazon; readonly opcoes: unknown }[] = [];
  const r = await executarBackstopDiarioPrecoAmazon({
    db: db(),
    ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
    agora: () => agoraMs,
    logger: loggerEspiao().logger,
    agendador: () =>
      criarAgendadorLotesAmazon({
        desligado: false,
        fila: () => ({
          enqueue: (tarefa, opcoes) => {
            lotes.push({ tarefa, opcoes });
            return Promise.resolve();
          },
        }),
      }),
  });
  return {
    nossa: r.contas.find((c) => c.contaId === CONTA),
    nossos: lotes.filter((l) => 'contaId' in l.tarefa && l.tarefa.contaId === CONTA),
  };
}

describe.skipIf(!EMULATED)('the daily price step on real Firestore (emulator)', () => {
  beforeEach(async () => {
    __resetAllReadCaches();
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    __resetAllReadCaches();
    await limpar();
  });

  it('★ its own conta query finds this conta, and a stuck price feed gets ONE adoption rung named by the São Paulo date', async () => {
    const agora = Date.now();
    await semear(agora);
    await registro(agora, 7 * HORA);
    const { nossa, nossos } = await rodar(agora);
    expect(nossa).toEqual({
      contaId: CONTA,
      desfecho: 'feito',
      adocao: 'adotada',
      registro: null,
      erro: null,
    });
    expect(nossos).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'feed-resultado',
          contaId: CONTA,
          feedId: FEED,
          rodada: 0,
          origem: 'adocao',
        },
        opcoes: { id: nomeConsultaFeed(CONTA, FEED, `adocao:${dataSaoPauloAmazon(agora)}`) },
      },
    ]);
  });

  it('★ a price run stalled past the re-kick mark is never READ by the step on the server, and never written', async () => {
    const agora = Date.now();
    await semear(agora);
    await registro(agora, 7 * HORA);
    await db()
      .doc(RUN)
      .set({
        execucaoId: `${P}exec-parada`,
        fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
        baixarPreco: false,
        solicitadaPor: `${P}uid`,
        proximaPagina: 2,
        iniciadaEmMs: agora - 2 * HORA,
        progressoEmMs: agora - RETOMADA_EXECUCAO_PRECO_MS - MIN,
      });
    const antes = (await db().doc(RUN).get()).updateTime;
    // Every by-id read the step makes, by path: a document's `get` and a `getAll`.
    const lidos: string[] = [];
    const get = DocumentReference.prototype.get;
    vi.spyOn(DocumentReference.prototype, 'get').mockImplementation(function (
      this: DocumentReference,
    ) {
      lidos.push(this.path);
      return get.call(this);
    });
    const instancia = db();
    const getAll = instancia.getAll.bind(instancia);
    vi.spyOn(instancia, 'getAll').mockImplementation(async (...args) => {
      const snaps = await getAll(...args);
      for (const s of snaps) lidos.push(s.ref.path);
      return snaps;
    });
    const { nossa, nossos } = await rodar(agora);
    expect(nossa).toMatchObject({ desfecho: 'feito', adocao: 'adotada' });
    expect(nossos.map((l) => l.tarefa.tipo)).toEqual(['feed-resultado']);
    // Anti-vacuity: the spy saw the step's own by-id reads.
    expect(lidos).toContain(VEZ);
    expect(lidos).not.toContain(RUN);
    expect((await db().doc(RUN).get()).updateTime?.isEqual(antes as never)).toBe(true);
  });

  it('NEAR-MISS: a record that moved within six hours is alive — nothing enqueued for this conta', async () => {
    const agora = Date.now();
    await semear(agora);
    await registro(agora, 5 * HORA);
    const { nossa, nossos } = await rodar(agora);
    expect(nossa).toMatchObject({ desfecho: 'feito', adocao: 'viva' });
    expect(nossos).toEqual([]);
  });
});

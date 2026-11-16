/**
 * The feed's UNCERTAIN PATH (step 12a, PR 12-c), against the fake Firestore:
 * the REAL lease I/O and pure lease machine, the REAL aviso seam, and the REAL
 * jobs producer over a RECORDING queue (every enqueue re-validated against the
 * payload schema, its name and its whole-seconds delay). A FAKE provider built
 * here supplies the fluxo's aviso; it imports no stock module.
 *
 * ⚠️ D11: nothing here calls Amazon — the path makes no SP-API call at all, and
 * the global `fetch` refuses. PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FLUXO_FEED_AMAZON,
  MOTIVO_CONTA_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, caminhoAviso, loggerEspiao } from '../testing/fixtures';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from './agendadorLotes';
import {
  type DepsIncertoFeedAmazon,
  atrasoAtePrazoDoFeedS,
  percorrerCaminhoIncertoFeed,
  processarIncertoFeedAmazon,
  tarefaIncertoFeed,
} from './incertoFeed';
import type { ProvedorLoteAmazon } from './provedorLote';
import { PRAZO_FEED_MS } from './registroFeed';
import { type TarefaLoteAmazon, nomeRecuperacaoFeed, referenciaVezFeed } from './tarefaLote';

const CONTA = 'conta-amz-incerto';
const EXEC = 'exec-incerto-teste';
const MIN = 60_000;
const HORA = 60 * MIN;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const AVISO = caminhoAviso(chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.contaSemOperacao));
/** The submission's stamp: the 12-h deadline is ANTES + 12 h. */
const ANTES = AGORA_MS - PRAZO_FEED_MS;
const JANELA = {
  desdeMs: ANTES - 20 * MIN,
  ateMs: ANTES - 15 * MIN,
  manterDesdeMs: ANTES - 20 * MIN,
  commitAposMs: null,
  depositoId: 'deposito-teste',
};

function vez(campos: Partial<VezFeedAmazon>): VezFeedAmazon {
  return vezFeedAmazonCollection.parse({
    estado: 'livre',
    ateMs: 0,
    atualizadoEmMs: AGORA_MS - HORA,
    ...campos,
  });
}

/** This run's maybe-submitted feed, expired in place by the uncertain outcome. */
const incerta = (campos: Partial<VezFeedAmazon> = {}) =>
  vez({
    estado: ESTADO_VEZ_FEED_AMAZON.enviando,
    execucaoId: EXEC,
    snapshotEmMs: ANTES - MIN,
    antesDoEnvioMs: ANTES,
    mensagens: 40,
    bytes: 4_000,
    ateMs: ANTES,
    atualizadoEmMs: ANTES,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: JANELA,
    ultimoEnvioMs: ANTES,
    falhasSeguidas: 1,
    ...campos,
  });

interface Enfileirada {
  readonly tarefa: TarefaLoteAmazon;
  readonly nome: string | null;
  readonly atrasoS: number;
  readonly vez: Record<string, unknown> | undefined;
  readonly aviso: Record<string, unknown> | undefined;
}

function cenario() {
  const fake = new FakeDb();
  const log = loggerEspiao();
  const enfileiradas: Enfileirada[] = [];
  const ids = new Set<string>();
  const c = {
    fake,
    log,
    enfileiradas,
    relogio: AGORA_MS,
    provedor: {
      fluxo: 'estoque',
      membros: () => Promise.reject(new Error('o caminho incerto não monta')),
      montar: () => Promise.reject(new Error('o caminho incerto não monta')),
      gravarResultado: () => Promise.resolve(),
      recuperar: () => Promise.resolve({ nada: true }),
      repassarParaPatches: () => Promise.resolve({ tarefas: 0 }),
      motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
    } as ProvedorLoteAmazon<'estoque', unknown> | null,
    deps(): DepsIncertoFeedAmazon {
      return {
        agora: () => c.relogio,
        logger: log.logger,
        increment,
        agendador: () =>
          criarAgendadorLotesAmazon({
            desligado: false,
            fila: (): FilaLotesAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                  ids.add(id);
                }
                enfileiradas.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                  vez: fake.ler(VEZ),
                  aviso: fake.ler(AVISO),
                });
                return Promise.resolve();
              },
            }),
          }),
        provedor: c.provedor,
        registro: { tentativa: 0, idTarefa: 'tarefa-incerto-teste-1' },
      };
    },
    rodar() {
      return processarIncertoFeedAmazon(
        asDb(fake),
        tarefaIncertoFeed({ fluxo: FLUXO_FEED_AMAZON.estoque, contaId: CONTA, execucaoId: EXEC }),
        c.deps(),
      );
    },
  };
  return c;
}

const lease = (c: ReturnType<typeof cenario>) => c.fake.ler(VEZ) as VezFeedAmazon | undefined;
const doTipo = (c: ReturnType<typeof cenario>, tipo: TarefaLoteAmazon['tipo']) =>
  c.enfileiradas.filter((x) => x.tarefa.tipo === tipo);

const rede: string[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/* ------------------------------------------------------------------------------ */

describe('the path acts ONLY on this run’s maybe-submitted lease', () => {
  it.each<[string, VezFeedAmazon | null]>([
    ['no lease at all', null],
    ['a free lease', vez({ estado: ESTADO_VEZ_FEED_AMAZON.livre })],
    ['another run’s enviando', incerta({ execucaoId: 'exec-outro' })],
    ['this run’s feed already known', incerta({ estado: 'enviado', feedId: '50001234567' })],
    ['this run’s montando', incerta({ estado: 'montando' })],
  ])('%s ⇒ sem-vez: nothing written, nothing enqueued', async (_caso, v) => {
    const c = cenario();
    if (v !== null) c.fake.seed(VEZ, v);
    const r = await c.rodar();
    expect(r.desfecho).toEqual({ tipo: 'sem-vez' });
    expect(c.fake.escritas).toEqual([]);
    expect(c.enfileiradas).toEqual([]);
    expect(c.log.linhas.at(-1)).toMatchObject({
      nivel: 'info',
      meta: { caminhoIncerto: 'sem-vez' },
    });
  });

  it('a stampless enviando of this run (a hand edit) ⇒ vez-incompleta, WARNING, nothing written', async () => {
    const c = cenario();
    c.fake.seed(VEZ, incerta({ antesDoEnvioMs: null }));
    const r = await c.rodar();
    expect(r.desfecho).toEqual({ tipo: 'vez-incompleta' });
    expect(c.fake.escritas).toEqual([]);
    expect(c.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
  });
});

describe('★ before the 12-h deadline: re-enqueued UNNAMED for the remainder, in WHOLE seconds', () => {
  it('11 h 59 min after antesDoEnvioMs ⇒ waits 60 s, nothing written', async () => {
    const c = cenario();
    c.fake.seed(VEZ, incerta({ antesDoEnvioMs: AGORA_MS - 11 * HORA - 59 * MIN }));
    const r = await c.rodar();
    expect(r.desfecho).toEqual({ tipo: 'cedo', atrasoS: 60, reenfileirado: true });
    expect(c.enfileiradas).toEqual([
      expect.objectContaining({
        nome: null,
        atrasoS: 60,
        tarefa: expect.objectContaining({ tipo: 'feed-incerto', execucaoId: EXEC }),
      }),
    ]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('the remainder rounds UP: 1 ms before the deadline waits 1 s (NEAR-MISS: at the deadline it recovers)', async () => {
    const c = cenario();
    c.fake.seed(VEZ, incerta({ antesDoEnvioMs: AGORA_MS - PRAZO_FEED_MS + 1 }));
    expect((await c.rodar()).desfecho).toMatchObject({ tipo: 'cedo', atrasoS: 1 });

    const noPrazo = cenario();
    noPrazo.fake.seed(VEZ, incerta());
    expect((await noPrazo.rodar()).desfecho.tipo).toBe('recuperado');
  });

  it('★ a task that fires early after a re-stamped antesDoEnvioMs (a refresh re-run) waits for the remainder of the NEW stamp', async () => {
    const c = cenario();
    // The first stamp's 12 h elapsed now; the re-run stamped 3 min later.
    c.fake.seed(VEZ, incerta({ antesDoEnvioMs: ANTES + 3 * MIN }));
    const r = await c.rodar();
    expect(r.desfecho).toEqual({ tipo: 'cedo', atrasoS: 180, reenfileirado: true });
    expect(lease(c)).toMatchObject({ estado: 'enviando' });
  });

  it('the E4 entry never waits: before the deadline it answers cedo and enqueues nothing', async () => {
    const c = cenario();
    c.fake.seed(VEZ, incerta({ antesDoEnvioMs: AGORA_MS - HORA }));
    const r = await percorrerCaminhoIncertoFeed(
      asDb(c.fake),
      { fluxo: FLUXO_FEED_AMAZON.estoque, contaId: CONTA, execucaoId: EXEC },
      c.deps(),
      { reenfileirarSeCedo: false },
    );
    expect(r).toEqual({ tipo: 'cedo', atrasoS: 11 * 3600, reenfileirado: false });
    expect(c.enfileiradas).toEqual([]);
  });

  it('atrasoAtePrazoDoFeedS: whole seconds, never negative', () => {
    expect(atrasoAtePrazoDoFeedS(AGORA_MS, AGORA_MS)).toBe(43_200);
    expect(atrasoAtePrazoDoFeedS(AGORA_MS, AGORA_MS + 1)).toBe(43_200);
    expect(atrasoAtePrazoDoFeedS(ANTES, AGORA_MS + 5_000)).toBe(0);
  });
});

describe('★ at the deadline: the recovery, the aviso, the release — in that order', () => {
  it('ONE named recovery carrying the start and the lease’s snapshot and janela; the aviso clocked by the lease read; the lease released', async () => {
    const c = cenario();
    const pendente = ANTES + 30 * MIN;
    c.fake.seed(VEZ, incerta({ pendenteDesdeMs: pendente }));
    const relogioDaLeitura = c.fake.carimboDe(VEZ);
    const r = await c.rodar();

    expect(r.desfecho).toMatchObject({
      tipo: 'recuperado',
      pendenteDesdeMs: pendente,
      recuperacao: 'enfileirada',
      aviso: true,
      liberacao: 'liberada',
      vezPara: null,
    });
    const [recuperacao] = doTipo(c, 'feed-recuperar');
    expect(recuperacao).toMatchObject({
      nome: nomeRecuperacaoFeed(CONTA, EXEC, pendente),
      tarefa: {
        desfecho: 'incerto',
        feedId: null,
        execucaoId: EXEC,
        snapshotEmMs: ANTES - MIN,
        pendenteDesdeMs: pendente,
        janela: JANELA,
      },
    });
    expect(doTipo(c, 'feed-recuperar')).toHaveLength(1);
    // Enqueued FIRST: the lease still enviando and no aviso yet.
    expect(recuperacao?.vez).toMatchObject({ estado: 'enviando', pendenteDesdeMs: pendente });
    expect(recuperacao?.aviso).toBeUndefined();
    // The aviso before the release; clocked by the lease read (the latest stamp then: the seed).
    const ordem = c.fake.escritas.map((w) => w.caminho);
    expect(ordem.indexOf(AVISO)).toBeLessThan(ordem.indexOf(VEZ));
    expect(c.fake.ler(AVISO)).toMatchObject({
      resolvidoEm: null,
      relogioEvento: relogioDoDocumentoUs(relogioDaLeitura ?? { seconds: 0, nanoseconds: 0 }),
    });
    expect(lease(c)).toMatchObject({
      estado: 'livre',
      execucaoId: EXEC,
      pendenteDesdeMs: null,
      falhasSeguidas: 2,
      ultimaFalhaEmMs: AGORA_MS,
      ultimoFeedConcluidoEmMs: AGORA_MS,
      ultimoEnvioMs: ANTES,
    });
    expect(c.log.linhas.at(-1)).toMatchObject({
      nivel: 'warn',
      meta: { evento: 'estoque', fase: 'incerto', caminhoIncerto: 'recuperado' },
    });
  });

  it('a BLOCK batch’s lease recovers with janela null', async () => {
    const c = cenario();
    c.fake.seed(VEZ, incerta({ tipoLote: 'blocos', janela: null, origem: 'reconciliacao' }));
    await c.rodar();
    expect(doTipo(c, 'feed-recuperar')[0]?.tarefa).toMatchObject({
      janela: null,
      pendenteDesdeMs: null,
    });
  });

  it('★ a SMALLER start turned away after the read ⇒ the release’s re-read hands it to its own NAMED vez recovery BEFORE the write', async () => {
    const c = cenario();
    const dobrado = ANTES + 30 * MIN;
    const menor = ANTES + 10 * MIN;
    c.fake.seed(VEZ, incerta({ pendenteDesdeMs: dobrado }));
    c.fake.antesDaProximaEscrita(VEZ, () => {
      const atual = lease(c);
      if (atual === undefined) throw new Error('sem vez');
      c.fake.seed(VEZ, { ...atual, pendenteDesdeMs: menor });
    });
    const r = await c.rodar();
    expect(r.desfecho).toMatchObject({ tipo: 'recuperado', vezPara: menor, liberacao: 'liberada' });
    const recuperacoes = doTipo(c, 'feed-recuperar');
    expect(recuperacoes.map((x) => x.nome)).toEqual([
      nomeRecuperacaoFeed(CONTA, EXEC, dobrado),
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(EXEC), menor),
    ]);
    expect(recuperacoes[1]?.tarefa).toMatchObject({ desfecho: 'vez', pendenteDesdeMs: menor });
    // The vez enqueue saw the start still stored: before the release write.
    expect(recuperacoes[1]?.vez).toMatchObject({ estado: 'enviando', pendenteDesdeMs: menor });
    expect(lease(c)).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('★ NEAR-MISS: a LARGER start turned away after the read ⇒ NO vez (the folded start covers it)', async () => {
    const c = cenario();
    const dobrado = ANTES + 10 * MIN;
    c.fake.seed(VEZ, incerta({ pendenteDesdeMs: dobrado }));
    c.fake.antesDaProximaEscrita(VEZ, () => {
      const atual = lease(c);
      if (atual === undefined) throw new Error('sem vez');
      c.fake.seed(VEZ, { ...atual, pendenteDesdeMs: ANTES + 30 * MIN });
    });
    const r = await c.rodar();
    expect(r.desfecho).toMatchObject({ tipo: 'recuperado', vezPara: null });
    expect(doTipo(c, 'feed-recuperar')).toHaveLength(1);
  });

  it('★ a crash after the recovery enqueue, before the release ⇒ the retry re-runs the path: one recovery (the name), released ONCE', async () => {
    const c = cenario();
    c.fake.seed(VEZ, incerta());
    c.fake.falharEscrita(VEZ, grpc(14, 'indisponível'));
    await expect(c.rodar()).rejects.toThrow();
    expect(lease(c)).toMatchObject({ estado: 'enviando' });
    c.fake.falharEscrita(VEZ, null);

    c.relogio += MIN;
    const r = await c.rodar();
    expect(r.desfecho).toMatchObject({ tipo: 'recuperado', recuperacao: 'ja-enfileirada' });
    expect(doTipo(c, 'feed-recuperar')).toHaveLength(1);
    expect(c.fake.escritasEm(VEZ)).toHaveLength(1);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 2 });

    // A third copy finds nothing left to do.
    expect((await c.rodar()).desfecho).toEqual({ tipo: 'sem-vez' });
  });

  it('a seam with no provider still recovers and releases; it raises no aviso', async () => {
    const c = cenario();
    c.provedor = null;
    c.fake.seed(VEZ, incerta());
    const r = await c.rodar();
    expect(r.desfecho).toMatchObject({ tipo: 'recuperado', aviso: false, liberacao: 'liberada' });
    expect(c.fake.ler(AVISO)).toBeUndefined();
    expect(doTipo(c, 'feed-recuperar')).toHaveLength(1);
  });

  it('a provider of another fluxo is a programming error (TypeError), nothing read', async () => {
    const c = cenario();
    c.provedor = {
      ...(c.provedor as ProvedorLoteAmazon<'estoque', unknown>),
      fluxo: 'preco',
    } as never;
    await expect(c.rodar()).rejects.toBeInstanceOf(TypeError);
    expect(c.fake.leituras).toEqual([]);
  });
});

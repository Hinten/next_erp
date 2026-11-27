/**
 * The price run's claim, re-kick, cancel and status (step 13, PR 13-e), and
 * its page producer, offline: `testing/fakeDb.ts` as the database (the run and
 * the price lease must be read MASKED), the real producer over a recording
 * queue that, like Cloud Tasks, refuses a name it already holds, and the
 * Admin SDK's real error classes for every enqueue failure. No network is
 * reachable. A concurrent writer lands through the fake's write hook or the
 * recording queue itself (between the claim's write and its page's enqueue),
 * never through a timer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError, type z } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import {
  CODIGO_ERRO_PRECO_AMAZON,
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  execucaoPrecoAmazonSchema,
  resumoExecucaoPrecoAmazonSchema,
} from '@delfrance/schemas';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
} from '../feeds/agendadorLotes';
import type { OpcoesDaTarefaListingAmazon } from '../listings/produtorListing';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  falhaDeTarefaJaExistente,
  falhaDoApp,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import { AMBIENTE_LIGADO, loggerEspiao } from '../testing/fixtures';
import { ExecucaoPrecoInvalidaError } from './execucaoPrecoFirestore';
import {
  ATRASO_PAUSA_PAGINA_PRECO_S,
  CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON,
  CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON,
  CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON,
  CAMPOS_VEZ_RESUMO_PRECO_AMAZON,
  type DepsExecucaoPrecoAmazon,
  type FilaExecucaoPrecoAmazon,
  JANELA_TAREFAS_EXECUCAO_PRECO_MS,
  MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON,
  RECLAMACAO_EXECUCAO_PRECO_MS,
  RETOMADA_EXECUCAO_PRECO_MS,
  VezPrecoInvalidaError,
  cancelarExecucaoPrecoAmazon,
  criarProdutorExecucaoPrecoAmazon,
  decidirInicioExecucaoPrecoAmazon,
  iniciarExecucaoPrecoAmazon,
  resumoExecucaoPrecoAmazon,
  retomarExecucaoPrecoAmazon,
} from './inicioExecucaoPreco';
import { processarPrecoSkuAmazon } from './processarPreco';
import {
  type TarefaPaginaPrecoAmazon,
  nomePaginaPrecoAmazon,
  nomeRetomadaPrecoAmazon,
} from './tarefaPreco';

const CONTA = 'conta-preco-inicio';
const CAMINHO = `precosAmazon/${CONTA}`;
const CAMINHO_VEZ = `feedsAmazonEmCurso/preco-${CONTA}`;
const CAMINHO_VEZ_ESTOQUE = `feedsAmazonEmCurso/estoque-${CONTA}`;
const AGORA_MS = 1_800_000_000_000;
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;
const EXEC = 'exec-viva';
const NOVA = 'exec-nova';
const PEDIDO = { baixarPreco: true, confirmarReducaoEmMassa: false, solicitadaPor: 'uid-operador' };

/** Every `fetch` is a failure: nothing here may reach the network. */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

type EntradaExecucao = z.input<typeof execucaoPrecoAmazonSchema>;

/** A stored run, every default filled: live, started 3 h ago, never progressed. */
function execucao(over: Partial<EntradaExecucao> = {}): ExecucaoPrecoAmazon {
  return execucaoPrecoAmazonSchema.parse({
    execucaoId: EXEC,
    fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
    baixarPreco: false,
    solicitadaPor: 'uid-antigo',
    iniciadaEmMs: AGORA_MS - 3 * HORA_MS,
    ...over,
  });
}

/** One batch Decide named. */
function lote(over: Record<string, unknown> = {}) {
  return { execucaoIdLote: 'exec-viva-l0', parteInicial: 0, partes: 1, itens: 40, ...over };
}

interface Enfileirada {
  readonly tarefa: TarefaPaginaPrecoAmazon;
  readonly opcoes: OpcoesDaTarefaListingAmazon | undefined;
}

/**
 * A queue that records every enqueue with its options and, like Cloud Tasks,
 * refuses a task id it already holds; `falha` (when set) runs FIRST and may
 * reject the enqueue.
 */
function filaGravadora() {
  const ids = new Set<string>();
  const enfileiradas: Enfileirada[] = [];
  const estado: { falha: ((t: TarefaPaginaPrecoAmazon) => Error | undefined) | null } = {
    falha: null,
  };
  const fila: FilaExecucaoPrecoAmazon = {
    enqueue: (tarefa, opcoes) => {
      const erro = estado.falha?.(tarefa);
      if (erro !== undefined) return Promise.reject(erro);
      if (opcoes?.id !== undefined) {
        if (ids.has(opcoes.id)) return Promise.reject(falhaDeTarefaJaExistente(opcoes.id));
        ids.add(opcoes.id);
      }
      enfileiradas.push({ tarefa, opcoes });
      return Promise.resolve();
    },
  };
  const resolver = vi.fn(() => fila);
  return { fila, resolver, enfileiradas, estado };
}

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly fila: ReturnType<typeof filaGravadora>;
  relogio: number;
  filaDesligada: boolean;
  produtorDesligado: boolean;
  readonly produtores: { construidos: number };
  readonly ids: string[];
  deps(): DepsExecucaoPrecoAmazon;
}

function cenario(run: ExecucaoPrecoAmazon | null = null): Cenario {
  const fake = new FakeDb();
  fake.exigirMascaraEm('precosAmazon');
  fake.exigirMascaraEm('feedsAmazonEmCurso');
  if (run !== null) fake.seed(CAMINHO, run);
  const log = loggerEspiao();
  const fila = filaGravadora();
  const c: Cenario = {
    fake,
    log,
    fila,
    relogio: AGORA_MS,
    filaDesligada: false,
    produtorDesligado: false,
    produtores: { construidos: 0 },
    ids: [NOVA, 'exec-nova-2', 'exec-nova-3'],
    deps: () => ({
      filaDesligada: c.filaDesligada,
      produtor: () => {
        c.produtores.construidos += 1;
        return criarProdutorExecucaoPrecoAmazon({
          fila: fila.resolver,
          desligado: c.produtorDesligado,
        });
      },
      agora: () => c.relogio,
      gerarExecucaoId: () => c.ids.shift() ?? 'exec-esgotado',
      logger: log.logger,
    }),
  };
  return c;
}

const iniciar = (c: Cenario, pedido = PEDIDO) =>
  iniciarExecucaoPrecoAmazon(asDb(c.fake), CONTA, pedido, c.deps());
const cancelar = (c: Cenario) => cancelarExecucaoPrecoAmazon(asDb(c.fake), CONTA, c.deps());
const resumo = (c: Cenario) => resumoExecucaoPrecoAmazon(asDb(c.fake), CONTA, c.deps());
const retomar = (c: Cenario) => retomarExecucaoPrecoAmazon(asDb(c.fake), CONTA, c.deps());
const pagina0 = (execucaoId: string) => nomePaginaPrecoAmazon(CONTA, execucaoId, 0);
const metas = (c: Cenario) => c.log.linhas.map((l) => [l.nivel, l.meta] as const);

/* -------------------------------------------------------------------------- */

describe('criarProdutorExecucaoPrecoAmazon — the pages on the jobs queue', () => {
  it('★ closed: every entry rejects with the JOBS queue’s class and the queue is NEVER resolved', async () => {
    const { resolver, enfileiradas } = filaGravadora();
    const p = criarProdutorExecucaoPrecoAmazon({ fila: resolver, desligado: true });
    for (const tentativa of [
      p.enfileirarPagina(CONTA, EXEC, 0),
      p.enfileirarRetomada(CONTA, EXEC, 2, AGORA_MS),
      p.enfileirarPausa(CONTA, EXEC, 2),
    ]) {
      await expect(tentativa).rejects.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(enfileiradas).toEqual([]);
  });

  it('★ a page is NAMED by (conta, run, page), its payload the strict page payload, no delay; twice is ONE task', async () => {
    const { resolver, enfileiradas } = filaGravadora();
    const p = criarProdutorExecucaoPrecoAmazon({ fila: resolver, desligado: false });
    expect(await p.enfileirarPagina(CONTA, EXEC, 3)).toBe('enfileirada');
    expect(await p.enfileirarPagina(CONTA, EXEC, 3)).toBe('ja-enfileirada');
    expect(enfileiradas).toEqual([
      {
        tarefa: { v: 1, tipo: 'preco-pagina', contaId: CONTA, execucaoId: EXEC, pagina: 3 },
        opcoes: { id: nomePaginaPrecoAmazon(CONTA, EXEC, 3) },
      },
    ]);
    // NEAR-MISS: the next page, or another run's same page, is another name.
    expect(await p.enfileirarPagina(CONTA, EXEC, 4)).toBe('enfileirada');
    expect(await p.enfileirarPagina(CONTA, 'exec-outra', 3)).toBe('enfileirada');
  });

  it('★ a re-kick is NAMED by the stall: the same stall twice is one task, a new stall a new name, never the page’s own name', async () => {
    const { resolver, enfileiradas } = filaGravadora();
    const p = criarProdutorExecucaoPrecoAmazon({ fila: resolver, desligado: false });
    expect(await p.enfileirarRetomada(CONTA, EXEC, 2, AGORA_MS)).toBe('enfileirada');
    expect(await p.enfileirarRetomada(CONTA, EXEC, 2, AGORA_MS)).toBe('ja-enfileirada');
    expect(await p.enfileirarRetomada(CONTA, EXEC, 2, AGORA_MS + 1)).toBe('enfileirada');
    expect(enfileiradas.map((e) => e.opcoes?.id)).toEqual([
      nomeRetomadaPrecoAmazon(CONTA, EXEC, 2, AGORA_MS),
      nomeRetomadaPrecoAmazon(CONTA, EXEC, 2, AGORA_MS + 1),
    ]);
    expect(enfileiradas[0]?.opcoes?.id).not.toBe(nomePaginaPrecoAmazon(CONTA, EXEC, 2));
    expect(enfileiradas[0]?.tarefa).toEqual({
      v: 1,
      tipo: 'preco-pagina',
      contaId: CONTA,
      execucaoId: EXEC,
      pagina: 2,
    });
  });

  it(`★ a throttled page’s pause is UNNAMED, ${String(ATRASO_PAUSA_PAGINA_PRECO_S)} s later: twice is two tasks`, async () => {
    const { resolver, enfileiradas } = filaGravadora();
    const p = criarProdutorExecucaoPrecoAmazon({ fila: resolver, desligado: false });
    await p.enfileirarPausa(CONTA, EXEC, 5);
    await p.enfileirarPausa(CONTA, EXEC, 5);
    expect(enfileiradas.map((e) => e.opcoes)).toEqual([
      { scheduleDelaySeconds: 60 },
      { scheduleDelaySeconds: 60 },
    ]);
    expect(enfileiradas[0]?.tarefa.pagina).toBe(5);
  });

  it('a payload or a name outside its grammar is refused BEFORE the enqueue starts', async () => {
    const { resolver, enfileiradas } = filaGravadora();
    const p = criarProdutorExecucaoPrecoAmazon({ fila: resolver, desligado: false });
    await expect(p.enfileirarPagina(CONTA, EXEC, -1)).rejects.toBeInstanceOf(ZodError);
    await expect(p.enfileirarPagina(CONTA, 'exec/1', 0)).rejects.toBeInstanceOf(ZodError);
    await expect(p.enfileirarRetomada(CONTA, EXEC, 0, -1)).rejects.toBeInstanceOf(RangeError);
    expect(resolver).not.toHaveBeenCalled();
    expect(enfileiradas).toEqual([]);
  });

  it('a Cloud Tasks hiccup comes out NAMED (the shared transient naming)', async () => {
    const f = filaGravadora();
    f.estado.falha = () => falhaDoFunctions('unknown-error', 503);
    const p = criarProdutorExecucaoPrecoAmazon({ fila: f.resolver, desligado: false });
    await expect(p.enfileirarPagina(CONTA, EXEC, 0)).rejects.toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('iniciarExecucaoPrecoAmazon — ★ the claim', () => {
  it('★ no run ⇒ CREATED (a fresh id, walking, the request stored, the clock), then page 0 enqueued NAMED: 202, not a re-kick', async () => {
    const c = cenario();
    const r = await iniciar(c);
    expect(r).toEqual({ ok: true, acao: 'iniciada', corpo: { execucaoId: NOVA, retomada: false } });
    expect(c.fake.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['create', CAMINHO]]);
    expect(c.fake.ler(CAMINHO)).toEqual(
      execucao({
        execucaoId: NOVA,
        baixarPreco: true,
        solicitadaPor: 'uid-operador',
        iniciadaEmMs: AGORA_MS,
      }),
    );
    expect(c.fila.enfileiradas).toEqual([
      {
        tarefa: { v: 1, tipo: 'preco-pagina', contaId: CONTA, execucaoId: NOVA, pagina: 0 },
        opcoes: { id: pagina0(NOVA) },
      },
    ]);
    expect(c.fake.leiturasDetalhadas.map((l) => l.mascara)).toEqual([
      [...CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON],
    ]);
    expect(metas(c)).toEqual([
      [
        'info',
        expect.objectContaining({
          evento: 'preco',
          conta: CONTA,
          fluxo: 'preco',
          fase: 'execucao',
          etapa: 'inicio',
          acao: 'iniciada',
          execucaoId: NOVA,
          pagina: 0,
        }),
      ],
    ]);
  });

  it('the request’s mass-decrease confirmation is stored as given', async () => {
    const c = cenario();
    await iniciar(c, { ...PEDIDO, baixarPreco: false, confirmarReducaoEmMassa: true });
    expect(c.fake.ler(CAMINHO)).toMatchObject({
      baixarPreco: false,
      confirmarReducaoEmMassa: true,
    });
  });

  it('★ a live run 10 min without progress ⇒ 409 EM_CURSO with ITS id: nothing written, nothing enqueued, no producer built', async () => {
    const c = cenario(execucao({ progressoEmMs: AGORA_MS - 10 * MINUTO_MS }));
    const r = await iniciar(c);
    expect(r).toEqual({
      ok: false,
      codigo: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
      execucaoId: EXEC,
      motivo: null,
    });
    expect(c.fake.escritas).toEqual([]);
    expect(c.produtores.construidos).toBe(0);
    expect(metas(c)).toEqual([
      ['info', expect.objectContaining({ acao: 'em-curso', execucaoId: EXEC })],
    ]);
  });

  it('★ a live run 16 min without progress ⇒ its next page RE-KICKED, named by the stall: 202 with the SAME id, retomada; nothing written; a double click is ONE task', async () => {
    const progresso = AGORA_MS - 16 * MINUTO_MS;
    const c = cenario(execucao({ fase: 'decidindo', proximaPagina: 7, progressoEmMs: progresso }));
    expect(await iniciar(c)).toEqual({
      ok: true,
      acao: 'retomada',
      corpo: { execucaoId: EXEC, retomada: true },
    });
    expect(await iniciar(c)).toEqual({
      ok: true,
      acao: 'ja-retomada',
      corpo: { execucaoId: EXEC, retomada: true },
    });
    expect(c.fake.escritas).toEqual([]);
    expect(c.fila.enfileiradas).toEqual([
      {
        tarefa: { v: 1, tipo: 'preco-pagina', contaId: CONTA, execucaoId: EXEC, pagina: 7 },
        opcoes: { id: nomeRetomadaPrecoAmazon(CONTA, EXEC, 7, progresso) },
      },
    ]);
  });

  it('★ the stall’s boundary: EXACTLY 15 min ⇒ re-kicked (NEAR-MISS: 15 min − 1 ms ⇒ 409)', async () => {
    const no = cenario(execucao({ progressoEmMs: AGORA_MS - RETOMADA_EXECUCAO_PRECO_MS }));
    expect(await iniciar(no)).toMatchObject({ ok: true, acao: 'retomada' });
    const antes = cenario(execucao({ progressoEmMs: AGORA_MS - RETOMADA_EXECUCAO_PRECO_MS + 1 }));
    expect(await iniciar(antes)).toMatchObject({ ok: false, execucaoId: EXEC });
    expect(antes.fila.enfileiradas).toEqual([]);
  });

  it('★ a run whose page 0 never ran stalls on its CLAIM stamp, and is re-kicked at page 0 by that stall', async () => {
    const iniciada = AGORA_MS - 20 * MINUTO_MS;
    const c = cenario(execucao({ iniciadaEmMs: iniciada, progressoEmMs: null }));
    expect(await iniciar(c)).toMatchObject({ ok: true, acao: 'retomada' });
    expect(c.fila.enfileiradas.map((e) => e.opcoes?.id)).toEqual([
      nomeRetomadaPrecoAmazon(CONTA, EXEC, 0, iniciada),
    ]);
  });

  it('★ a live run 2 h 1 min without progress ⇒ RECLAIMED with a NEW id: the old run replaced whole under its precondition, page 0 of the NEW id', async () => {
    const velha = execucao({
      proximaPagina: 9,
      proximaParte: 2,
      itensPorParte: [5, 6],
      amostraReducoes: ['A:10>9'],
      contagens: { enviaveis: 11 },
      progressoEmMs: AGORA_MS - RECLAMACAO_EXECUCAO_PRECO_MS - MINUTO_MS,
    });
    const c = cenario(velha);
    const r = await iniciar(c);
    expect(r).toEqual({ ok: true, acao: 'iniciada', corpo: { execucaoId: NOVA, retomada: false } });
    expect(c.fake.escritas.map((e) => [e.verbo, e.comPrecondicao])).toEqual([['update', true]]);
    expect(c.fake.ler(CAMINHO)).toEqual(
      execucao({
        execucaoId: NOVA,
        baixarPreco: true,
        solicitadaPor: 'uid-operador',
        iniciadaEmMs: AGORA_MS,
      }),
    );
    expect(c.fila.enfileiradas.map((e) => e.opcoes?.id)).toEqual([pagina0(NOVA)]);
    expect(metas(c)).toEqual([
      ['info', expect.objectContaining({ acao: 'iniciada', reivindicacao: 'reclamar' })],
    ]);
  });

  it('NEAR-MISS: EXACTLY 2 h without progress is still the same run — re-kicked, never reclaimed', async () => {
    const c = cenario(execucao({ progressoEmMs: AGORA_MS - RECLAMACAO_EXECUCAO_PRECO_MS }));
    expect(await iniciar(c)).toMatchObject({
      ok: true,
      acao: 'retomada',
      corpo: { execucaoId: EXEC },
    });
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ the reclaim’s threshold is 2 h in literal ms: 2 h − 1 ms idle ⇒ re-kicked under the SAME id; 2 h + 1 ms ⇒ reclaimed with a NEW id', async () => {
    const quase = cenario(execucao({ progressoEmMs: AGORA_MS - (2 * HORA_MS - 1) }));
    expect(await iniciar(quase)).toMatchObject({
      ok: true,
      acao: 'retomada',
      corpo: { execucaoId: EXEC, retomada: true },
    });
    expect(quase.fake.escritas).toEqual([]);
    const passou = cenario(execucao({ progressoEmMs: AGORA_MS - (2 * HORA_MS + 1) }));
    expect(await iniciar(passou)).toMatchObject({
      ok: true,
      acao: 'iniciada',
      corpo: { execucaoId: NOVA, retomada: false },
    });
  });

  it('★ the stall and the reclaim read the run’s LAST PROGRESS, not its start: started 3 h ago, progressed 10 min ago ⇒ 409', async () => {
    const c = cenario(
      execucao({ iniciadaEmMs: AGORA_MS - 3 * HORA_MS, progressoEmMs: AGORA_MS - 10 * MINUTO_MS }),
    );
    expect(await iniciar(c)).toMatchObject({ ok: false, execucaoId: EXEC });
    expect(c.fake.escritas).toEqual([]);
  });

  it.each(['concluida', 'cancelada', 'truncada', 'falhou'] as const)(
    '★ an ended run (%s), even 1 min old, ⇒ a NEW run',
    async (fase) => {
      const c = cenario(execucao({ fase, progressoEmMs: AGORA_MS - MINUTO_MS }));
      expect(await iniciar(c)).toMatchObject({
        ok: true,
        acao: 'iniciada',
        corpo: { execucaoId: NOVA },
      });
      expect(c.fake.ler(CAMINHO)).toMatchObject({ execucaoId: NOVA, fase: 'paginando' });
    },
  );

  it('★ a concurrent claim lands between the read and the write ⇒ re-read and re-decided: 409 with the WINNER’s id, nothing of ours written or enqueued', async () => {
    const c = cenario();
    c.fake.antesDaProximaEscrita(CAMINHO, () => {
      c.fake.seed(CAMINHO, execucao({ execucaoId: 'exec-vencedora', progressoEmMs: AGORA_MS }));
    });
    expect(await iniciar(c)).toEqual({
      ok: false,
      codigo: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
      execucaoId: 'exec-vencedora',
      motivo: null,
    });
    expect(c.fake.escritas).toEqual([]);
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('a generated id outside the feed core’s grammar is refused, nothing written', async () => {
    const c = cenario();
    c.ids.splice(0, c.ids.length, 'exec/ruim');
    await expect(iniciar(c)).rejects.toBeInstanceOf(RangeError);
    expect(c.fake.escritas).toEqual([]);
  });

  it('a request outside its shape, or a conta outside its grammar, is refused with ZERO Firestore operations', async () => {
    const c = cenario(execucao());
    await expect(iniciar(c, { ...PEDIDO, solicitadaPor: 'a/b' })).rejects.toBeInstanceOf(ZodError);
    await expect(
      iniciar(c, { ...PEDIDO, extra: true } as unknown as typeof PEDIDO),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      iniciarExecucaoPrecoAmazon(asDb(c.fake), 'a/b', PEDIDO, c.deps()),
    ).rejects.toBeInstanceOf(RangeError);
    expect(c.fake.operacoes).toBe(0);
  });

  it('a stored run that no longer parses is never overwritten: the claim throws, nothing written', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO, { execucaoId: EXEC, fase: 'voando' });
    await expect(iniciar(c)).rejects.toBeInstanceOf(ExecucaoPrecoInvalidaError);
    expect(c.fake.escritas).toEqual([]);
    expect(c.produtores.construidos).toBe(0);
  });
});

describe('decidirInicioExecucaoPrecoAmazon — the claim’s decision, pure', () => {
  const run = (over: Partial<EntradaExecucao>) => execucao(over);
  it('absent ⇒ criar; ended ⇒ reclamar; live past 2 h ⇒ reclamar; stalled ⇒ retomar at its next page; else em-curso', () => {
    expect(decidirInicioExecucaoPrecoAmazon(null, AGORA_MS)).toEqual({ tipo: 'criar' });
    expect(
      decidirInicioExecucaoPrecoAmazon(
        run({ fase: FASE_EXECUCAO_PRECO_AMAZON.concluida, progressoEmMs: AGORA_MS }),
        AGORA_MS,
      ),
    ).toEqual({ tipo: 'reclamar' });
    expect(
      decidirInicioExecucaoPrecoAmazon(
        run({ progressoEmMs: AGORA_MS - RECLAMACAO_EXECUCAO_PRECO_MS - 1 }),
        AGORA_MS,
      ),
    ).toEqual({ tipo: 'reclamar' });
    expect(
      decidirInicioExecucaoPrecoAmazon(
        run({ proximaPagina: 3, progressoEmMs: AGORA_MS - RETOMADA_EXECUCAO_PRECO_MS }),
        AGORA_MS,
      ),
    ).toEqual({ tipo: 'retomar', pagina: 3, marcoMs: AGORA_MS - RETOMADA_EXECUCAO_PRECO_MS });
    expect(decidirInicioExecucaoPrecoAmazon(run({ progressoEmMs: AGORA_MS }), AGORA_MS)).toEqual({
      tipo: 'em-curso',
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('iniciarExecucaoPrecoAmazon — ★ the claim’s failures', () => {
  it('★ (mutation 10) AMAZON_TASKS_DISABLED=1 ⇒ 503 fila-desligada with ZERO Firestore operations: no read, no claim, no producer — even over a stalled run', async () => {
    for (const run of [null, execucao({ progressoEmMs: AGORA_MS - HORA_MS })]) {
      const c = cenario(run);
      c.filaDesligada = true;
      expect(await iniciar(c)).toEqual({
        ok: false,
        codigo: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
        execucaoId: null,
        motivo: MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.filaDesligada,
      });
      expect(c.fake.operacoes).toBe(0);
      expect(c.produtores.construidos).toBe(0);
      expect(metas(c)).toEqual([
        ['warn', expect.objectContaining({ etapa: 'inicio', acao: 'fila-desligada' })],
      ]);
    }
  });

  it('NEAR-MISS: the valve open ⇒ claimed (the run walking, page 0 queued)', async () => {
    const c = cenario();
    c.filaDesligada = false;
    expect(await iniciar(c)).toMatchObject({ ok: true });
    expect(c.fake.ler(CAMINHO)).toMatchObject({ fase: 'paginando' });
    expect(c.fila.enfileiradas).toHaveLength(1);
  });

  it.each([
    [
      'a Cloud Tasks hiccup',
      () => falhaDoFunctions('unknown-error', 503),
      'AmazonTarefasTransitoriasError',
    ],
    ['a socket failure', () => falhaDoApp('network-error'), 'AmazonTarefasTransitoriasError'],
    [
      'a raw deploy-shaped refusal',
      () => falhaDoFunctions('permission-denied', 403),
      'FirebaseFunctionsError/functions/permission-denied',
    ],
    [
      'a missing region',
      () => new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']),
      'MissingRegionError',
    ],
    [
      'a malformed region',
      () => new AmazonLotesRegiaoDaFilaInvalidaError(),
      'AmazonLotesRegiaoDaFilaInvalidaError',
    ],
  ])(
    '★ page 0’s enqueue failing (%s) ⇒ the run closed falhou on the claim’s precondition, and 503 enfileiramento-incerto with its id',
    async (_nome, falha, classe) => {
      const c = cenario();
      c.fila.estado.falha = falha;
      expect(await iniciar(c)).toEqual({
        ok: false,
        codigo: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
        execucaoId: NOVA,
        motivo: MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.incerto,
      });
      expect(c.fake.escritas.map((e) => [e.verbo, e.dados, e.comPrecondicao])).toEqual([
        ['create', expect.objectContaining({ execucaoId: NOVA, fase: 'paginando' }), false],
        ['update', { fase: 'falhou', motivo: 'enfileiramento-falhou' }, true],
      ]);
      expect(c.fake.ler(CAMINHO)).toMatchObject({
        execucaoId: NOVA,
        fase: 'falhou',
        motivo: 'enfileiramento-falhou',
      });
      // The close wrote on the CLAIM's own commit: no read between them.
      expect(c.fake.leiturasDetalhadas).toHaveLength(1);
      expect(metas(c)).toEqual([
        [
          'error',
          expect.objectContaining({
            acao: 'enfileiramento-falhou',
            execucaoId: NOVA,
            falha: classe,
            motivo: 'enfileiramento-incerto',
            fechadaComoFalha: true,
          }),
        ],
      ]);
    },
  );

  it('★ the producer’s own valve class at page 0 ⇒ the run closed falhou too, answered fila-desligada', async () => {
    const c = cenario();
    c.produtorDesligado = true;
    expect(await iniciar(c)).toMatchObject({
      ok: false,
      execucaoId: NOVA,
      motivo: MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.filaDesligada,
    });
    expect(c.fake.ler(CAMINHO)).toMatchObject({ fase: 'falhou' });
  });

  it('★ a page 0 that DID land and progressed before the failure surfaced: the close re-derives (still this run, live) and closes it falhou (the landed page’s stop on that phase: execucaoPreco.test.ts, the falhou step-0 case)', async () => {
    const c = cenario();
    c.fila.estado.falha = (t) => {
      // The page ran meanwhile: it advanced the run (a commit the claim did not write).
      const atual = execucaoPrecoAmazonSchema.parse(c.fake.ler(CAMINHO));
      c.fake.seed(CAMINHO, { ...atual, proximaPagina: t.pagina + 1, progressoEmMs: AGORA_MS });
      return falhaDoFunctions('unknown-error', 503);
    };
    expect(await iniciar(c)).toMatchObject({ ok: false, execucaoId: NOVA });
    expect(c.fake.ler(CAMINHO)).toMatchObject({
      execucaoId: NOVA,
      fase: 'falhou',
      proximaPagina: 1,
    });
    expect(c.fake.leiturasDetalhadas.map((l) => l.mascara)).toEqual([
      [...CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON],
      [...CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON],
    ]);
  });

  it('★ NEAR-MISS: another run claimed between the claim and the close ⇒ the close re-derives and writes NOTHING over it', async () => {
    const c = cenario();
    const outra = execucao({ execucaoId: 'exec-outra', progressoEmMs: AGORA_MS });
    c.fila.estado.falha = () => {
      c.fake.seed(CAMINHO, outra);
      return falhaDoFunctions('unknown-error', 503);
    };
    expect(await iniciar(c)).toMatchObject({ ok: false, execucaoId: NOVA });
    expect(c.fake.ler(CAMINHO)).toEqual(outra);
    expect(metas(c)).toEqual([['error', expect.objectContaining({ fechadaComoFalha: false })]]);
  });

  it('★ NEAR-MISS: the same run CANCELLED between the claim and the close ⇒ the close re-derives and leaves the cancel standing', async () => {
    const c = cenario();
    c.fila.estado.falha = () => {
      const atual = execucaoPrecoAmazonSchema.parse(c.fake.ler(CAMINHO));
      c.fake.seed(CAMINHO, { ...atual, fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada });
      return falhaDoFunctions('unknown-error', 503);
    };
    expect(await iniciar(c)).toMatchObject({ ok: false, execucaoId: NOVA });
    expect(c.fake.ler(CAMINHO)).toMatchObject({
      execucaoId: NOVA,
      fase: 'cancelada',
      motivo: null,
    });
    expect(metas(c)).toEqual([['error', expect.objectContaining({ fechadaComoFalha: false })]]);
  });

  it('★ a re-kick’s enqueue failing ⇒ 503 enfileiramento-incerto with the stalled run’s id, and NOTHING written: the run stays stalled for the next click', async () => {
    const run = execucao({ proximaPagina: 4, progressoEmMs: AGORA_MS - 20 * MINUTO_MS });
    const c = cenario(run);
    c.fila.estado.falha = () => falhaDoFunctions('unknown-error', 503);
    expect(await iniciar(c)).toEqual({
      ok: false,
      codigo: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
      execucaoId: EXEC,
      motivo: 'enfileiramento-incerto',
    });
    expect(c.fake.escritas).toEqual([]);
    expect(c.fake.ler(CAMINHO)).toEqual(run);
  });

  it('★ crash order (the claim): an UNNAMED failure at page 0 crosses, the run left walking with no page — 409 within 15 min, then the next click re-kicks page 0 under the SAME id', async () => {
    const c = cenario();
    const bug = new TypeError('defeito de código');
    c.fila.estado.falha = () => bug;
    await expect(iniciar(c)).rejects.toBe(bug);
    expect(c.fake.ler(CAMINHO)).toMatchObject({ execucaoId: NOVA, fase: 'paginando' });
    expect(c.fake.escritas).toHaveLength(1);
    c.fila.estado.falha = null;
    c.relogio = AGORA_MS + 10 * MINUTO_MS;
    expect(await iniciar(c)).toMatchObject({ ok: false, execucaoId: NOVA });
    c.relogio = AGORA_MS + RETOMADA_EXECUCAO_PRECO_MS;
    expect(await iniciar(c)).toEqual({
      ok: true,
      acao: 'retomada',
      corpo: { execucaoId: NOVA, retomada: true },
    });
    expect(c.fila.enfileiradas.map((e) => [e.tarefa.pagina, e.opcoes?.id])).toEqual([
      [0, nomeRetomadaPrecoAmazon(CONTA, NOVA, 0, AGORA_MS)],
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe('retomarExecucaoPrecoAmazon — the re-kick', () => {
  it('the valve closed ⇒ fila-desligada with ZERO Firestore operations', async () => {
    const c = cenario(execucao({ progressoEmMs: AGORA_MS - HORA_MS }));
    c.filaDesligada = true;
    expect(await retomar(c)).toEqual({ acao: 'fila-desligada' });
    expect(c.fake.operacoes).toBe(0);
    expect(c.produtores.construidos).toBe(0);
  });

  it('★ a stalled run ⇒ its next page named by the stall; again ⇒ ja-retomada (one task); nothing written', async () => {
    const progresso = AGORA_MS - 30 * MINUTO_MS;
    const c = cenario(execucao({ proximaPagina: 2, progressoEmMs: progresso }));
    expect(await retomar(c)).toEqual({ acao: 'retomada', execucaoId: EXEC, pagina: 2 });
    expect(await retomar(c)).toEqual({ acao: 'ja-retomada', execucaoId: EXEC, pagina: 2 });
    expect(c.fila.enfileiradas.map((e) => e.opcoes?.id)).toEqual([
      nomeRetomadaPrecoAmazon(CONTA, EXEC, 2, progresso),
    ]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('NEAR-MISS: a run with progress, an ended run, or no run ⇒ nothing enqueued, never a claim', async () => {
    const viva = cenario(execucao({ progressoEmMs: AGORA_MS - MINUTO_MS }));
    expect(await retomar(viva)).toEqual({ acao: 'sem-retomada', execucaoId: EXEC });
    const acabada = cenario(execucao({ fase: 'concluida', progressoEmMs: AGORA_MS - HORA_MS }));
    expect(await retomar(acabada)).toEqual({ acao: 'sem-retomada', execucaoId: EXEC });
    const nenhuma = cenario();
    expect(await retomar(nenhuma)).toEqual({ acao: 'sem-execucao' });
    for (const c of [viva, acabada, nenhuma]) {
      expect(c.fila.enfileiradas).toEqual([]);
      expect(c.fake.escritas).toEqual([]);
    }
  });

  it('an enqueue failure reaches the caller untouched', async () => {
    const c = cenario(execucao({ progressoEmMs: AGORA_MS - HORA_MS }));
    c.fila.estado.falha = () => falhaDoFunctions('unknown-error', 503);
    await expect(retomar(c)).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
  });
});

/* -------------------------------------------------------------------------- */

describe('cancelarExecucaoPrecoAmazon — ★ Cancel', () => {
  it.each(['paginando', 'decidindo'] as const)(
    '★ a %s run ⇒ cancelada: ONE patch of the phase alone, on the read’s precondition',
    async (fase) => {
      const c = cenario(execucao({ fase, progressoEmMs: AGORA_MS - MINUTO_MS }));
      expect(await cancelar(c)).toEqual({
        ok: true,
        acao: 'cancelada',
        corpo: { execucaoId: EXEC, fase: 'cancelada' },
      });
      expect(c.fake.escritas.map((e) => [e.verbo, e.dados, e.comPrecondicao])).toEqual([
        ['update', { fase: 'cancelada' }, true],
      ]);
      expect(c.fake.leiturasDetalhadas.map((l) => l.mascara)).toEqual([
        [...CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON],
      ]);
      expect(metas(c)).toEqual([
        [
          'info',
          expect.objectContaining({
            etapa: 'cancelamento',
            acao: 'cancelada',
            execucaoId: EXEC,
            faseExecucao: 'cancelada',
          }),
        ],
      ]);
    },
  );

  it('★ a concluida run with a PENDING batch (no end, its wait not over) ⇒ cancelada', async () => {
    const c = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'lotes',
        progressoEmMs: AGORA_MS - 5 * HORA_MS,
        esperaLotesAteMs: AGORA_MS + HORA_MS,
        lotes: { '0': lote({ desfecho: 'concluido' }), '1': lote({ parteInicial: 1 }) },
      }),
    );
    expect(await cancelar(c)).toMatchObject({ ok: true, acao: 'cancelada' });
    expect(c.fake.ler(CAMINHO)).toMatchObject({ fase: 'cancelada' });
  });

  it('★ NEAR-MISS: the same batch once the wait is over (at esperaLotesAteMs EXACTLY), and every batch ended ⇒ answered unchanged', async () => {
    const semDesfecho = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'lotes',
        progressoEmMs: AGORA_MS - 5 * HORA_MS,
        esperaLotesAteMs: AGORA_MS,
        lotes: { '0': lote() },
      }),
    );
    expect(await cancelar(semDesfecho)).toEqual({
      ok: true,
      acao: 'inalterada',
      corpo: { execucaoId: EXEC, fase: 'concluida' },
    });
    const encerrados = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'lotes',
        progressoEmMs: AGORA_MS - 5 * HORA_MS,
        esperaLotesAteMs: AGORA_MS + HORA_MS,
        lotes: {
          '0': lote({ desfecho: 'falhou' }),
          '1': lote({ desfecho: 'sem-envio', motivoSemEnvio: 'simulado' }),
        },
      }),
    );
    expect(await cancelar(encerrados)).toMatchObject({ ok: true, acao: 'inalterada' });
    expect([...semDesfecho.fake.escritas, ...encerrados.fake.escritas]).toEqual([]);
  });

  it.each(['tarefas', 'canario'] as const)(
    '★ a concluida run whose decisao is %s, decided 10 min ago (tasks may still be queued) ⇒ cancelada',
    async (decisao) => {
      const c = cenario(
        execucao({ fase: 'concluida', decisao, progressoEmMs: AGORA_MS - 10 * MINUTO_MS }),
      );
      expect(await cancelar(c)).toMatchObject({ ok: true, acao: 'cancelada' });
    },
  );

  it('★ NEAR-MISS: the same decided EXACTLY 2 h ago with every batch ended ⇒ answered unchanged; and the window reads Decide’s progress, not the start', async () => {
    const velha = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'tarefas',
        progressoEmMs: AGORA_MS - JANELA_TAREFAS_EXECUCAO_PRECO_MS,
      }),
    );
    expect(await cancelar(velha)).toMatchObject({ ok: true, acao: 'inalterada' });
    const iniciadaHaMuito = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'tarefas',
        iniciadaEmMs: AGORA_MS - 5 * HORA_MS,
        progressoEmMs: AGORA_MS - 10 * MINUTO_MS,
      }),
    );
    expect(await cancelar(iniciadaHaMuito)).toMatchObject({ ok: true, acao: 'cancelada' });
  });

  it('★ the cancel’s task window is 2 h in literal ms: decided 2 h − 1 ms ago ⇒ cancelada; decided 2 h ago ⇒ answered unchanged', async () => {
    const dentro = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'canario',
        progressoEmMs: AGORA_MS - (2 * HORA_MS - 1),
      }),
    );
    expect(await cancelar(dentro)).toMatchObject({ ok: true, acao: 'cancelada' });
    const fora = cenario(
      execucao({ fase: 'concluida', decisao: 'canario', progressoEmMs: AGORA_MS - 2 * HORA_MS }),
    );
    expect(await cancelar(fora)).toMatchObject({ ok: true, acao: 'inalterada' });
    expect(fora.fake.escritas).toEqual([]);
  });

  it.each([
    ['concluida', 'nada'],
    ['concluida', 'dry-run'],
    ['concluida', 'reducao-em-massa'],
    ['concluida', 'lotes'],
    ['truncada', null],
    ['falhou', null],
    ['cancelada', 'tarefas'],
  ] as const)(
    'a %s run (decisao %s) with nothing in flight ⇒ answered unchanged, nothing written',
    async (fase, decisao) => {
      const c = cenario(execucao({ fase, decisao, progressoEmMs: AGORA_MS - MINUTO_MS }));
      expect(await cancelar(c)).toEqual({
        ok: true,
        acao: 'inalterada',
        corpo: { execucaoId: EXEC, fase },
      });
      expect(c.fake.escritas).toEqual([]);
    },
  );

  it('no run ⇒ EXECUCAO_NAO_ENCONTRADA, nothing written', async () => {
    const c = cenario();
    expect(await cancelar(c)).toEqual({
      ok: false,
      codigo: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA,
    });
    expect(c.fake.escritas).toEqual([]);
    expect(metas(c)).toEqual([['info', expect.objectContaining({ acao: 'sem-execucao' })]]);
  });

  it('★ Decide lands between the cancel’s read and its write ⇒ re-read: the run now concluida with fresh tasks is STILL cancelled', async () => {
    const c = cenario(execucao({ fase: 'decidindo', progressoEmMs: AGORA_MS - MINUTO_MS }));
    c.fake.antesDaProximaEscrita(CAMINHO, () => {
      c.fake.seed(
        CAMINHO,
        execucao({ fase: 'concluida', decisao: 'tarefas', progressoEmMs: AGORA_MS }),
      );
    });
    expect(await cancelar(c)).toMatchObject({ ok: true, acao: 'cancelada' });
    expect(c.fake.ler(CAMINHO)).toMatchObject({ fase: 'cancelada', decisao: 'tarefas' });
  });

  it('★ NEAR-MISS: a NEW run claimed between the cancel’s read and its write ⇒ re-read, and the new run is answered unchanged — never cancelled in place of the one the cancel read', async () => {
    const c = cenario(
      execucao({ fase: 'concluida', decisao: 'tarefas', progressoEmMs: AGORA_MS - 10 * MINUTO_MS }),
    );
    const nova = execucao({ execucaoId: NOVA, iniciadaEmMs: AGORA_MS });
    c.fake.antesDaProximaEscrita(CAMINHO, () => {
      c.fake.seed(CAMINHO, nova);
    });
    expect(await cancelar(c)).toEqual({
      ok: true,
      acao: 'inalterada',
      corpo: { execucaoId: NOVA, fase: 'paginando' },
    });
    expect(c.fake.ler(CAMINHO)).toEqual(nova);
    expect(c.fake.escritas).toEqual([]);
    expect(c.fake.leiturasDetalhadas.map((l) => l.mascara)).toEqual([
      [...CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON],
      [...CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON],
    ]);
  });

  /** A run's task of this run, as Decide hands it to the jobs queue. */
  const tarefaDaExecucao = {
    v: 1,
    tipo: 'preco-sku',
    contaId: CONTA,
    sku: 'SKU-1',
    origem: 'execucao',
    referencia: EXEC,
    parte: 0,
    baixarPreco: true,
    solicitadoEmMs: AGORA_MS - 10 * MINUTO_MS,
    codigosAntes: [],
  };

  /** The price task over the same fake: the context and Amazon are spies that record any use. */
  async function despachar(c: Cenario) {
    const contextos = vi.fn(() => Promise.reject(new TypeError('teste: contexto alcançado')));
    const fetch = vi.fn(() => Promise.reject(new TypeError('teste: Amazon alcançada')));
    const r = await processarPrecoSkuAmazon(tarefaDaExecucao, {
      db: asDb(c.fake),
      ambiente: { ...AMBIENTE_LIGADO, AMAZON_MODO_PRECO: 'on', AMAZON_CANARIO_PRECO: '*' },
      agora: () => c.relogio,
      logger: loggerEspiao().logger,
      increment,
      carregarContexto: contextos,
      produtor: () => {
        throw new TypeError('teste: produtor alcançado');
      },
      soValidacao: false,
      registro: { tentativa: 0, idTarefa: 'tarefa-teste' },
      fetch,
    }).catch((e: unknown) => e);
    return { r, contextos, fetch };
  }

  it('★ a concluida run whose tasks are still queued, CANCELLED ⇒ each of them ends execucao-cancelada with zero Amazon calls and no context load', async () => {
    const c = cenario(
      execucao({ fase: 'concluida', decisao: 'tarefas', progressoEmMs: AGORA_MS - 10 * MINUTO_MS }),
    );
    await cancelar(c);
    const { r, contextos, fetch } = await despachar(c);
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'execucao-cancelada' });
    expect(contextos).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: the same run NOT cancelled ⇒ its task goes on past its run check, to its context', async () => {
    const c = cenario(
      execucao({ fase: 'concluida', decisao: 'tarefas', progressoEmMs: AGORA_MS - 10 * MINUTO_MS }),
    );
    const { contextos, fetch } = await despachar(c);
    expect(contextos).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('resumoExecucaoPrecoAmazon — ★ the status summary', () => {
  it('★ no run ⇒ null, and the lease is never read', async () => {
    const c = cenario();
    expect(await resumo(c)).toBeNull();
    expect(c.fake.leiturasDetalhadas.map((l) => [l.caminho, l.mascara])).toEqual([
      [CAMINHO, [...CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON]],
    ]);
  });

  it('★ the run as it stands, masked to the summary’s fields; the PRICE lease masked to its state and last write (never the stock lease)', async () => {
    const c = cenario(
      execucao({
        fase: 'concluida',
        decisao: 'tarefas',
        baixarPreco: true,
        confirmarReducaoEmMassa: true,
        contagens: { enviaveis: 3, desce: 1, porChave: { pai: 2 }, limiteTaxa: 5 },
        amostraReducoes: ['SKU-1:50>40'],
        progressoEmMs: AGORA_MS - MINUTO_MS,
      }),
    );
    c.fake.seed(CAMINHO_VEZ_ESTOQUE, {
      estado: 'enviado',
      ateMs: AGORA_MS,
      atualizadoEmMs: AGORA_MS,
    });
    const r = await resumo(c);
    expect(r).toEqual(
      resumoExecucaoPrecoAmazonSchema.parse({
        execucaoId: EXEC,
        fase: 'concluida',
        motivo: null,
        baixarPreco: true,
        confirmarReducaoEmMassa: true,
        decisao: 'tarefas',
        contagens: execucao({
          contagens: { enviaveis: 3, desce: 1, porChave: { pai: 2 }, limiteTaxa: 5 },
        }).contagens,
        amostraReducoes: ['SKU-1:50>40'],
        iniciadaEmMs: AGORA_MS - 3 * HORA_MS,
        progressoEmMs: AGORA_MS - MINUTO_MS,
        esperaLotesAteMs: null,
        parada: false,
        lotes: [],
        feedEmCurso: null,
      }),
    );
    expect(c.fake.leiturasDetalhadas.map((l) => [l.caminho, l.mascara])).toEqual([
      [CAMINHO, [...CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON]],
      [CAMINHO_VEZ, [...CAMPOS_VEZ_RESUMO_PRECO_AMAZON]],
    ]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ (mutation 12) a live run 15 min without PROGRESS ⇒ parada: true (NEAR-MISS: 14 min ⇒ false, though it STARTED 3 h ago)', async () => {
    const parada = cenario(execucao({ progressoEmMs: AGORA_MS - 15 * MINUTO_MS }));
    expect(await resumo(parada)).toMatchObject({ parada: true });
    const andando = cenario(execucao({ progressoEmMs: AGORA_MS - 14 * MINUTO_MS }));
    expect(await resumo(andando)).toMatchObject({ parada: false });
    // A run that never progressed stalls on its start; an ended one never does.
    expect(await resumo(cenario(execucao({ progressoEmMs: null })))).toMatchObject({
      parada: true,
    });
    expect(
      await resumo(cenario(execucao({ fase: 'concluida', progressoEmMs: AGORA_MS - HORA_MS }))),
    ).toMatchObject({ parada: false });
  });

  it('★ the price lease enviado, written 10 min ago ⇒ a feed in flight with its age; montando counts too; livre or absent ⇒ none', async () => {
    const run = execucao({ progressoEmMs: AGORA_MS });
    const lease = (estado: string, atualizadoEmMs: number) => {
      const c = cenario(run);
      c.fake.seed(CAMINHO_VEZ, {
        estado,
        execucaoId: 'lote-x',
        ateMs: AGORA_MS + HORA_MS,
        atualizadoEmMs,
      });
      return resumo(c);
    };
    expect((await lease('enviado', AGORA_MS - 10 * MINUTO_MS))?.feedEmCurso).toEqual({
      estado: 'enviado',
      idadeMs: 10 * MINUTO_MS,
    });
    expect((await lease('montando', AGORA_MS - MINUTO_MS))?.feedEmCurso).toEqual({
      estado: 'montando',
      idadeMs: MINUTO_MS,
    });
    expect((await lease('livre', AGORA_MS - MINUTO_MS))?.feedEmCurso).toBeNull();
    expect((await resumo(cenario(run)))?.feedEmCurso).toBeNull();
    // A holder's write stamped after our clock never reads as a negative age.
    expect((await lease('enviando', AGORA_MS + 5_000))?.feedEmCurso).toEqual({
      estado: 'enviando',
      idadeMs: 0,
    });
  });

  it('★ each batch by the PENDING rule: its recorded end; none and the wait not over ⇒ pendente; none at the deadline ⇒ sem-desfecho; in index order', async () => {
    const lotes = {
      '0': lote({ desfecho: 'concluido' }),
      '1': lote({ parteInicial: 1, desfecho: 'sem-envio', motivoSemEnvio: 'abortado' }),
      '2': lote({ parteInicial: 2 }),
      '10': lote({ parteInicial: 10 }),
      '3': lote({ parteInicial: 3 }),
      '4': lote({ parteInicial: 4 }),
      '5': lote({ parteInicial: 5 }),
      '6': lote({ parteInicial: 6 }),
      '7': lote({ parteInicial: 7 }),
      '8': lote({ parteInicial: 8 }),
      '9': lote({ parteInicial: 9 }),
    };
    const estados = async (esperaLotesAteMs: number | null) =>
      (
        await resumo(
          cenario(execucao({ fase: 'concluida', decisao: 'lotes', esperaLotesAteMs, lotes })),
        )
      )?.lotes.map((l) => [l.indice, l.estado, l.motivoSemEnvio]);
    const antes = await estados(AGORA_MS + 1);
    expect(antes?.slice(0, 3)).toEqual([
      [0, 'concluido', null],
      [1, 'sem-envio', 'abortado'],
      [2, 'pendente', null],
    ]);
    expect(antes?.map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await estados(AGORA_MS))?.slice(0, 3)).toEqual([
      [0, 'concluido', null],
      [1, 'sem-envio', 'abortado'],
      [2, 'sem-desfecho', null],
    ]);
    expect((await estados(null))?.[2]).toEqual([2, 'pendente', null]);
  });

  it('a price lease that no longer parses throws, naming its fields: the status never guesses a feed’s state', async () => {
    const c = cenario(execucao());
    c.fake.seed(CAMINHO_VEZ, { estado: 'voando', atualizadoEmMs: AGORA_MS });
    const erro = await resumo(c).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VezPrecoInvalidaError);
    expect((erro as VezPrecoInvalidaError).campos).toEqual(['estado']);
  });
});

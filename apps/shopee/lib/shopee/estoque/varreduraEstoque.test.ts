import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import type { MovimentosDaJanela, RawEstoqueRow } from '@delfrance/data/admin/estoque';
import {
  estoqueShopeeSyncCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeRateLimitError,
} from '@delfrance/integrations-shopee';
import { INTEGRACAO_TIPO, MODO_VARREDURA_ESTOQUE } from '@delfrance/schemas';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { SHOPEE_STOCK_SYNC_FLAG_ENV } from './constantesEstoque';
import { MOTIVO_ESTOQUE_SHOPEE, ShopeeStockTasksDisabledError } from './errosEstoque';
import type {
  FilhoDaFamilia,
  LinhaDeFamiliaShopee,
  LinkShopeeCru,
  PaginaDeFamiliasShopee,
  TarefaDeEstoqueShopee,
} from './planoEstoque';
import type { AgendadorEstoqueShopee } from './shopeeStockTasks';
import {
  type DepsDaVarreduraShopee,
  type LoggerDaVarredura,
  ehSlotDaReconciliacao,
  ehSlotDoDiario,
  janelaDoSweepShopee,
  runShopeeStockSweep,
} from './varreduraEstoque';
import type { EstadoEstoqueLido } from './estadoEstoque';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop or credential.    */
/* -------------------------------------------------------------------------- */

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const ESTADO_PATH = estoqueShopeeSyncCollection.resolvePath({});

const INT = 'int-1';
const OUTRA_INT = 'int-2';
const SHOP = 987654;
const OUTRO_SHOP = 987655;
const DEPOSITO_REF = 'documents/depositos/dep-1';
const DEPOSITO_ID = 'dep-1';
const OUTRO_DEPOSITO_REF = 'documents/depositos/dep-2';
const OUTRO_DEPOSITO_ID = 'dep-2';
const ITEM_ID = 2500139861;
const AGORA = 1_760_000_000_000;

/** The defaults the window reader uses when nothing is stubbed. */
const MIN_MS = 60_000;
const HORA_MS = 60 * 60 * 1000;
const JANELA_INCREMENTAL_MS = 15 * MIN_MS;
const OVERLAP_MS = 20 * 1000;
const JANELA_DIARIA_MS = 24 * HORA_MS;

function contaDoc(over: DocData = {}): DocData {
  return {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja de Teste',
    shop_id: SHOP,
    depositoOuterRef: DEPOSITO_REF,
    ...over,
  };
}

function estoqueRow(over: Partial<RawEstoqueRow> = {}): RawEstoqueRow {
  return {
    estoqueDocId: 'est-1',
    parentId: 'prod-a',
    quantidade: 7,
    quantidadeReservada: 0,
    ...over,
  };
}

function link(over: Partial<LinkShopeeCru> = {}): LinkShopeeCru {
  return {
    contaProdutoShopeeOuterRef: `integracao/${INT}`,
    linkDocId: 'link-1',
    item_id: ITEM_ID,
    estadoAnuncio: null,
    item_status: null,
    kitNativo: null,
    estoqueRecusaEm: null,
    estoqueRecusaAte: null,
    estoqueRecusaEstado: null,
    estoqueRecusaItemStatus: null,
    ...over,
  };
}

/**
 * ONE family, no children ⇒ a no-model listing carrying the anchor's quantity.
 *
 * `ultimaModificacao` is deliberately ABSENT by default: that is what keeps the
 * `estoqueDesauditado` arm quiet, so a family with an empty movement map reads
 * as genuinely UNCHANGED. The `enviando` helper below is the opposite fixture.
 */
function familia(over: Partial<LinhaDeFamiliaShopee> = {}): LinhaDeFamiliaShopee {
  const produtoId = (over.anchorId as string | undefined) ?? 'prod-a';
  return {
    anchorId: produtoId,
    anchor: {
      produtoId,
      ehKit: false,
      ehKitVirtual: false,
      publicado: true,
      componentesKit: null,
      timestampMs: null,
      estoque: estoqueRow({ parentId: produtoId }),
      componentEstoques: [],
    },
    integracoesComProduto: [INT, OUTRA_INT],
    links: [link()],
    children: [],
    ...over,
  };
}

/**
 * A family whose own estoque row moved INSIDE the window with no ledger row to
 * explain it (step 9's unaudited merge) — so its baseline is unknown and it
 * SENDS even against an empty movement map.
 */
function familiaQueEnvia(over: Partial<LinhaDeFamiliaShopee> = {}): LinhaDeFamiliaShopee {
  const base = familia(over);
  return {
    ...base,
    anchor: {
      ...base.anchor,
      estoque: estoqueRow({ parentId: base.anchorId, ultimaModificacao: AGORA - 1000 }),
    },
  };
}

function pagina(
  rows: readonly LinhaDeFamiliaShopee[],
  nextAfterAnchorId: string | null = null,
): PaginaDeFamiliasShopee {
  return { rows, nextAfterAnchorId };
}

class AgendadorFake implements AgendadorEstoqueShopee {
  readonly tarefas: TarefaDeEstoqueShopee[] = [];
  erro: Error | null = null;

  enqueue(payload: TarefaDeEstoqueShopee): Promise<void> {
    if (this.erro !== null) return Promise.reject(this.erro);
    this.tarefas.push(payload);
    return Promise.resolve();
  }
}

interface Linha {
  nivel: 'info' | 'warn' | 'error';
  msg: string;
  meta: Record<string, unknown> | undefined;
}

function loggerFake(): { linhas: Linha[]; logger: LoggerDaVarredura } {
  const linhas: Linha[] = [];
  return {
    linhas,
    logger: {
      info: (msg, meta) => linhas.push({ nivel: 'info', msg, meta }),
      warn: (msg, meta) => linhas.push({ nivel: 'warn', msg, meta }),
      error: (msg, meta) => linhas.push({ nivel: 'error', msg, meta }),
    },
  };
}

/** The gate stub every test uses unless it is the gate that is under test. */
const ACEITA: DepsDaVarreduraShopee['avaliarConta'] = () => Promise.resolve({ ok: true });

interface MontagemDeps {
  readonly paginas?: readonly PaginaDeFamiliasShopee[];
  readonly porConta?: Record<string, readonly PaginaDeFamiliasShopee[]>;
  readonly movimentos?: MovimentosDaJanela;
  readonly avaliarConta?: DepsDaVarreduraShopee['avaliarConta'];
  readonly nowMs?: number;
}

function montarDeps(opts: MontagemDeps = {}) {
  const agendador = new AgendadorFake();
  const { linhas, logger } = loggerFake();
  const chamadasDeFamilias: {
    integracaoId: string;
    changedSinceMs: number;
    afterAnchorId: string | null;
  }[] = [];
  const chamadasDeMovimentos: { desdeMs: number; depositoId: string }[] = [];
  const restantes = new Map<string, PaginaDeFamiliasShopee[]>();

  const deps: DepsDaVarreduraShopee = {
    scheduler: agendador,
    nowMs: opts.nowMs ?? AGORA,
    logger,
    avaliarConta: opts.avaliarConta ?? ACEITA,
    buscarFamilias: (_db, args) => {
      chamadasDeFamilias.push({
        integracaoId: args.integracaoId,
        changedSinceMs: args.changedSinceMs,
        afterAnchorId: args.afterAnchorId ?? null,
      });
      const fonte = restantes.get(args.integracaoId) ?? [
        ...(opts.porConta?.[args.integracaoId] ?? opts.paginas ?? [pagina([])]),
      ];
      restantes.set(args.integracaoId, fonte);
      return Promise.resolve(fonte.shift() ?? pagina([]));
    },
    buscarMovimentos: (_db, args) => {
      chamadasDeMovimentos.push({ desdeMs: args.desdeMs, depositoId: args.depositoId });
      return Promise.resolve(opts.movimentos ?? new Map());
    },
  };
  return { deps, agendador, linhas, chamadasDeFamilias, chamadasDeMovimentos };
}

/** Every write the sweep made to ONE conta's state document. */
function escritasDeEstado(db: FakeDb, integracaoId = INT): DocData[] {
  return db.writes.filter((w) => w.path === `${ESTADO_PATH}/${integracaoId}`).map((w) => w.patch);
}

function estadoVazio(over: Partial<EstadoEstoqueLido> = {}): EstadoEstoqueLido {
  return {
    cursorMs: null,
    lastSweepAtMs: null,
    lastDailyAtMs: null,
    lastReconciliacaoAtMs: null,
    lastError: null,
    lastErrorAtMs: null,
    pausadoAte: null,
    pausaMotivo: null,
    pausaCodigo: null,
    pauseCount: 0,
    ultimoMotivoConta: null,
    ultimoMotivoContaEmMs: null,
    continuacao: null,
    existe: false,
    ...over,
  };
}

beforeEach(() => {
  __resetAllReadCaches();
  vi.stubEnv(SHOPEE_STOCK_SYNC_FLAG_ENV, '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetAllReadCaches();
});

/* -------------------------------------------------------------------------- */
/*                                 THE VALVE                                  */
/* -------------------------------------------------------------------------- */

describe('runShopeeStockSweep — a válvula', () => {
  it('1 — desligada: devolve enabled false e NÃO lê uma única coisa do Firestore', async () => {
    // The flag is what stands between this code and a live marketplace. "No-op"
    // has to mean no read either: an enumeration that ran anyway would bill the
    // scan every quarter-hour for a feature nobody turned on.
    vi.stubEnv(SHOPEE_STOCK_SYNC_FLAG_ENV, '');
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, linhas } = montarDeps();

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(res).toEqual({ enabled: false, contas: [] });
    expect(db.caminhos).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.consultasCompletas).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('info');
  });

  it("2 — NEAR-MISS da válvula: '1' liga; qualquer outro valor não", async () => {
    // The near-miss of test 1: the flag is not truthiness, it is the literal.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    for (const valor of ['true', 'sim', '0', ' 1']) {
      vi.stubEnv(SHOPEE_STOCK_SYNC_FLAG_ENV, valor);
      const { deps } = montarDeps();
      expect(
        (await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps)).enabled,
      ).toBe(false);
    }
    vi.stubEnv(SHOPEE_STOCK_SYNC_FLAG_ENV, '1');
    const { deps } = montarDeps();
    expect(
      (await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps)).enabled,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                              THE LEDGER MEMO                               */
/* -------------------------------------------------------------------------- */

describe('runShopeeStockSweep — o memo do razão', () => {
  it('3 — tick ocioso (nenhuma família): buscarMovimentos é chamado ZERO vezes', async () => {
    // The memo holds the in-flight promise and only a family row that needs a
    // baseline resolves it. A tick that discovers nothing must cost nothing.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, chamadasDeMovimentos } = montarDeps({ paginas: [pagina([])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeMovimentos).toEqual([]);
  });

  it('4 — PAR: duas contas no MESMO depósito e na mesma janela compartilham UMA execução', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(
      `${INTEGRACAO_PATH}/${OUTRA_INT}`,
      contaDoc({ shop_id: OUTRO_SHOP, depositoOuterRef: DEPOSITO_REF }),
    );
    const { deps, chamadasDeMovimentos } = montarDeps({
      porConta: {
        [INT]: [pagina([familia()])],
        [OUTRA_INT]: [pagina([familia({ anchorId: 'prod-b' })])],
      },
    });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeMovimentos).toEqual([
      { desdeMs: AGORA - JANELA_INCREMENTAL_MS - OVERLAP_MS, depositoId: DEPOSITO_ID },
    ]);
  });

  it('5 — QUASE-PAR: duas contas em depósitos DIFERENTES pagam duas execuções', async () => {
    // The near-miss of test 4: the key is `<desdeMs>|<depositoId>`, and the
    // depósito half is not decoration — two contas on two depósitos are two
    // different ledgers and sharing one would reconstruct a confidently wrong
    // baseline for the second.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(
      `${INTEGRACAO_PATH}/${OUTRA_INT}`,
      contaDoc({ shop_id: OUTRO_SHOP, depositoOuterRef: OUTRO_DEPOSITO_REF }),
    );
    const { deps, chamadasDeMovimentos } = montarDeps({
      porConta: {
        [INT]: [pagina([familia()])],
        [OUTRA_INT]: [pagina([familia({ anchorId: 'prod-b' })])],
      },
    });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeMovimentos.map((c) => c.depositoId)).toEqual([DEPOSITO_ID, OUTRO_DEPOSITO_ID]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 THE TIERS                                  */
/* -------------------------------------------------------------------------- */

describe('runShopeeStockSweep — os três tiers', () => {
  it('6 — reconciliação: changedSinceMs −1, ZERO consultas ao razão, tudo enviado', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    // Deliberately the UNCHANGED family: on any other tier it would be skipped.
    const { deps, agendador, chamadasDeFamilias, chamadasDeMovimentos } = montarDeps({
      paginas: [pagina([familia()])],
    });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.reconciliacao, deps);

    expect(chamadasDeFamilias[0]?.changedSinceMs).toBe(-1);
    expect(chamadasDeMovimentos).toEqual([]);
    expect(agendador.tarefas).toHaveLength(1);
    expect(res.contas[0]?.inalterados).toBe(0);
    expect(res.contas[0]?.enqueued).toBe(1);
  });

  it('7 — reconciliação drenada carimba lastReconciliacaoAtMs e NUNCA cursorMs', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps } = montarDeps({ paginas: [pagina([familia()])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.reconciliacao, deps);

    const escritas = escritasDeEstado(db);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toEqual({
      lastSweepAtMs: AGORA,
      continuacao: null,
      lastError: null,
      lastReconciliacaoAtMs: AGORA,
    });
    expect(Object.keys(escritas[0] ?? {})).not.toContain('cursorMs');
  });

  it('8 — diário drenado carimba lastDailyAtMs e NUNCA cursorMs', async () => {
    // The near-miss of test 7 on the stamp axis: a nightly pass that moved the
    // incremental cursor would make the next quarter-hourly tick skip
    // everything the day's incremental ticks had not reached.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, chamadasDeFamilias } = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.diario, deps);

    expect(chamadasDeFamilias[0]?.changedSinceMs).toBe(AGORA - JANELA_DIARIA_MS);
    expect(escritasDeEstado(db)).toEqual([
      { lastSweepAtMs: AGORA, continuacao: null, lastError: null, lastDailyAtMs: AGORA },
    ]);
  });

  it('9 — incremental drenado avança cursorMs para o INÍCIO do sweep, não para nowMs', async () => {
    // `startedAtMs` on a fresh run IS `nowMs`, so this case cannot tell the two
    // apart — test 12 is the one that can, through a continuation. What this
    // pins is the patch's exact key set: cursor + continuação limpa + o motivo
    // da conta zerado.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps } = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(escritasDeEstado(db)).toEqual([
      {
        lastSweepAtMs: AGORA,
        continuacao: null,
        lastError: null,
        cursorMs: AGORA,
        ultimoMotivoConta: null,
      },
    ]);
  });

  it('10 — janela incremental: do cursor, limitada pelo lookback máximo', () => {
    expect(janelaDoSweepShopee(MODO_VARREDURA_ESTOQUE.incremental, AGORA, estadoVazio())).toEqual({
      changedSinceMs: AGORA - JANELA_INCREMENTAL_MS - OVERLAP_MS,
      movimentosDesdeMs: AGORA - JANELA_INCREMENTAL_MS - OVERLAP_MS,
      modo: MODO_VARREDURA_ESTOQUE.incremental,
    });
    // A warm cursor wins…
    const morno = AGORA - 5 * MIN_MS;
    expect(
      janelaDoSweepShopee(
        MODO_VARREDURA_ESTOQUE.incremental,
        AGORA,
        estadoVazio({ cursorMs: morno }),
      ).changedSinceMs,
    ).toBe(morno - OVERLAP_MS);
    // …and a cold one is bounded, or a conta offline for a month would scan it.
    expect(
      janelaDoSweepShopee(
        MODO_VARREDURA_ESTOQUE.incremental,
        AGORA,
        estadoVazio({ cursorMs: AGORA - 500 * HORA_MS }),
      ).changedSinceMs,
    ).toBe(AGORA - 24 * HORA_MS - OVERLAP_MS);
  });

  it('11 — a reconciliação é a ÚNICA janela com movimentosDesdeMs null', () => {
    // PAIR / NEAR-MISS on the tier axis: `-1` and `null` travel together, and
    // no other tier may produce either.
    expect(janelaDoSweepShopee(MODO_VARREDURA_ESTOQUE.reconciliacao, AGORA, estadoVazio())).toEqual(
      {
        changedSinceMs: -1,
        movimentosDesdeMs: null,
        modo: MODO_VARREDURA_ESTOQUE.reconciliacao,
      },
    );
    for (const modo of [MODO_VARREDURA_ESTOQUE.incremental, MODO_VARREDURA_ESTOQUE.diario]) {
      const janela = janelaDoSweepShopee(modo, AGORA, estadoVazio());
      expect(janela.movimentosDesdeMs).toBe(janela.changedSinceMs);
      expect(janela.changedSinceMs).toBeLessThan(AGORA);
      expect(janela.changedSinceMs).not.toBe(-1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                             THE CONTINUATION                               */
/* -------------------------------------------------------------------------- */

describe('runShopeeStockSweep — a continuação', () => {
  const CONTINUACAO = {
    afterAnchorId: 'prod-anterior',
    changedSinceMs: AGORA - 3 * HORA_MS,
    modo: MODO_VARREDURA_ESTOQUE.diario,
    movimentosDesdeMs: AGORA - 3 * HORA_MS,
    startedAtMs: AGORA - 2 * HORA_MS,
  };

  it('12 — uma continuação guardada VENCE o modo do tick: janela, política e posição congeladas', async () => {
    // The tick was invoked as `incremental`; the stored sweep is a `diario`.
    // What runs is the DIÁRIO, from ITS window and ITS keyset position.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${ESTADO_PATH}/${INT}`, { continuacao: { ...CONTINUACAO } });
    const { deps, chamadasDeFamilias, chamadasDeMovimentos } = montarDeps({
      paginas: [pagina([familiaQueEnvia()])],
    });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeFamilias).toEqual([
      {
        integracaoId: INT,
        changedSinceMs: CONTINUACAO.changedSinceMs,
        afterAnchorId: CONTINUACAO.afterAnchorId,
      },
    ]);
    expect(chamadasDeMovimentos).toEqual([
      { desdeMs: CONTINUACAO.movimentosDesdeMs, depositoId: DEPOSITO_ID },
    ]);
    // Drained ⇒ the DIÁRIO's own stamp, although an incremental tick ran it.
    expect(escritasDeEstado(db)).toEqual([
      { lastSweepAtMs: AGORA, continuacao: null, lastError: null, lastDailyAtMs: AGORA },
    ]);
  });

  it('13 — uma continuação INCREMENTAL drenada avança o cursor para o startedAtMs DELA', async () => {
    // The case test 9 cannot see: the cursor must land on the ORIGINAL sweep's
    // start, not on the tick that happened to finish it — anything that landed
    // between the two is still owed.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${ESTADO_PATH}/${INT}`, {
      continuacao: { ...CONTINUACAO, modo: MODO_VARREDURA_ESTOQUE.incremental },
    });
    const { deps } = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(escritasDeEstado(db)).toEqual([
      {
        lastSweepAtMs: AGORA,
        continuacao: null,
        lastError: null,
        cursorMs: CONTINUACAO.startedAtMs,
        ultimoMotivoConta: null,
      },
    ]);
  });

  it('14 — uma continuação MALFORMADA é ignorada e o tick deriva a própria janela', async () => {
    // NEAR-MISS of tests 12/13: a stored object missing `movimentosDesdeMs` is
    // malformed, and the safe answer is a freshly derived window — never an
    // inferred baseline.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${ESTADO_PATH}/${INT}`, {
      continuacao: {
        afterAnchorId: CONTINUACAO.afterAnchorId,
        changedSinceMs: CONTINUACAO.changedSinceMs,
        modo: CONTINUACAO.modo,
        startedAtMs: CONTINUACAO.startedAtMs,
      },
    });
    const { deps, chamadasDeFamilias } = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeFamilias).toEqual([
      {
        integracaoId: INT,
        changedSinceMs: AGORA - JANELA_INCREMENTAL_MS - OVERLAP_MS,
        afterAnchorId: null,
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               TRUNCATION                                   */
/* -------------------------------------------------------------------------- */

describe('runShopeeStockSweep — truncamento', () => {
  it('15 — cap de tasks: grava a continuação no ÚLTIMO anchor COMPLETO e não toca no cursor', async () => {
    // The family cut mid-way is NOT in the continuation: it is RE-processed,
    // because a re-enqueue is harmless (the send is verbatim) while a skipped
    // family is a silent permanent loss.
    vi.stubEnv('SHOPEE_STOCK_MAX_TASKS_PER_SWEEP', '1');
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, agendador } = montarDeps({
      paginas: [pagina([familiaQueEnvia(), familiaQueEnvia({ anchorId: 'prod-b' })])],
    });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(agendador.tarefas).toHaveLength(1);
    expect(res.contas[0]?.truncated).toBe(true);
    expect(escritasDeEstado(db)).toEqual([
      {
        lastSweepAtMs: AGORA,
        continuacao: {
          afterAnchorId: 'prod-a',
          changedSinceMs: AGORA - JANELA_INCREMENTAL_MS - OVERLAP_MS,
          modo: MODO_VARREDURA_ESTOQUE.incremental,
          movimentosDesdeMs: AGORA - JANELA_INCREMENTAL_MS - OVERLAP_MS,
          startedAtMs: AGORA,
        },
      },
    ]);
    expect(Object.keys(escritasDeEstado(db)[0] ?? {})).not.toContain('cursorMs');
  });

  it('16 — cap de páginas: mesma persistência, cursor intocado', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    // Eleven pages offered; the cap is ten.
    const paginas = Array.from({ length: 11 }, (_, i) =>
      pagina([familia({ anchorId: `prod-${i}` })], `prod-${i}`),
    );
    const { deps } = montarDeps({ paginas });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(res.contas[0]?.pages).toBe(10);
    expect(res.contas[0]?.truncated).toBe(true);
    const escritas = escritasDeEstado(db);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.continuacao).toMatchObject({ afterAnchorId: 'prod-9' });
    expect(Object.keys(escritas[0] ?? {})).not.toContain('cursorMs');
  });

  it('17 — NEAR-MISS: drenado na página 10 exata NÃO trunca e carimba o cursor', async () => {
    // The page cap is checked only when a NEXT page exists. Ten pages that
    // drain are a complete sweep, not a truncated one.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const paginas = Array.from({ length: 10 }, (_, i) =>
      pagina([familia({ anchorId: `prod-${i}` })], i === 9 ? null : `prod-${i}`),
    );
    const { deps } = montarDeps({ paginas });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(res.contas[0]?.pages).toBe(10);
    expect(res.contas[0]?.truncated).toBe(false);
    expect(escritasDeEstado(db)[0]).toMatchObject({ cursorMs: AGORA, continuacao: null });
  });
});

/* -------------------------------------------------------------------------- */
/*                          PAUSE, GATES AND COUNTING                         */
/* -------------------------------------------------------------------------- */

describe('runShopeeStockSweep — pausa, portões e contagem', () => {
  it('18 — conta pausada: pulada INTEIRA — sem portão, sem descoberta, sem escrita', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${ESTADO_PATH}/${INT}`, { pausadoAte: AGORA + MIN_MS, pausaMotivo: 'burst' });
    const avaliarConta = vi.fn(ACEITA);
    const { deps, agendador, chamadasDeFamilias } = montarDeps({
      paginas: [pagina([familiaQueEnvia()])],
      avaliarConta,
    });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(avaliarConta).not.toHaveBeenCalled();
    expect(chamadasDeFamilias).toEqual([]);
    expect(agendador.tarefas).toEqual([]);
    expect(escritasDeEstado(db)).toEqual([]);
    expect(res.contas[0]).toMatchObject({ paused: true, enqueued: 0, motivoConta: null });
  });

  it('19 — NEAR-MISS da pausa: pausadoAte === nowMs já expirou e a conta roda', async () => {
    // `estaPausada` is strictly `>`. The equality case is the one a re-enqueue
    // lands on, and reading it as still-paused spends an attempt on nothing.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${ESTADO_PATH}/${INT}`, { pausadoAte: AGORA, pausaMotivo: 'burst' });
    const { deps, chamadasDeFamilias } = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeFamilias).toHaveLength(1);
    expect(res.contas[0]?.paused).toBe(false);
  });

  it('20 — conta barrada por um portão: SÓ registrarMotivoDaConta, nada enfileirado', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, agendador, chamadasDeFamilias } = montarDeps({
      paginas: [pagina([familiaQueEnvia()])],
      avaliarConta: () =>
        Promise.resolve({ ok: false as const, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaFbs }),
    });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(chamadasDeFamilias).toEqual([]);
    expect(agendador.tarefas).toEqual([]);
    expect(escritasDeEstado(db)).toEqual([
      {
        ultimoMotivoConta: MOTIVO_ESTOQUE_SHOPEE.lojaFbs,
        ultimoMotivoContaEmMs: AGORA,
        lastSweepAtMs: AGORA,
      },
    ]);
    expect(res.contas[0]).toMatchObject({
      motivoConta: MOTIVO_ESTOQUE_SHOPEE.lojaFbs,
      error: null,
    });
  });

  it('21 — NEAR-MISS do portão: sem-shop-id é CONTADO e NUNCA escrito', async () => {
    // A conta consented by the main account will answer this every quarter-hour
    // for ever; writing it is a write per conta per tick that says nothing new.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc({ shop_id: null }));
    const { deps } = montarDeps({
      avaliarConta: () =>
        Promise.resolve({ ok: false as const, motivo: MOTIVO_ESTOQUE_SHOPEE.semShopId }),
    });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(escritasDeEstado(db)).toEqual([]);
    expect(res.contas[0]?.motivoConta).toBe(MOTIVO_ESTOQUE_SHOPEE.semShopId);
  });

  it('22 — o depósito é lido da conta e vira o depositoId da descoberta', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const avaliarConta = vi.fn(ACEITA);
    const { deps, chamadasDeMovimentos } = montarDeps({
      paginas: [pagina([familia()])],
      avaliarConta,
    });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(avaliarConta).toHaveBeenCalledWith(
      expect.anything(),
      { integracaoId: INT, shopId: SHOP, depositoOuterRef: DEPOSITO_REF },
      expect.objectContaining({ nowMs: AGORA }),
    );
    expect(chamadasDeMovimentos[0]?.depositoId).toBe(DEPOSITO_ID);
  });

  it('23 — família sem mudança: inalterados E skipped sobem, nada é enfileirado', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, agendador } = montarDeps({ paginas: [pagina([familia()])] });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(agendador.tarefas).toEqual([]);
    expect(res.contas[0]).toMatchObject({ inalterados: 1, skipped: 1, enqueued: 0 });
  });

  it('24 — NEAR-MISS: um pulo do PLANEJADOR conta em skipped mas NÃO em inalterados', async () => {
    // The two numbers answer different questions: `inalterados` is the only one
    // that says whether the change check pays for its ledger read.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const semLink = familiaQueEnvia({ links: [] });
    const { deps, agendador, linhas } = montarDeps({ paginas: [pagina([semLink])] });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(agendador.tarefas).toEqual([]);
    expect(res.contas[0]).toMatchObject({ inalterados: 0, skipped: 1 });
    const porMotivo = linhas.find((l) => l.msg.includes('por motivo'));
    expect(porMotivo?.meta?.pulos).toEqual({ [MOTIVO_ESTOQUE_SHOPEE.semLink]: 1 });
  });

  it('25 — sweepId é DETERMINÍSTICO para (modo, conta, nowMs) e marcado quando retoma', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const primeiro = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });
    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, primeiro.deps);
    const segundo = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });
    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, segundo.deps);

    expect(primeiro.agendador.tarefas[0]?.sweepId).toBe(`incremental-${INT}-${AGORA}`);
    expect(segundo.agendador.tarefas[0]?.sweepId).toBe(primeiro.agendador.tarefas[0]?.sweepId);

    const dbCont = new FakeDb();
    dbCont.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    dbCont.seed(`${ESTADO_PATH}/${INT}`, {
      continuacao: {
        afterAnchorId: 'prod-anterior',
        changedSinceMs: AGORA - HORA_MS,
        modo: MODO_VARREDURA_ESTOQUE.incremental,
        movimentosDesdeMs: AGORA - HORA_MS,
        startedAtMs: AGORA - HORA_MS,
      },
    });
    const retomada = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });
    await runShopeeStockSweep(asDb(dbCont), MODO_VARREDURA_ESTOQUE.incremental, retomada.deps);
    expect(retomada.agendador.tarefas[0]?.sweepId).toBe(`incremental-cont-${INT}-${AGORA}`);
  });
});

/* -------------------------------------------------------------------------- */
/*                               CONTAINMENT                                  */
/* -------------------------------------------------------------------------- */

function erroDeApi(mensagem = 'boom'): ShopeeApiError {
  return new ShopeeApiError(mensagem, {
    code: 'error_server',
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 500,
    path: '/api/v2/product/update_stock',
  });
}

describe('runShopeeStockSweep — contenção por conta', () => {
  it('26 — um ShopeeApiError numa conta vira o error DELA; a próxima conta roda', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${INTEGRACAO_PATH}/${OUTRA_INT}`, contaDoc({ shop_id: OUTRO_SHOP }));
    const { deps, agendador } = montarDeps({
      porConta: {
        [OUTRA_INT]: [
          pagina([
            familiaQueEnvia({
              anchorId: 'prod-b',
              links: [link({ contaProdutoShopeeOuterRef: `integracao/${OUTRA_INT}` })],
            }),
          ]),
        ],
      },
      avaliarConta: (_db, conta) =>
        conta.integracaoId === INT
          ? Promise.reject(erroDeApi('loja fora do ar'))
          : Promise.resolve({ ok: true as const }),
    });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(res.contas[0]).toMatchObject({ integracaoId: INT, error: 'loja fora do ar' });
    expect(res.contas[1]).toMatchObject({ integracaoId: OUTRA_INT, error: null, enqueued: 1 });
    expect(agendador.tarefas).toHaveLength(1);
    expect(escritasDeEstado(db, INT)).toEqual([
      { lastError: 'loja fora do ar', lastErrorAtMs: AGORA, lastSweepAtMs: AGORA },
    ]);
    // Contained means contained: nothing advanced for the failing conta.
    expect(Object.keys(escritasDeEstado(db, INT)[0] ?? {})).not.toContain('cursorMs');
  });

  it('27 — um ShopeeRateLimitError DIÁRIO arma a pausa até a virada da cota e contém', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${ESTADO_PATH}/${INT}`, { pauseCount: 4 });
    const limite = new ShopeeRateLimitError('cota diária', {
      code: 'error_rate_limit',
      kind: SHOPEE_ERROR_KIND.daily,
      httpStatus: 429,
      path: '/api/v2/shop/get_shop_info',
    });
    const { deps } = montarDeps({ avaliarConta: () => Promise.reject(limite) });

    const res = await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(escritasDeEstado(db)).toEqual([
      {
        pausadoAte: proximaViradaDaCotaMs(AGORA),
        pausaMotivo: 'cota-diaria',
        pausaCodigo: 'error_rate_limit',
        pauseCount: 5,
      },
      { lastError: 'cota diária', lastErrorAtMs: AGORA, lastSweepAtMs: AGORA },
    ]);
    expect(res.contas[0]?.error).toBe('cota diária');
  });

  it('28 — NEAR-MISS: um BURST pausa por ratePauseMin(), não até a virada da cota', async () => {
    // Same class, different `kind`, and the two deadlines are nothing alike: a
    // burst that waited for 00:00 UTC+8 would idle a conta for most of a day.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const limite = new ShopeeRateLimitError('rajada', {
      code: 'error_busi_rate_limit',
      kind: SHOPEE_ERROR_KIND.burst,
      httpStatus: 429,
      path: '/api/v2/shop/get_shop_info',
    });
    const { deps } = montarDeps({ avaliarConta: () => Promise.reject(limite) });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(escritasDeEstado(db)[0]).toEqual({
      pausadoAte: AGORA + 5 * MIN_MS,
      pausaMotivo: 'burst',
      pausaCodigo: 'error_busi_rate_limit',
      pauseCount: 1,
    });
    expect(escritasDeEstado(db)[0]?.pausadoAte).not.toBe(proximaViradaDaCotaMs(AGORA));
  });

  it('29 — ShopeeStockTasksDisabledError NÃO é contido: o tick INTEIRO rejeita', async () => {
    // C-m / #778: a deployment valve is not a conta state. Containing it would
    // report one broken deploy as N identical per-conta strings under a green
    // tick — exactly the silent pass this whole design exists to prevent.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    db.seed(`${INTEGRACAO_PATH}/${OUTRA_INT}`, contaDoc({ shop_id: OUTRO_SHOP }));
    const { deps, agendador } = montarDeps({ paginas: [pagina([familiaQueEnvia()])] });
    agendador.erro = new ShopeeStockTasksDisabledError();

    await expect(
      runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps),
    ).rejects.toBeInstanceOf(ShopeeStockTasksDisabledError);
    // And nothing was recorded as a per-conta failure on the way out.
    expect(escritasDeEstado(db)).toEqual([]);
  });

  it('30 — um TypeError (bug de código) também rejeita o tick inteiro', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps } = montarDeps({
      avaliarConta: () => Promise.reject(new TypeError('x is not a function')),
    });

    await expect(
      runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/*                        THE UNVERIFIABLE-KIT ALARM                          */
/* -------------------------------------------------------------------------- */

/** A kit whose `componentesKitKeys` denorm resolves NOTHING. */
function kitNaoVerificavelRow(): LinhaDeFamiliaShopee {
  const base = familiaQueEnvia();
  return {
    ...base,
    anchor: {
      ...base.anchor,
      ehKit: true,
      componentesKit: { 'comp-fantasma': { quantidade: 2, limitarEstoque: true, timestamp: null } },
      componentEstoques: [],
    },
  };
}

describe('runShopeeStockSweep — o alarme de kit não verificável', () => {
  it('31 — PAR: um membro com componente não resolvido emite UM alarme nomeando-o', async () => {
    // The only signal that a kit publishing 0 has a STALE denorm rather than a
    // genuinely empty composition. There is no other: the planner is pure.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const { deps, linhas } = montarDeps({ paginas: [pagina([kitNaoVerificavelRow()])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    const alarmes = linhas.filter((l) => l.msg.includes('kit sem componentes resolvíveis'));
    expect(alarmes).toHaveLength(1);
    expect(alarmes[0]?.nivel).toBe('error');
    expect(alarmes[0]?.meta).toMatchObject({
      integracaoId: INT,
      produtoId: 'prod-a',
      componentes: ['comp-fantasma'],
    });
  });

  it('32 — QUASE-PAR: um kit totalmente resolvido é SILÊNCIO', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const base = kitNaoVerificavelRow();
    const resolvido: LinhaDeFamiliaShopee = {
      ...base,
      anchor: {
        ...base.anchor,
        componentEstoques: [
          estoqueRow({ estoqueDocId: 'est-c', parentId: 'comp-fantasma', quantidade: 9 }),
        ],
      },
    };
    const { deps, linhas } = montarDeps({ paginas: [pagina([resolvido])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(linhas.filter((l) => l.msg.includes('kit sem componentes resolvíveis'))).toEqual([]);
  });

  it('33 — QUASE-PAR: um kit com componente NÃO restritivo (limitarEstoque false) é SILÊNCIO', async () => {
    // The near-miss that matters here is the DECLARATION, not the resolution: a
    // component flagged as not constraining the kit's stock is not part of the
    // arithmetic, so its absence explains nothing and a line about it would send
    // the reader hunting a denorm that is not their problem.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const base = kitNaoVerificavelRow();
    const naoRestritivo: LinhaDeFamiliaShopee = {
      ...base,
      anchor: {
        ...base.anchor,
        componentesKit: {
          'comp-fantasma': { quantidade: 2, limitarEstoque: false, timestamp: null },
        },
      },
    };
    const { deps, linhas } = montarDeps({ paginas: [pagina([naoRestritivo])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    expect(linhas.filter((l) => l.msg.includes('kit sem componentes resolvíveis'))).toEqual([]);
  });

  it('34 — o alarme é POR MEMBRO: um filho quebrado ao lado de uma âncora sã nomeia só o filho', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const sa = familiaQueEnvia();
    const filho: FilhoDaFamilia = {
      produtoId: 'prod-filho',
      ehKit: true,
      ehKitVirtual: false,
      publicado: true,
      componentesKit: {
        'outro-fantasma': { quantidade: 1, limitarEstoque: true, timestamp: null },
      },
      timestampMs: null,
      estoque: null,
      componentEstoques: [],
      varLinks: [],
    };
    const { deps, linhas } = montarDeps({ paginas: [pagina([{ ...sa, children: [filho] }])] });

    await runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps);

    const alarmes = linhas.filter((l) => l.msg.includes('kit sem componentes resolvíveis'));
    expect(alarmes.map((a) => a.meta?.produtoId)).toEqual(['prod-filho']);
  });

  it('35 — QUASE-PAR do ESCOPO: um kit PARCIALMENTE resolvido é SILÊNCIO', () => {
    // The fold's SCOPE, not merely that it applies: the alarm fires only when
    // NOT ONE declared component resolved. A kit short of ONE of two still has
    // a verifiable quantity — noisy here is worse than silent, because the
    // line's whole value is that it means "this published 0 for no reason".
    // Applying `componentesNaoResolvidos(m).length > 0` instead is the mutant
    // this case exists to kill; nothing else in the suite can tell them apart.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/${INT}`, contaDoc());
    const base = kitNaoVerificavelRow();
    const parcial: LinhaDeFamiliaShopee = {
      ...base,
      anchor: {
        ...base.anchor,
        componentesKit: {
          'comp-fantasma': { quantidade: 2, limitarEstoque: true, timestamp: null },
          'comp-real': { quantidade: 1, limitarEstoque: true, timestamp: null },
        },
        componentEstoques: [
          estoqueRow({ estoqueDocId: 'est-c', parentId: 'comp-real', quantidade: 9 }),
        ],
      },
    };
    const { deps, linhas } = montarDeps({ paginas: [pagina([parcial])] });

    return runShopeeStockSweep(asDb(db), MODO_VARREDURA_ESTOQUE.incremental, deps).then(() => {
      expect(linhas.filter((l) => l.msg.includes('kit sem componentes resolvíveis'))).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                            THE SLOT PREDICATES                             */
/* -------------------------------------------------------------------------- */

describe('os predicados de slot', () => {
  it('36 — o diário é 02:10–02:24 em São Paulo, de um epoch fixo (nunca da zona ambiente)', () => {
    // 02:10 BRT is 05:10 UTC — Brazil has had no DST since 2019, so the offset
    // is a constant −3 all year. Built with `Date.UTC` on purpose: the
    // component constructor reads the AMBIENT zone, which is the exact bug the
    // explicit `timeZone` in the predicate exists to prevent.
    expect(ehSlotDoDiario(Date.UTC(2026, 2, 15, 5, 10))).toBe(true);
    expect(ehSlotDoDiario(Date.UTC(2026, 2, 15, 5, 24))).toBe(true);
    // NEAR-MISS on both edges of the band.
    expect(ehSlotDoDiario(Date.UTC(2026, 2, 15, 5, 25))).toBe(false);
    expect(ehSlotDoDiario(Date.UTC(2026, 2, 15, 5, 9))).toBe(false);
    // NEAR-MISS on the hour: 03:10 BRT belongs to the other tier.
    expect(ehSlotDoDiario(Date.UTC(2026, 2, 15, 6, 10))).toBe(false);
  });

  it('37 — a reconciliação é 03:10–03:24 em São Paulo, SÓ no dia 1', () => {
    expect(ehSlotDaReconciliacao(Date.UTC(2026, 2, 1, 6, 10))).toBe(true);
    expect(ehSlotDaReconciliacao(Date.UTC(2026, 2, 1, 6, 24))).toBe(true);
    // NEAR-MISS: the same wall clock on day 2.
    expect(ehSlotDaReconciliacao(Date.UTC(2026, 2, 2, 6, 10))).toBe(false);
    expect(ehSlotDaReconciliacao(Date.UTC(2026, 2, 1, 6, 25))).toBe(false);
    expect(ehSlotDaReconciliacao(Date.UTC(2026, 2, 1, 5, 10))).toBe(false);
  });

  it('38 — os dois slots são DISJUNTOS: nenhum instante pertence aos dois', () => {
    // If they overlapped, one conta would be swept twice in one slot with two
    // different policies, and both ticks would stamp.
    const inicio = Date.UTC(2026, 2, 1, 0, 0);
    for (let minuto = 0; minuto < 24 * 60; minuto += 1) {
      const t = inicio + minuto * MIN_MS;
      expect(ehSlotDoDiario(t) && ehSlotDaReconciliacao(t)).toBe(false);
    }
  });
});

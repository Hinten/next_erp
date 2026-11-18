/**
 * The recovery delta (step 12, PR 12-e2), offline: the window it plans from a
 * feed's snapshot and a pending start, the SKUs it re-sends and how it names
 * them, the batch form, the deadline, the one contained failure and its line —
 * against the counting fake Firestore and the REAL stock producer over a
 * recording queue that, like Cloud Tasks, refuses a task id it already holds.
 *
 * Commit times: the fake's clock moves one MICROSECOND per write, so every row
 * seeded before {@link avancarUmMs} commits in one millisecond and every row
 * seeded after it in a later one. The cases take the snapshot `S` so that
 * `S − 20 s` IS the first millisecond: "committed before the margin" and
 * "committed after it" are the two sides of that call.
 *
 * No network: every `fetch` fails the case (the recovery makes no Amazon call).
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
  makeEstoqueUid,
} from '@delfrance/schemas';

import type { CamposLogAmazon } from '../core/log';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { loggerEspiao } from '../testing/fixtures';
import {
  ADIANTAMENTO_MAXIMO_MS,
  LINHAS_POR_PAGINA_JANELA,
  MARGEM_COMMIT_MS,
  TETO_PAGINAS_JANELA,
  janelaDaRecuperacao,
} from './descobertaEstoque';
import {
  type ContextoDeltaEstoqueAmazon,
  DESFECHO_DELTA_ESTOQUE_AMAZON,
  type EntradaDeltaEstoqueAmazon,
  FASE_DELTA_ESTOQUE_AMAZON,
  REPASSE_DELTA_ESTOQUE_AMAZON,
  type ResultadoDeltaEstoqueAmazon,
  enviarDeltaEstoqueAmazon,
} from './deltaEstoque';
import { MOTIVO_ESTOQUE_AMAZON } from './motivosEstoque';
import {
  AmazonEstoqueTarefasDesligadasError,
  type ProdutorEstoqueAmazon,
  criarProdutorEstoqueAmazon,
} from './produtorEstoque';
import {
  MAX_UNIDADES_SKU_TAREFA_ESTOQUE,
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  nomeDaTarefaEstoque,
  nomeTarefaEstoque,
  referenciaDaObservacao,
} from './tarefaEstoque';

/**
 * `janelaDaRecuperacao`, real by default; a case may make it throw something
 * other than its `RangeError` (the recovery's catch around it is narrow).
 */
const planejador = vi.hoisted(() => ({ falha: null as unknown }));
vi.mock('./descobertaEstoque', async (original) => {
  const real = await original<typeof import('./descobertaEstoque')>();
  return {
    ...real,
    janelaDaRecuperacao: (...args: Parameters<typeof real.janelaDaRecuperacao>) => {
      if (planejador.falha !== null) throw planejador.falha;
      return real.janelaDaRecuperacao(...args);
    },
  };
});

const CONTA = 'conta-amz-delta';
const DEP = 'dep-delta-1';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const REF_CONTA = `documents/integracao/${CONTA}`;
/** The recovered feed's reference: its `feedId`. */
const REF_FEED = '50012345678';
/** A deadline that never passes unless a case moves the clock. */
const SEM_PRAZO = Number.MAX_SAFE_INTEGER;
/**
 * The recovery's stamp range below the snapshot, WRITTEN OUT: these cases pin
 * the five minutes themselves, so a shorter range in the planner reds them too.
 */
const CINCO_MINUTOS_MS = 300_000;

/** Every `fetch` is a failure: the recovery never reaches the network. */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});

let fake: FakeDb;
let agoraMs: number;
let espiao: ReturnType<typeof loggerEspiao>;
/** Task ids the recording queue holds (a name stays held after its task ran). */
let idsNaFila: Set<string>;
/** Every task the queue accepted, in order. */
let enfileiradas: TarefaEstoqueAmazon[];
/** How many times the producer thunk was called (it is built only when a batch is due). */
let produtoresConstruidos: number;

beforeEach(() => {
  planejador.falha = null;
  fake = new FakeDb();
  agoraMs = 0;
  espiao = loggerEspiao();
  idsNaFila = new Set();
  enfileiradas = [];
  produtoresConstruidos = 0;
});

afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** The REAL producer over a recording queue (module header). */
function produtorGravador(
  opcoes: { readonly desligado?: boolean; readonly aoEnfileirar?: () => void } = {},
): ProdutorEstoqueAmazon {
  return criarProdutorEstoqueAmazon({
    desligado: opcoes.desligado ?? false,
    fila: () => ({
      enqueue: (tarefa, extras) => {
        opcoes.aoEnfileirar?.();
        const id = extras?.id;
        if (id !== undefined && idsNaFila.has(id)) {
          return Promise.reject(falhaDeTarefaJaExistente(id));
        }
        if (id !== undefined) idsNaFila.add(id);
        enfileiradas.push(tarefa);
        return Promise.resolve();
      },
    }),
  });
}

function ctx(over: Partial<ContextoDeltaEstoqueAmazon> = {}): ContextoDeltaEstoqueAmazon {
  const produtor = produtorGravador();
  return {
    db: asDb(fake),
    contaId: CONTA,
    depositoId: DEP,
    agora: () => agoraMs,
    logger: espiao.logger,
    produtor: () => {
      produtoresConstruidos += 1;
      return produtor;
    },
    ...over,
  };
}

function delta(
  entrada: EntradaDeltaEstoqueAmazon,
  over: Partial<ContextoDeltaEstoqueAmazon> = {},
  opcoes: { readonly referencia?: string; readonly prazoMs?: number } = {},
): Promise<ResultadoDeltaEstoqueAmazon> {
  return enviarDeltaEstoqueAmazon(ctx(over), entrada, {
    referencia: opcoes.referencia ?? REF_FEED,
    prazoMs: opcoes.prazoMs ?? SEM_PRAZO,
  });
}

function produto(id: string): void {
  fake.seed(`produtos/${id}`, { nome: `Produto ${id}` });
}

/** An estoque row of `produtoId` at the depósito (canonical id and form). Returns its path. */
function linha(produtoId: string, ultimaModificacao: number, ref = CANONICA): string {
  const caminho = `produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, DEP)}`;
  fake.seed(caminho, { depositoOuterRef: ref, ultimaModificacao, quantidade: 1 });
  return caminho;
}

/** A link doc on `dono` for `sku`, of the conta. */
function vinculo(dono: string, id: string, sku: string): void {
  fake.seed(`produtos/${dono}/prodAmazon/${id}`, {
    contaAmazonOuterRef: REF_CONTA,
    sku,
    productDataJson: '{"pesado":true}',
  });
}

/** A produto with its one link (SKU = `SKU-<id>`) and its row stamped `carimbo`. */
function moveu(id: string, carimbo: number): string {
  produto(id);
  vinculo(id, `l-${id}`, `SKU-${id}`);
  return linha(id, carimbo);
}

/** One produto whose row is stamped `carimbo`, with `n` links of the conta. */
function produtoComVinculos(id: string, n: number, carimbo: number): void {
  produto(id);
  for (let i = 0; i < n; i += 1) {
    vinculo(id, `l${String(i)}`, `${id}-${String(i).padStart(4, '0')}`);
  }
  linha(id, carimbo);
}

/** Moves the fake's commit clock into the next millisecond (module header). */
function avancarUmMs(): void {
  for (let i = 0; i < 1_000; i += 1) fake.seed('relogio/x', { i });
}

/** The commit millisecond of `caminho`. */
function commitMs(caminho: string): number {
  const t = fake.carimboDe(caminho);
  if (t === undefined) throw new Error(`fixture: ${caminho} ausente`);
  return t.toMillis();
}

const linhasDoDelta = () =>
  espiao.linhas.filter(
    (l) => l.meta?.evento === 'estoque' && l.meta.fase === FASE_DELTA_ESTOQUE_AMAZON,
  );
function linhaUnica(): { nivel: string; meta: CamposLogAmazon } {
  const ls = linhasDoDelta();
  expect(ls).toHaveLength(1);
  const l = ls[0];
  if (l?.meta === undefined) throw new Error('sem linha');
  return { nivel: l.nivel, meta: l.meta };
}
const consultasDaJanela = () => fake.consultas.filter((q) => q.colecao === 'estoques');
const listagens = () => fake.consultas.filter((q) => q.colecao.endsWith('/prodAmazon'));

/** `[sku, origem, referencia]` of every task the queue accepted, sorted by SKU. */
const tarefasEnviadas = () =>
  enfileiradas
    .map((t) => [t.sku, t.origem, t.referencia] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The feed scenario every forcing case starts from: the feed's OWN members
 * (stamped within 4 minutes of `S`, committed before its reads) committed in
 * the first millisecond, then the clock moved one millisecond. Returns `S`,
 * taken so that `S − 20 s` is that first millisecond.
 */
function feedComMembros(membros: readonly string[], carimbo: (s: number) => number): number {
  // The first millisecond, read off a marker seeded first; every member below
  // commits in it too (a few µs later).
  const s = fake.seed('relogio/inicio', {}).toMillis() + MARGEM_COMMIT_MS;
  for (const m of membros) moveu(m, carimbo(s));
  avancarUmMs();
  return s;
}

describe('★ the catch-up: EXACTLY the rows committed after S − 20 s among the rows stamped after S − 5 min, forced', () => {
  it('the feed’s own members (committed before its reads) are NOT re-sent; a post-snapshot row and a commit-lagged one ARE, as catch-ups named by the feed', async () => {
    const s = feedComMembros(['M1', 'M2', 'M3'], (snap) => snap - 240_000);
    // After the margin: X stamped after the snapshot; L stamped 60 s BEFORE it
    // but committed after (the commit-lag case: a writer's stamp taken before
    // its transaction committed); L2 at the very edge of the 5-minute range.
    moveu('X', s + 10_000);
    moveu('L', s - 60_000);
    moveu('L2', s - CINCO_MINUTOS_MS + 1);
    // Committed after too, but stamped OUTSIDE the range: never read.
    moveu('O', s - CINCO_MINUTOS_MS);
    agoraMs = s + 60_000;
    expect(commitMs(`produtos/X/estoques/${makeEstoqueUid('X', DEP)}`)).toBeGreaterThan(
      s - MARGEM_COMMIT_MS,
    );
    expect(commitMs(`produtos/M1/estoques/${makeEstoqueUid('M1', DEP)}`)).toBe(
      s - MARGEM_COMMIT_MS,
    );

    const r = await delta({ snapshotEmMs: s, pendenteDesdeMs: null });

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
      repasse: null,
      skus: 3,
      forcados: 3,
      tarefas: 3,
      jaEnfileiradas: 0,
      naoTentadas: 0,
    });
    // NEAR-MISS: the stamp-only rule (every row stamped after S − 5 min) would
    // re-send M1–M3 too, and a feed's recovery would re-send its own members.
    expect(tarefasEnviadas()).toEqual([
      ['SKU-L', ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, REF_FEED],
      ['SKU-L2', ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, REF_FEED],
      ['SKU-X', ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, REF_FEED],
    ]);
    expect([...idsNaFila].sort()).toEqual(
      ['SKU-L', 'SKU-L2', 'SKU-X']
        .map((sku) => nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, CONTA, sku, REF_FEED))
        .sort(),
    );
  });

  it('the window read is the planner’s: (S − 5 min, agora], one == query per ref form, both bounds; the dropped rows cost no produto read', async () => {
    const s = feedComMembros(['M1'], (snap) => snap - 30_000);
    moveu('X', s + 1_000);
    agoraMs = s + 60_000;

    const r = await delta({ snapshotEmMs: s, pendenteDesdeMs: null });

    const esperada = janelaDaRecuperacao({ snapshotEmMs: s, pendenteDesdeMs: null, agoraMs });
    expect(r.janela).toEqual(esperada);
    expect(r.janela).toEqual({
      desdeMs: s - CINCO_MINUTOS_MS,
      ateMs: agoraMs,
      manterDesdeMs: null,
      commitAposMs: s - MARGEM_COMMIT_MS,
      forcarPorCommit: true,
    });
    expect(consultasDaJanela().map((q) => q.filtros)).toEqual(
      [CANONICA, NUA].map((forma) => [
        ['depositoOuterRef', forma],
        ['ultimaModificacao >', s - CINCO_MINUTOS_MS],
        ['ultimaModificacao <=', agoraMs],
      ]),
    );
    // M1 (committed before the margin) is never mapped: only X's produto is read.
    expect(fake.leituras).toEqual(['produtos/X']);
    expect(listagens().map((q) => q.colecao)).toEqual(['produtos/X/prodAmazon']);
  });

  it('★ with a pending start, every row stamped after it is sent too, UNFORCED and named by its observation', async () => {
    const s = feedComMembros(['M1', 'M2'], (snap) => snap - 240_000);
    // The pending start is older than the snapshot's range: the window reaches it.
    const p = s - 600_000;
    moveu('P1', p + 1);
    moveu('X', s + 5_000);
    agoraMs = s + 60_000;

    const r = await delta({ snapshotEmMs: s, pendenteDesdeMs: p });

    expect(r.janela).toEqual({
      desdeMs: p,
      ateMs: agoraMs,
      manterDesdeMs: p,
      commitAposMs: s - MARGEM_COMMIT_MS,
      forcarPorCommit: true,
    });
    // M1, M2 and P1 are kept by the start — and M1/M2 committed BEFORE the
    // margin, so not forced; P1 and X committed after it, so forced.
    const porSku = new Map(enfileiradas.map((t) => [t.sku, t]));
    expect([...porSku.keys()].sort()).toEqual(['SKU-M1', 'SKU-M2', 'SKU-P1', 'SKU-X']);
    for (const sku of ['SKU-M1', 'SKU-M2']) {
      const t = porSku.get(sku);
      const caminho = `produtos/${sku.slice(4)}/estoques/${makeEstoqueUid(sku.slice(4), DEP)}`;
      const commit = fake.carimboDe(caminho);
      if (commit === undefined) throw new Error('fixture');
      expect(t).toMatchObject({
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
        referencia: referenciaDaObservacao(commit),
      });
    }
    for (const sku of ['SKU-P1', 'SKU-X']) {
      expect(porSku.get(sku)).toMatchObject({
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
        referencia: REF_FEED,
      });
    }
    expect(r).toMatchObject({ skus: 4, forcados: 2, tarefas: 4 });
  });

  it('a `vez` recovery (no snapshot): every row stamped after the start, nothing forced — its prefixed reference is never a task’s', async () => {
    const p = 1_000_000;
    moveu('A', p + 10);
    moveu('B', p - 10);
    agoraMs = p + 120_000;

    const r = await delta({ snapshotEmMs: null, pendenteDesdeMs: p }, {}, { referencia: 'vez:x1' });

    expect(r).toMatchObject({ skus: 1, forcados: 0, tarefas: 1 });
    expect(r.janela).toEqual({
      desdeMs: p,
      ateMs: agoraMs,
      manterDesdeMs: p,
      commitAposMs: null,
      forcarPorCommit: false,
    });
    const commit = fake.carimboDe(`produtos/A/estoques/${makeEstoqueUid('A', DEP)}`);
    if (commit === undefined) throw new Error('fixture');
    expect(enfileiradas).toEqual([
      {
        v: 1,
        contaId: CONTA,
        sku: 'SKU-A',
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
        referencia: referenciaDaObservacao(commit),
        depositoId: null,
      },
    ]);
  });

  it('★ a second recovery over the same rows mints the same names: every task already held, none twice', async () => {
    const s = feedComMembros(['M1'], (snap) => snap - 240_000);
    const p = s - 400_000;
    moveu('X', s + 5_000);
    agoraMs = s + 60_000;
    const entrada = { snapshotEmMs: s, pendenteDesdeMs: p };
    const fila = produtorGravador();

    const primeira = await delta(entrada, { produtor: () => fila });
    agoraMs += 30_000;
    const segunda = await delta(entrada, { produtor: () => fila });

    expect(primeira).toMatchObject({ tarefas: 2, jaEnfileiradas: 0 });
    expect(segunda).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      tarefas: 0,
      jaEnfileiradas: 2,
    });
    expect(enfileiradas.map((t) => t.sku).sort()).toEqual(['SKU-M1', 'SKU-X']);
    expect([...idsNaFila].sort()).toEqual(enfileiradas.map(nomeDaTarefaEstoque).sort());
  });

  it('nothing committed after the margin and no start ⇒ nada: the chain ends (the feed’s members are never re-sent)', async () => {
    const s = feedComMembros(['M1', 'M2'], (snap) => snap - 30_000);
    agoraMs = s + 60_000;

    const r = await delta({ snapshotEmMs: s, pendenteDesdeMs: null });

    expect(r).toMatchObject({ desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.nada, skus: 0, linhas: 2 });
    expect(enfileiradas).toEqual([]);
    expect(produtoresConstruidos).toBe(0);
    expect(linhaUnica()).toMatchObject({ nivel: 'info', meta: { desfecho: 'nada' } });
  });
});

describe('★ the batch form: ≤ 30 as patches, 31–3,000 the delta-feed placeholder, more a reconcile', () => {
  const P = 2_000_000;
  const entrada = { snapshotEmMs: null, pendenteDesdeMs: P };

  beforeEach(() => {
    agoraMs = P + 60_000;
  });

  it(`${String(LIMIAR_FEED_ESTOQUE_AMAZON)} SKUs ⇒ ${String(LIMIAR_FEED_ESTOQUE_AMAZON)} tasks`, async () => {
    produtoComVinculos('K', LIMIAR_FEED_ESTOQUE_AMAZON, P + 1);

    const r = await delta(entrada);

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      skus: LIMIAR_FEED_ESTOQUE_AMAZON,
      tarefas: LIMIAR_FEED_ESTOQUE_AMAZON,
    });
    expect(enfileiradas).toHaveLength(LIMIAR_FEED_ESTOQUE_AMAZON);
  });

  it(`NEAR-MISS ${String(LIMIAR_FEED_ESTOQUE_AMAZON + 1)} SKUs ⇒ ZERO tasks and the feed-necessario WARNING carrying the window`, async () => {
    produtoComVinculos('K', LIMIAR_FEED_ESTOQUE_AMAZON + 1, P + 1);

    const r = await delta(entrada);

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.repassado,
      motivo: MOTIVO_ESTOQUE_AMAZON.emFeed,
      repasse: REPASSE_DELTA_ESTOQUE_AMAZON.feedNecessario,
      skus: LIMIAR_FEED_ESTOQUE_AMAZON + 1,
      tarefas: 0,
    });
    // The window travels, never the SKUs: bounds and keep rule only.
    expect(r.janela).toEqual({
      desdeMs: P,
      ateMs: agoraMs,
      manterDesdeMs: P,
      commitAposMs: null,
      forcarPorCommit: false,
    });
    // NEAR-MISS: the answer carries no list at all and names none of the batch's
    // SKUs — a list beside the window would grow with the batch.
    expect(Object.values(r).filter((v) => Array.isArray(v))).toEqual([]);
    const serializada = JSON.stringify(r);
    for (let i = 0; i <= LIMIAR_FEED_ESTOQUE_AMAZON; i += 1) {
      expect(serializada).not.toContain(`K-${String(i).padStart(4, '0')}`);
    }
    expect(enfileiradas).toEqual([]);
    expect(produtoresConstruidos).toBe(0);
    expect(linhaUnica()).toMatchObject({
      nivel: 'warn',
      meta: {
        desfecho: 'repassado',
        repasse: 'feed-necessario',
        motivo: 'em-feed',
        skus: LIMIAR_FEED_ESTOQUE_AMAZON + 1,
      },
    });
  });

  it(`${String(MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON)} SKUs ⇒ still the feed placeholder; ${String(MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON + 1)} ⇒ the reconcile placeholder`, async () => {
    produtoComVinculos('K', MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON, P + 1);
    const noTeto = await delta(entrada);
    expect(noTeto).toMatchObject({ repasse: REPASSE_DELTA_ESTOQUE_AMAZON.feedNecessario });

    vinculo('K', 'l-extra', 'K-extra');
    const acima = await delta(entrada);

    expect(acima).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.repassado,
      motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      repasse: REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      skus: MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON + 1,
      truncada: false,
    });
    expect(enfileiradas).toEqual([]);
  });

  it('★ a TRUNCATED window ⇒ the reconcile placeholder, with zero produto reads and zero partition listings', async () => {
    const n = (TETO_PAGINAS_JANELA - 1) * LINHAS_POR_PAGINA_JANELA;
    for (let i = 0; i < n; i += 1) linha(`T${String(i).padStart(5, '0')}`, P + 1);

    const r = await delta(entrada);

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      truncada: true,
      paginas: TETO_PAGINAS_JANELA,
      produtos: 0,
      sondas: 0,
    });
    expect(fake.leituras).toEqual([]);
    expect(listagens()).toEqual([]);
    expect(produtoresConstruidos).toBe(0);
  });

  it('a SKU the payload cannot carry is counted and left out; the rest are enqueued', async () => {
    produto('K');
    vinculo('K', 'l0', 'K-0');
    vinculo('K', 'l1', 'x'.repeat(MAX_UNIDADES_SKU_TAREFA_ESTOQUE + 1));
    linha('K', P + 1);

    const r = await delta(entrada);

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      skus: 2,
      tarefas: 1,
      foraDaTarefa: 1,
    });
    expect(enfileiradas.map((t) => t.sku)).toEqual(['K-0']);
  });

  it('a batch of ONLY such SKUs enqueues nothing and builds no producer', async () => {
    produto('K');
    vinculo('K', 'l1', 'x'.repeat(MAX_UNIDADES_SKU_TAREFA_ESTOQUE + 1));
    linha('K', P + 1);

    const r = await delta(entrada);

    expect(r).toMatchObject({ skus: 1, tarefas: 0, foraDaTarefa: 1 });
    expect(produtoresConstruidos).toBe(0);
  });
});

describe('★ the deadline', () => {
  const P = 3_000_000;
  const entrada = { snapshotEmMs: null, pendenteDesdeMs: P };

  it('passed before the first window page ⇒ the reconcile placeholder naming the read it stopped before, nothing enqueued', async () => {
    moveu('A', P + 1);
    agoraMs = P + 60_000;

    const r = await delta(entrada, {}, { prazoMs: agoraMs });

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      prazo: 'janela',
      paginas: 0,
    });
    expect(fake.operacoes).toBe(0);
    expect(produtoresConstruidos).toBe(0);
  });

  it('reached during the enqueues ⇒ the reconcile placeholder with what was never started; a re-run enqueues only the rest', async () => {
    produtoComVinculos('K', 20, P + 1);
    agoraMs = P + 60_000;
    const prazoMs = agoraMs + 1_000;
    let enviados = 0;
    // The clock crosses the deadline after the fourth enqueue STARTED.
    const fila = produtorGravador({
      aoEnfileirar: () => {
        enviados += 1;
        if (enviados === 4) agoraMs = prazoMs;
      },
    });

    const r = await delta(entrada, { produtor: () => fila }, { prazoMs });

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      orcamentoEsgotado: true,
      skus: 20,
    });
    expect(r.tarefas + r.naoTentadas).toBe(20);
    expect(r.naoTentadas).toBeGreaterThan(0);
    const primeiras = enfileiradas.length;

    agoraMs = P + 120_000;
    const deNovo = await delta(entrada, { produtor: () => fila }, { prazoMs: SEM_PRAZO });

    expect(deNovo).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado,
      jaEnfileiradas: primeiras,
      tarefas: 20 - primeiras,
    });
    expect(new Set(enfileiradas.map((t) => t.sku)).size).toBe(20);
  });

  it('NEAR-MISS: the clock AT the deadline when the enqueues begin ⇒ none is started', async () => {
    produtoComVinculos('K', 3, P + 1);
    agoraMs = P + 60_000;
    const prazoMs = agoraMs + 1_000;
    const fila = produtorGravador();

    const r = await delta(
      entrada,
      {
        produtor: () => {
          agoraMs = prazoMs;
          return fila;
        },
      },
      { prazoMs },
    );

    expect(r).toMatchObject({ tarefas: 0, naoTentadas: 3, orcamentoEsgotado: true });
    expect(enfileiradas).toEqual([]);
  });
});

describe('★ the planner’s RangeError is contained, NARROWLY', () => {
  it('a snapshot more than 24 h ahead of the clock ⇒ janela-invalida, ONE WARNING naming the class, ZERO Firestore operations', async () => {
    agoraMs = 5_000_000;
    moveu('A', agoraMs - 1);

    const r = await delta({
      snapshotEmMs: agoraMs + ADIANTAMENTO_MAXIMO_MS + 1,
      pendenteDesdeMs: null,
    });

    expect(r).toMatchObject({
      desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.janelaInvalida,
      erro: 'RangeError',
      janela: null,
    });
    expect(fake.operacoes).toBe(0);
    expect(produtoresConstruidos).toBe(0);
    expect(linhaUnica()).toMatchObject({
      nivel: 'warn',
      meta: { desfecho: 'janela-invalida', erro: 'RangeError', conta: CONTA, fluxo: 'estoque' },
    });
  });

  it('the same for a pending start (a µs value) — and a start exactly 24 h ahead still plans', async () => {
    agoraMs = 5_000_000;
    const invalida = await delta({ snapshotEmMs: null, pendenteDesdeMs: agoraMs * 1_000 });
    expect(invalida.desfecho).toBe(DESFECHO_DELTA_ESTOQUE_AMAZON.janelaInvalida);

    const noLimite = await delta({
      snapshotEmMs: null,
      pendenteDesdeMs: agoraMs + ADIANTAMENTO_MAXIMO_MS,
    });
    expect(noLimite).toMatchObject({ desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.nada, janela: null });
  });

  it('★ NEAR-MISS: anything ELSE the planner throws is a bug, never caught as an Error — it propagates, no line', async () => {
    agoraMs = 5_000_000;
    const falha = new TypeError('teste: um defeito do planejador');
    planejador.falha = falha;
    await expect(delta({ snapshotEmMs: null, pendenteDesdeMs: agoraMs - 1_000 })).rejects.toBe(
      falha,
    );
    expect(linhasDoDelta()).toEqual([]);
    expect(fake.operacoes).toBe(0);
  });

  it('NEAR-MISS: a RangeError from the READS is not the planner’s — it propagates', async () => {
    agoraMs = 5_000_000;
    const falha = new RangeError('teste: leitura');
    fake.falharConsulta('estoques', falha);

    await expect(delta({ snapshotEmMs: null, pendenteDesdeMs: agoraMs - 1_000 })).rejects.toBe(
      falha,
    );
    expect(linhasDoDelta()).toEqual([]);
  });

  it('a Firestore status error propagates (the recovery’s queue retries it)', async () => {
    agoraMs = 5_000_000;
    const falha = grpc(14, 'indisponível');
    fake.falharConsulta('estoques', falha);

    await expect(delta({ snapshotEmMs: null, pendenteDesdeMs: agoraMs - 1_000 })).rejects.toBe(
      falha,
    );
  });

  it('a producer rejection propagates too — the queue valve included', async () => {
    agoraMs = 5_000_000;
    moveu('A', agoraMs - 500);
    const fechado = produtorGravador({ desligado: true });

    await expect(
      delta({ snapshotEmMs: null, pendenteDesdeMs: agoraMs - 1_000 }, { produtor: () => fechado }),
    ).rejects.toBeInstanceOf(AmazonEstoqueTarefasDesligadasError);
  });
});

describe('the context, checked before anything is read', () => {
  it('no snapshot and no start ⇒ nada, nothing read, ONE INFO line', async () => {
    agoraMs = 5_000_000;

    const r = await delta({ snapshotEmMs: null, pendenteDesdeMs: null });

    expect(r).toMatchObject({ desfecho: DESFECHO_DELTA_ESTOQUE_AMAZON.nada, janela: null });
    expect(fake.operacoes).toBe(0);
    expect(linhaUnica().nivel).toBe('info');
  });

  it.each([
    ['a conta id outside the grammar', { contaId: 'conta/x' }, {}],
    ['a depósito that is not a document id', { depositoId: 'a/b' }, {}],
    ['a fractional deadline', {}, { prazoMs: 1.5 }],
    ['a negative deadline', {}, { prazoMs: -1 }],
    ['a forcing recovery whose reference is a `vez` one', {}, { referencia: 'vez:x1' }],
    ['a forcing recovery with an empty reference', {}, { referencia: '' }],
  ] as const)('%s ⇒ RangeError, ZERO operations, no line', async (_, over, opcoes) => {
    agoraMs = 5_000_000;
    await expect(
      delta({ snapshotEmMs: agoraMs - 1_000, pendenteDesdeMs: null }, over, opcoes),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fake.operacoes).toBe(0);
    expect(espiao.linhas).toEqual([]);
  });

  it.each([
    ['a `vez` reference', 'vez:x1'],
    ['an empty reference', ''],
  ] as const)(
    '★ a forcing recovery that ALSO folds a pending start, with %s ⇒ RangeError, ZERO operations, no line',
    async (_, referencia) => {
      agoraMs = 5_000_000;
      await expect(
        delta(
          { snapshotEmMs: agoraMs - 1_000, pendenteDesdeMs: agoraMs - 2_000 },
          {},
          { referencia },
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(fake.operacoes).toBe(0);
      expect(espiao.linhas).toEqual([]);
    },
  );

  it('NEAR-MISS: a recovery with a pending start and NO snapshot forces nothing, so it needs no reference', async () => {
    agoraMs = 5_000_000;
    const r = await delta(
      { snapshotEmMs: null, pendenteDesdeMs: agoraMs - 2_000 },
      {},
      { referencia: '' },
    );
    expect(r.desfecho).toBe(DESFECHO_DELTA_ESTOQUE_AMAZON.nada);
  });

  it.each([
    ['a conta id outside the grammar', { contaId: 'conta/x' }],
    ['a depósito that is not a document id', { depositoId: 'a/b' }],
  ] as const)(
    '%s is refused even when there is NO window to read (never a line for a bad context)',
    async (_, over) => {
      agoraMs = 5_000_000;
      await expect(
        delta({ snapshotEmMs: null, pendenteDesdeMs: null }, over),
      ).rejects.toBeInstanceOf(RangeError);
      expect(espiao.linhas).toEqual([]);
    },
  );
});

describe('the ONE line', () => {
  it('carries the counts and never a SKU, a reference or a ref', async () => {
    const s = feedComMembros(['M1'], (snap) => snap - 240_000);
    moveu('X', s + 1_000);
    agoraMs = s + 60_000;

    await delta({ snapshotEmMs: s, pendenteDesdeMs: null });

    const { nivel, meta } = linhaUnica();
    expect(nivel).toBe('info');
    expect(meta).toMatchObject({
      evento: 'estoque',
      fase: 'recuperacao',
      conta: CONTA,
      fluxo: 'estoque',
      desfecho: 'enfileirado',
      motivo: 'em-patches',
      repasse: null,
      skus: 1,
      forcados: 1,
      tarefas: 1,
      jaEnfileiradas: 0,
      naoTentadas: 0,
      foraDaTarefa: 0,
      truncada: false,
      orcamentoEsgotado: false,
      prazo: null,
      erro: null,
    });
    const texto = JSON.stringify(espiao.linhas);
    expect(texto).not.toContain('SKU-X');
    expect(texto).not.toContain(REF_FEED);
    expect(texto).not.toContain(DEP);
  });
});

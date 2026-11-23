/**
 * The discovery planner of the Amazon stock sync (step 12, PR 12-d), pure:
 * WHICH movement a stock batch reads, and how its estoque rows become the
 * conta's SKUs with their observations. The window query and its row-to-SKU
 * reads arrive with the tick and the recovery delta (PR 12-e2); this module
 * decides everything they feed.
 *
 * ## The two windows
 *
 * A window is a BOUNDED range of `estoques.ultimaModificacao` stamps at one
 * depósito, `(desdeMs, ateMs]` (the query reads `> desdeMs` and `<= ateMs`),
 * plus a KEEP RULE `{ manterDesdeMs, commitAposMs }` ({@link manterLinha}) and
 * whether that rule's commit test FORCES (`forcarPorCommit`, "Forcing" below).
 *
 * Both windows reach back {@link SOBREPOSICAO_CATCH_UP_MS} (5 minutes) below the
 * instant they resume from, for ONE reason: the main estoque writer
 * (`apps/functions/src/estoques/sincronizarEstoquePedido.ts`) takes its
 * `ultimaModificacao` stamp BEFORE its transaction and keeps that stamp through
 * the transaction's retries, so a row can COMMIT well after the instant its
 * stamp names. A read that ran before that commit never saw the row, and its
 * stamp sits below where the next read would otherwise start. Inside the
 * reach-back only a LATE commit is kept: a row committed before that instant
 * less {@link MARGEM_COMMIT_MS} (20 s, the skew allowed between our instance's
 * clock and Firestore's) was there for the earlier read, so only a later commit
 * can carry a movement that read missed.
 *
 *  - {@link janelaDoTick} — the 5-minute tick's, from its cursor `C`: the clock
 *    the previous tick read BEFORE its own window query ran. The range is
 *    `(max(C − 5 min, agora − 24 h), agora]`; a row STAMPED after `C − 20 s` is
 *    kept (a writer's clock may trail the cursor's: the overlap,
 *    {@link SOBREPOSICAO_MS}), and so is a row stamped further back but
 *    COMMITTED after `C − 20 s`. Past {@link JANELA_MAXIMA_MS} the range is
 *    clamped and `truncada` (a reconcile reads the rest): it is cut once
 *    `C − 5 min` lies more than 24 h back, so a cursor more than 23 h 55 min
 *    old is already truncated — 4 min 40 s sooner than a range starting at
 *    `C − 20 s` would be. A cursor ahead of this clock by the overlap or more is no window.
 *    There is NO first-tick case here: a sync document with no cursor stores
 *    one at now and reads no window (`sincronizacaoEstoque.ts`, T4), and a
 *    cursor removed by hand is that same first tick. The tick RESETS a stored
 *    cursor to now only after a durable reconcile request (a depósito change,
 *    or a cursor no window can be planned from), and the reconcile then reads
 *    everything before it. Over ANY cursor stored anew the reach-back keeps
 *    only what moved after it: rows stamped after it less the overlap, and rows
 *    committed after it less the margin.
 *  - {@link janelaDaRecuperacao} — a feed's recovery (the catch-up), merged
 *    with the pending start of the window batches a held lease turned away.
 *    With a snapshot `S`, the range reaches back to `S − 5 min`, and inside it
 *    only the rows COMMITTED after `S − 20 s` are kept: a row committed before
 *    the snapshot's reads was read by them. With a pending start `p`, every row
 *    stamped after `p` is kept too (those batches were never sent). Either input
 *    may be absent; both absent ⇒ no window.
 *
 * ### The residue and the cost
 *
 * A movement whose commit lags its stamp by more than about 5 minutes across a
 * tick boundary is still missed by every tick: its stamp lies below every later
 * range. Within the 20-s skew the margin allows, the bound is as low as
 * 4 min 40 s: when the tick's clock read the cursor 20 s AHEAD of Firestore's,
 * the previous query ran at `C − 20 s` on Firestore's clock, so a row stamped
 * just below `C − 5 min` and committed just after that query is out of every
 * later range. The SKU's next movement, or the daily reconcile, corrects it.
 *
 * The reach-back is paid mostly in rows: the rows stamped in the 4 min 40 s
 * between `C − 5 min` and `C − 20 s` are returned by the window query again
 * (projected to the stamp) and dropped here unless they committed late (no
 * produto read follows a dropped row), so a busy depósito reads each row about
 * twice. An idle tick runs the same queries as before; on a busy depósito the
 * re-read rows can push a ref form past a page boundary (one more window query
 * per page), and every one counts toward the window's page cap
 * ({@link TETO_PAGINAS_JANELA} pages of {@link LINHAS_POR_PAGINA_JANELA}), so a
 * burst reaches `truncada` — a reconcile — sooner.
 *
 * ## Forcing
 *
 * {@link forcarSku}: a SKU is FORCED (sent even when Amazon's live read already
 * shows its ERP value) only by a window whose `forcarPorCommit` is set — a
 * recovery with a snapshot — and only when one of its kept rows passed the
 * COMMIT test: the feed may have read that row's old value and its message may
 * still land after the live read. A row kept only by the pending start is NOT
 * forced: its live read is trustworthy. The TICK never forces: a row its commit
 * test keeps raced no feed, so the patch task's live read stands.
 *
 * ## Units
 *
 * Every number here is MILLISECONDS since epoch: the cursor, the snapshot, the
 * pending start, the stamps. A snapshot is compared WITHOUT conversion, and a
 * stored instant more than {@link ADIANTAMENTO_MAXIMO_MS} ahead of the clock (a
 * µs value) is THROWN, never read as an empty window. The ONE
 * conversion is the commit test's: a row's commit `updateTime` (a Firestore
 * `Timestamp`, Firestore's wall clock) becomes ms with `toMillis()` in
 * `commitAposMargem` alone, compared with the window's `commitAposMs` — the
 * tick's cursor or a feed's snapshot less 20 s, our instance's wall clock — and
 * the 20-s margin is the tick's own skew allowance. Everywhere else
 * an `updateTime` is an IDENTITY (the observation), compared as a `Timestamp`
 * (seconds, then the sub-second part, read by {@link partesDoCommit} alone),
 * never converted and never compared with a writer's ms stamp.
 *
 * ## From rows to SKUs
 *
 * {@link produtosDaJanela} groups the KEPT rows by the produto in their PATH
 * (`produtos/<id>/estoques/<docId>`, parsed by the family read's own
 * `partesDoCaminhoEstoqueAmazon`), each with its newest commit; a row outside a
 * produto's `estoques` is counted, never mapped.
 * {@link sondasDoProduto} names the produtos whose link partition can list a
 * SKU for it: itself, and its parent (a family-of-one wrapper's link sits on
 * the wrapper, while its member's row is what moves). {@link skusDaConta}
 * keeps the link docs of ONE conta, in both stored ref forms of the conta
 * (`contaRefForms`, the order import's own pair), compared EXACTLY.
 * {@link observacoesDaJanela} joins the three: per SKU, its OBSERVATION — the
 * newest commit `updateTime` among the rows that mapped to it — and its
 * forcing. A delta task is named by that observation, never by the tick's
 * clock, its cursor or `ultimaModificacao` (a writer's monotonic max, which a
 * later write whose clock lost does not move).
 *
 * PURE: no Firestore, no clock, no network.
 */
import type { TimestampLike } from '@delfrance/schemas';

import { partesDoCaminhoEstoqueAmazon } from './familiaEstoque';

/* --------------------------------- constants -------------------------------- */

/** The tick's overlap below its cursor: a writer's clock may trail the cursor's by this much. */
export const SOBREPOSICAO_MS = 20_000;

/** The furthest back a tick reads: 24 hours. Past it the window is clamped and `truncada`. */
export const JANELA_MAXIMA_MS = 86_400_000;

/**
 * How far a writer's COMMIT may lag the stamp it took, and so how far BOTH
 * windows reach back below the instant they resume from (the tick's cursor, a
 * feed's snapshot): 5 minutes. Inside that reach-back a row is kept only when it
 * committed after the instant less {@link MARGEM_COMMIT_MS}; a commit lagging
 * its stamp by more than about this (as little as this less the margin, under
 * the full clock skew) is missed (module header, "The residue and the cost").
 */
export const SOBREPOSICAO_CATCH_UP_MS = 300_000;

/**
 * The commit test's margin below the instant a window resumes from (the tick's
 * cursor, a feed's snapshot): the tick's own skew allowance.
 */
export const MARGEM_COMMIT_MS = SOBREPOSICAO_MS;

/**
 * The least a recovery's feed send is delayed past the snapshot it recovers:
 * twice {@link MARGEM_COMMIT_MS}, so consecutive snapshots of a chain of feeds
 * are always more than two margins apart and the chain ends once movement
 * stops.
 */
export const ESPACO_ENTRE_SNAPSHOTS_MS = 40_000;

/**
 * The furthest a stored instant (the tick's cursor, a snapshot, a pending
 * start) may sit AHEAD of this clock: 24 hours. A clock that ran ahead is off by
 * seconds; past this bound the value is a wiring bug (a µs value is about a
 * thousand times ahead), thrown, never answered as "nothing to read".
 */
export const ADIANTAMENTO_MAXIMO_MS = 86_400_000;

/** The most window pages one read takes, TOTAL across both depósito ref forms. */
export const TETO_PAGINAS_JANELA = 10;

/** The rows one window page reads. */
export const LINHAS_POR_PAGINA_JANELA = 300;

/* ---------------------------------- windows --------------------------------- */

/** A bounded movement window and its keep rule (module header). */
export interface JanelaEstoqueAmazon {
  /** ms — exclusive lower bound of the stamp range. */
  readonly desdeMs: number;
  /** ms — inclusive upper bound of the stamp range. */
  readonly ateMs: number;
  /** ms — keep a row STAMPED after it; `null` keeps none this way. */
  readonly manterDesdeMs: number | null;
  /** ms — keep a row COMMITTED after it; `null` keeps none this way. */
  readonly commitAposMs: number | null;
  /**
   * Whether a kept row that passed the commit test FORCES its SKU (module
   * header, "Forcing"): set for a recovery with a snapshot, never for the tick.
   */
  readonly forcarPorCommit: boolean;
}

/** The tick's window: it also says whether the 24-h clamp cut its range. */
export interface JanelaTickEstoqueAmazon extends JanelaEstoqueAmazon {
  readonly truncada: boolean;
}

/** A ms value: a non-negative safe integer, or a `RangeError` naming the field (never the value). */
function exigirMs(valor: number, campo: string): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`descobertaEstoque.ts: ${campo} deve ser um instante em ms`);
  }
  return valor;
}

/**
 * A stored instant at most {@link ADIANTAMENTO_MAXIMO_MS} ahead of `agoraMs`,
 * or a `RangeError` naming the field (never the value).
 */
function exigirNaoAdiantado(valor: number, agoraMs: number, campo: string): void {
  if (valor - agoraMs > ADIANTAMENTO_MAXIMO_MS) {
    throw new RangeError(
      `descobertaEstoque.ts: ${campo} está adiantado demais para ser um instante em ms`,
    );
  }
}

/**
 * The tick's window (module header): the range
 * `(max(cursor − 5 min, agora − 24 h), agora]`, keeping a row stamped after
 * `cursor − 20 s` or committed after `cursor − 20 s`, never forcing. `truncada`
 * when the 24-h clamp cut the range. `null` when the cursor is ahead of this
 * clock by the overlap or more (another instance's clock ran ahead): nothing any
 * tick could still miss, and the tick keeps its cursor, which never moves back.
 *
 * @throws {RangeError} an instant outside a non-negative safe integer, or a
 *   cursor more than {@link ADIANTAMENTO_MAXIMO_MS} ahead (a µs value or
 *   another wiring bug, which would otherwise freeze the tick silently).
 */
export function janelaDoTick(entrada: {
  readonly cursorMs: number;
  readonly agoraMs: number;
}): JanelaTickEstoqueAmazon | null {
  const cursorMs = exigirMs(entrada.cursorMs, 'cursorMs');
  const agoraMs = exigirMs(entrada.agoraMs, 'agoraMs');
  exigirNaoAdiantado(cursorMs, agoraMs, 'cursorMs');
  const pelaRecuperacao = cursorMs - SOBREPOSICAO_CATCH_UP_MS;
  const pelaJanelaMaxima = agoraMs - JANELA_MAXIMA_MS;
  const desdeMs = Math.max(0, pelaRecuperacao, pelaJanelaMaxima);
  const manterDesdeMs = Math.max(desdeMs, cursorMs - SOBREPOSICAO_MS);
  // The cursor ahead of this clock by the overlap or more (the 24-h floor never
  // reaches a clock, and 0 only a clock of 0): nothing any tick could still miss.
  if (manterDesdeMs >= agoraMs) return null;
  return {
    desdeMs,
    ateMs: agoraMs,
    manterDesdeMs,
    commitAposMs: Math.max(0, cursorMs - MARGEM_COMMIT_MS),
    forcarPorCommit: false,
    truncada: pelaRecuperacao < pelaJanelaMaxima,
  };
}

/**
 * A recovery's window (module header): `(min(S − 5 min, p), agora]`, keeping
 * every row stamped after `p` and every row committed after `S − 20 s`, the
 * latter forcing whenever there is a snapshot. `null` when both `S` and `p` are
 * absent, or when the range is empty.
 *
 * @param snapshotEmMs ms — the recovered feed's snapshot; `null` when nothing
 *   of a feed may have applied (a `vez` release, a cancelled feed).
 * @param pendenteDesdeMs ms — the earliest start of the turned-away batches; `null` when none.
 * @throws {RangeError} an instant outside a non-negative safe integer, or a
 *   snapshot or pending start more than {@link ADIANTAMENTO_MAXIMO_MS} ahead (a
 *   µs value, which would otherwise skip the catch-up silently).
 */
export function janelaDaRecuperacao(entrada: {
  readonly snapshotEmMs: number | null;
  readonly pendenteDesdeMs: number | null;
  readonly agoraMs: number;
}): JanelaEstoqueAmazon | null {
  const agoraMs = exigirMs(entrada.agoraMs, 'agoraMs');
  const { snapshotEmMs, pendenteDesdeMs } = entrada;
  if (snapshotEmMs !== null) {
    exigirMs(snapshotEmMs, 'snapshotEmMs');
    exigirNaoAdiantado(snapshotEmMs, agoraMs, 'snapshotEmMs');
  }
  if (pendenteDesdeMs !== null) {
    exigirMs(pendenteDesdeMs, 'pendenteDesdeMs');
    exigirNaoAdiantado(pendenteDesdeMs, agoraMs, 'pendenteDesdeMs');
  }
  if (snapshotEmMs === null && pendenteDesdeMs === null) return null;

  const inicios: number[] = [];
  if (snapshotEmMs !== null) inicios.push(snapshotEmMs - SOBREPOSICAO_CATCH_UP_MS);
  if (pendenteDesdeMs !== null) inicios.push(pendenteDesdeMs);
  const desdeMs = Math.max(0, Math.min(...inicios));
  if (desdeMs >= agoraMs) return null;
  return {
    desdeMs,
    ateMs: agoraMs,
    manterDesdeMs: pendenteDesdeMs,
    commitAposMs: snapshotEmMs === null ? null : Math.max(0, snapshotEmMs - MARGEM_COMMIT_MS),
    forcarPorCommit: snapshotEmMs !== null,
  };
}

/* ----------------------------------- rows ----------------------------------- */

/** One estoque row the window query returned: its path, its stamp and its commit. */
export interface LinhaJanelaEstoqueAmazon {
  /** The document's path, `produtos/<id>/estoques/<docId>`. */
  readonly caminho: string;
  /** ms — the row's `ultimaModificacao`. */
  readonly ultimaModificacao: number;
  /** The row's commit `updateTime`, from the query snapshot. */
  readonly updateTime: TimestampLike;
}

/** The commit test: the ONE place a commit `updateTime` becomes ms (module header, Units). */
function commitAposMargem(linha: LinhaJanelaEstoqueAmazon, janela: JanelaEstoqueAmazon): boolean {
  return janela.commitAposMs !== null && linha.updateTime.toMillis() > janela.commitAposMs;
}

/**
 * The keep rule: the row's stamp lies in the window's range, and it was either
 * stamped after `manterDesdeMs` or committed after `commitAposMs`.
 */
export function manterLinha(linha: LinhaJanelaEstoqueAmazon, janela: JanelaEstoqueAmazon): boolean {
  const carimbo = linha.ultimaModificacao;
  if (!(carimbo > janela.desdeMs && carimbo <= janela.ateMs)) return false;
  if (janela.manterDesdeMs !== null && carimbo > janela.manterDesdeMs) return true;
  return commitAposMargem(linha, janela);
}

/**
 * A SKU is forced when the window forces by commit and one of its KEPT rows
 * passed the commit test (module header, "Forcing").
 */
export function forcarSku(
  linhas: readonly LinhaJanelaEstoqueAmazon[],
  janela: JanelaEstoqueAmazon,
): boolean {
  if (!janela.forcarPorCommit) return false;
  return linhas.some((l) => manterLinha(l, janela) && commitAposMargem(l, janela));
}

/**
 * A commit `Timestamp` as its two integer parts, `[seconds, nanoseconds]`, for
 * the observation's IDENTITY only: its order here, and its rendering in a task
 * name (`tarefaEstoque.ts`). Never a clock and never a count of µs: it converts
 * nothing, so it is not one of the app's µs conversion sites (those live in
 * `avisos/avisos.ts`). It is the ONE reader of a sub-second part under
 * `estoque/`, and it reads the pair whole (`descobertaEstoque.test.ts` pins both).
 */
export function partesDoCommit(t: TimestampLike): readonly [number, number] {
  const { seconds, nanoseconds } = t;
  return [seconds, nanoseconds];
}

/** `a` committed strictly after `b`, compared as `Timestamp`s: seconds, then the sub-second part. */
function maisNovo(a: TimestampLike, b: TimestampLike): boolean {
  const [sa, na] = partesDoCommit(a);
  const [sb, nb] = partesDoCommit(b);
  return sa !== sb ? sa > sb : na > nb;
}

/** Code-unit order, never a locale's. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A produto whose rows the window kept: its newest commit and those rows. */
export interface ProdutoDaJanelaEstoqueAmazon {
  readonly produtoId: string;
  /** The newest commit among its kept rows. */
  readonly updateTime: TimestampLike;
  readonly linhas: readonly LinhaJanelaEstoqueAmazon[];
}

export interface ProdutosDaJanelaEstoqueAmazon {
  /** Sorted by `produtoId`. */
  readonly produtos: readonly ProdutoDaJanelaEstoqueAmazon[];
  /** Kept rows whose path is not a produto's `estoques` row: counted, never mapped. */
  readonly foraDeProduto: number;
}

/** The kept rows grouped by the produto in their PATH (module header). */
export function produtosDaJanela(
  linhas: readonly LinhaJanelaEstoqueAmazon[],
  janela: JanelaEstoqueAmazon,
): ProdutosDaJanelaEstoqueAmazon {
  const porProduto = new Map<
    string,
    { updateTime: TimestampLike; linhas: LinhaJanelaEstoqueAmazon[] }
  >();
  let foraDeProduto = 0;
  for (const linha of linhas) {
    if (!manterLinha(linha, janela)) continue;
    const partes = partesDoCaminhoEstoqueAmazon(linha.caminho);
    if (partes === null) {
      foraDeProduto += 1;
      continue;
    }
    const { produtoId } = partes;
    const atual = porProduto.get(produtoId);
    if (atual === undefined) {
      porProduto.set(produtoId, { updateTime: linha.updateTime, linhas: [linha] });
      continue;
    }
    atual.linhas.push(linha);
    if (maisNovo(linha.updateTime, atual.updateTime)) atual.updateTime = linha.updateTime;
  }
  const produtos = [...porProduto.entries()]
    .sort(([a], [b]) => compararTexto(a, b))
    .map(([produtoId, p]) => ({ produtoId, updateTime: p.updateTime, linhas: p.linhas }));
  return { produtos, foraDeProduto };
}

/**
 * The probe set of a produto and the conta's SKUs among a partition listing
 * (module header): the shared helpers of `listings/sondasVinculos.ts`, under
 * the stock names.
 */
export { skusDaConta, sondasDoProduto } from '../listings/sondasVinculos';

/** One SKU's observation: the delta task's identity, and whether it is forced. */
export interface ObservacaoEstoqueAmazon {
  readonly sku: string;
  /** The newest commit among the rows that mapped to the SKU. */
  readonly updateTime: TimestampLike;
  readonly forcar: boolean;
}

/** What {@link observacoesDaJanela} joins. */
export interface EntradaObservacoesEstoqueAmazon {
  /** {@link produtosDaJanela}'s produtos. */
  readonly produtos: readonly ProdutoDaJanelaEstoqueAmazon[];
  /** Each window produto's probe set ({@link sondasDoProduto}). */
  readonly sondasPorProduto: ReadonlyMap<string, readonly string[]>;
  /** Each probe's SKUs of the conta ({@link skusDaConta}). */
  readonly skusPorSonda: ReadonlyMap<string, readonly string[]>;
  readonly janela: JanelaEstoqueAmazon;
}

/**
 * Per SKU, its observation and its forcing (module header), sorted by SKU. A
 * SKU listed by several probes is ONE observation, its newest commit across
 * every row that mapped to it. SKUs are compared EXACTLY.
 *
 * @throws {TypeError} a window produto without its probe set, or a probe whose
 *   partition was not listed: an incomplete mapping is a wiring bug, never a
 *   SKU silently left out.
 */
export function observacoesDaJanela(
  entrada: EntradaObservacoesEstoqueAmazon,
): readonly ObservacaoEstoqueAmazon[] {
  const porSku = new Map<
    string,
    { updateTime: TimestampLike; linhas: LinhaJanelaEstoqueAmazon[] }
  >();
  for (const produto of entrada.produtos) {
    const sondas = entrada.sondasPorProduto.get(produto.produtoId);
    if (sondas === undefined) {
      throw new TypeError('descobertaEstoque.ts: um produto da janela sem as suas sondas');
    }
    for (const sonda of sondas) {
      const skus = entrada.skusPorSonda.get(sonda);
      if (skus === undefined) {
        throw new TypeError('descobertaEstoque.ts: uma sonda cuja partição não foi listada');
      }
      for (const sku of skus) {
        const atual = porSku.get(sku);
        if (atual === undefined) {
          porSku.set(sku, { updateTime: produto.updateTime, linhas: [...produto.linhas] });
          continue;
        }
        atual.linhas.push(...produto.linhas);
        if (maisNovo(produto.updateTime, atual.updateTime)) atual.updateTime = produto.updateTime;
      }
    }
  }
  return [...porSku.entries()]
    .sort(([a], [b]) => compararTexto(a, b))
    .map(([sku, o]) => ({
      sku,
      updateTime: o.updateTime,
      forcar: forcarSku(o.linhas, entrada.janela),
    }));
}

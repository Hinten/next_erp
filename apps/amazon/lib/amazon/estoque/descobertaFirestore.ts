/**
 * The Firestore half of the Amazon stock sync's discovery (step 12, PR 12-e2):
 * which of ONE conta's SKUs moved inside a movement window, read through the
 * collection handles, masked, bounded and paged. What a window is, which rows
 * it keeps, how a row becomes a SKU and what an observation is are
 * `descobertaEstoque.ts`'s (pure); this module only READS and hands them over.
 *
 * ONE function, {@link descobrirJanelaEstoqueAmazon}, serves every reader of a
 * window — the five-minute tick, a feed's recovery delta, a window batch's
 * members re-derived at send time — so they all read the same rows the same
 * way, and the window's keep rule is applied in one place.
 *
 * ## The reads, in order
 *
 *  1. The WINDOW, per stored form of the depósito's ref (canonical first, then
 *     the bare one): a collection-group query through the estoque handle,
 *     `depositoOuterRef ==` that form, `ultimaModificacao >` the window's start
 *     AND `<=` its end, ordered by the stamp and then the document key,
 *     projected (a classic `select`) to the stamp alone,
 *     {@link LINHAS_POR_PAGINA_JANELA} rows a page, paged by the last page's
 *     document snapshot. The field names are
 *     `CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON`, the spelling the declared
 *     collection-group index `estoques (depositoOuterRef ASC, ultimaModificacao
 *     ASC, __name__ ASC)` is pinned against. ⚠️ Never one `in` over the two
 *     forms (one disjunction would merge two index ranges, and the page order
 *     with them) and never one bound alone (an open range reads the whole tail
 *     of the index). Each row is handed over with its path, its stamp and its
 *     commit `updateTime`, taken from the query snapshot: a projected document
 *     still carries it.
 *  2. The keep rule (`manterLinha`, through `produtosDaJanela`) and the produtos
 *     of the kept rows, from their PATHS.
 *  3. Those produtos by id, in `getAll` calls of at most
 *     `MAX_REFS_GETALL_ESTOQUE_AMAZON` refs, masked to
 *     {@link CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON} (`paiId` alone: the
 *     probe set is a produto and its parent).
 *  4. The probes, DEDUPLICATED across produtos (a family's members share their
 *     parent's): ONE listing of each probe's own `prodAmazon` partition through
 *     the link handle — no `where`, no order, no limit — projected to
 *     {@link CAMPOS_VINCULO_DESCOBERTA_ESTOQUE_AMAZON}, at most
 *     `LARGURA_PARTICOES_ESTOQUE_AMAZON` at once. A partition read needs no
 *     index, and a produto with no Amazon link answers nothing. ⚠️ Never a
 *     filter there: the same filter as a collection-group query is a scan per
 *     row. Whether Enterprise bounds this classic listing to its partition is
 *     unmeasured (a staging measurement before the window).
 *  5. `skusDaConta` per probe, then `observacoesDaJanela`: the conta's SKUs,
 *     each with its observation and whether it is forced.
 *
 * ## The page budget and truncation
 *
 * At most {@link TETO_PAGINAS_JANELA} window pages in ALL, both forms together.
 * A form is complete once a page of it comes back SHORT (fewer rows than a
 * page). The window is complete when every form is; when the budget runs out
 * first — a full tenth page, or a form not yet read — the window is TRUNCATED:
 * no eleventh page is read to tell, nothing after read 1 is made, and the
 * caller hands the window to a reconcile. The other form always costs a page,
 * even empty, so one form holding nine full pages of rows or more (2,700) reads
 * as truncated, and 2,699 at one form with the other empty reads complete. A
 * tick window the 24-hour clamp already cut (`truncada: true`) answers
 * truncated before any read.
 *
 * ## The deadline
 *
 * The caller's `prazoMs`, an absolute instant in ms, is read against the
 * caller's clock BEFORE every window page, every produto `getAll` and every
 * batch of listings: once it has passed, nothing more is started and the
 * answer is `prazo`, naming the read it stopped before. A read already started
 * is awaited, never left running behind the answer.
 *
 * ## What it answers
 *
 * `completa` with the observations, sorted by SKU; `truncada`; or `prazo`.
 * Every answer carries what was read so far ({@link ContagemDescobertaEstoqueAmazon}).
 *
 * Reads only: no write, no network, no task. Its one clock is the caller's.
 */
import type { DocumentSnapshot, Firestore, Query } from 'firebase-admin/firestore';
import {
  estoqueCollection,
  produtoAmazonLinkCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';
import {
  CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON,
  CONTA_ID_AMAZON_REGEX,
  type produtoAmazonLinkSchema,
  type produtoSchema,
} from '@delfrance/schemas';

import {
  type JanelaEstoqueAmazon,
  LINHAS_POR_PAGINA_JANELA,
  type LinhaJanelaEstoqueAmazon,
  type ObservacaoEstoqueAmazon,
  TETO_PAGINAS_JANELA,
  observacoesDaJanela,
  produtosDaJanela,
  skusDaConta,
  sondasDoProduto,
} from './descobertaEstoque';
import { formasRefDepositoEstoqueAmazon } from './familiaEstoque';
import {
  LARGURA_PARTICOES_ESTOQUE_AMAZON,
  MAX_REFS_GETALL_ESTOQUE_AMAZON,
} from './familiaEstoqueFirestore';

/** The produto field the probe set reads (module header, read 3). */
export const CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON = ['paiId'] as const satisfies ReadonlyArray<
  keyof typeof produtoSchema.shape
>;

/** The link fields `skusDaConta` reads (module header, read 4). */
export const CAMPOS_VINCULO_DESCOBERTA_ESTOQUE_AMAZON = [
  'contaAmazonOuterRef',
  'sku',
] as const satisfies ReadonlyArray<keyof typeof produtoAmazonLinkSchema.shape>;

/** The document key as a field path: the window's tie-break order (module header, read 1). */
export const CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON = '__name__';

/** How a discovery ended (module header, "What it answers"). */
export const DESFECHO_DESCOBERTA_ESTOQUE_AMAZON = {
  completa: 'completa',
  truncada: 'truncada',
  prazo: 'prazo',
} as const;

/** The read a deadline stopped before (module header, "The deadline"). */
export const ETAPA_DESCOBERTA_ESTOQUE_AMAZON = {
  janela: 'janela',
  produtos: 'produtos',
  vinculos: 'vinculos',
} as const;

export type EtapaDescobertaEstoqueAmazon =
  (typeof ETAPA_DESCOBERTA_ESTOQUE_AMAZON)[keyof typeof ETAPA_DESCOBERTA_ESTOQUE_AMAZON];

/** What one discovery read, counted. */
export interface ContagemDescobertaEstoqueAmazon {
  /** Window queries run, both forms together. */
  readonly paginas: number;
  /** Rows the window queries returned. */
  readonly linhas: number;
  /** Rows the keep rule kept (outside a produto's estoques included). */
  readonly mantidas: number;
  /** Kept rows whose path is no produto's estoque row: counted, never mapped. */
  readonly foraDeProduto: number;
  /** Produtos read by id (step 3). */
  readonly produtos: number;
  /** Link partitions listed (step 4). */
  readonly sondas: number;
}

export type DescobertaEstoqueAmazon =
  | {
      readonly tipo: typeof DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.completa;
      /** Per SKU of the conta, its observation and whether it is forced; sorted by SKU. */
      readonly observacoes: readonly ObservacaoEstoqueAmazon[];
      readonly contagem: ContagemDescobertaEstoqueAmazon;
    }
  | {
      readonly tipo: typeof DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada;
      readonly contagem: ContagemDescobertaEstoqueAmazon;
    }
  | {
      readonly tipo: typeof DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.prazo;
      readonly etapa: EtapaDescobertaEstoqueAmazon;
      readonly contagem: ContagemDescobertaEstoqueAmazon;
    };

/** Who reads, for which conta, at which depósito, by which clock. */
export interface ContextoDescobertaEstoqueAmazon {
  readonly db: Firestore;
  /** The conta whose SKUs are wanted. */
  readonly contaId: string;
  /** The depósito the window is read at, as a document id (`depositoIdDaContaEstoqueAmazon`). */
  readonly depositoId: string;
  /** The caller's clock, ms: the deadline is read against it. */
  readonly agora: () => number;
}

export interface OpcoesDescobertaEstoqueAmazon {
  /** ms — the instant past which no read is started (module header, "The deadline"). */
  readonly prazoMs: number;
}

/** A window as a caller holds it: a tick's also says whether the 24-hour clamp cut it. */
export type JanelaDescobertaEstoqueAmazon = JanelaEstoqueAmazon & { readonly truncada?: boolean };

const [CAMPO_DEPOSITO, CAMPO_CARIMBO] = CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON;

/** `itens` in consecutive slices of at most `tamanho`. */
function fatias<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/** A ms instant: a non-negative safe integer, or a `RangeError` naming the field (never the value). */
function exigirMs(valor: number, campo: string): void {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`descobertaFirestore.ts: ${campo} deve ser um instante em ms`);
  }
}

/** One page's query for one ref form (module header, read 1), before its cursor. */
function consultaDaJanela(db: Firestore, forma: string, janela: JanelaEstoqueAmazon): Query {
  return estoqueCollection
    .groupQuery(db)
    .where(CAMPO_DEPOSITO, '==', forma)
    .where(CAMPO_CARIMBO, '>', janela.desdeMs)
    .where(CAMPO_CARIMBO, '<=', janela.ateMs)
    .orderBy(CAMPO_CARIMBO)
    .orderBy(CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON)
    .select(CAMPO_CARIMBO)
    .limit(LINHAS_POR_PAGINA_JANELA);
}

/**
 * A window row as the pure planner reads it: its path, its stamp, its commit.
 *
 * @throws {TypeError} a stamp that is not a finite number (a numeric range
 *   returns numbers only: a wiring bug, never data).
 */
function linhaDoDocumento(doc: DocumentSnapshot): LinhaJanelaEstoqueAmazon {
  const carimbo: unknown = (doc.data() ?? {})[CAMPO_CARIMBO];
  const { updateTime } = doc;
  if (typeof carimbo !== 'number' || !Number.isFinite(carimbo) || updateTime === undefined) {
    throw new TypeError('descobertaFirestore.ts: uma linha da janela sem carimbo ou sem commit');
  }
  return { caminho: doc.ref.path, ultimaModificacao: carimbo, updateTime };
}

/** A snapshot's data, or `null` when the document does not exist. */
function dadosDe(snap: DocumentSnapshot | undefined): Readonly<Record<string, unknown>> | null {
  if (snap?.exists !== true) return null;
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/** One probe's `prodAmazon` partition, whole and projected (module header, read 4). */
async function lerVinculosDaSonda(
  db: Firestore,
  produtoId: string,
): Promise<Readonly<Record<string, unknown>>[]> {
  const snap = await produtoAmazonLinkCollection
    .ref(db, { produtoId })
    .select(...CAMPOS_VINCULO_DESCOBERTA_ESTOQUE_AMAZON)
    .get();
  return snap.docs.map((d) => d.data());
}

/** Where one ref form's pages stand. */
interface PaginacaoDaForma {
  readonly forma: string;
  cursor: DocumentSnapshot | null;
  completa: boolean;
}

/**
 * The conta's SKUs that moved inside `janela` at the context's depósito
 * (module header): reads 1–5, under the page budget and the deadline.
 *
 * @throws {RangeError} a `contaId` outside the conta id grammar, a `depositoId`
 *   that is not a document id, or a bound that is not a ms instant (nothing
 *   read).
 */
export async function descobrirJanelaEstoqueAmazon(
  ctx: ContextoDescobertaEstoqueAmazon,
  janela: JanelaDescobertaEstoqueAmazon,
  opcoes: OpcoesDescobertaEstoqueAmazon,
): Promise<DescobertaEstoqueAmazon> {
  const { db, contaId, depositoId } = ctx;
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('descobertaFirestore.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
  const formas = formasRefDepositoEstoqueAmazon(depositoId);
  exigirMs(janela.desdeMs, 'desdeMs');
  exigirMs(janela.ateMs, 'ateMs');

  let paginas = 0;
  let mantidas = 0;
  let foraDeProduto = 0;
  let produtosLidos = 0;
  let sondasListadas = 0;
  const linhas: LinhaJanelaEstoqueAmazon[] = [];
  const contagem = (): ContagemDescobertaEstoqueAmazon => ({
    paginas,
    linhas: linhas.length,
    mantidas,
    foraDeProduto,
    produtos: produtosLidos,
    sondas: sondasListadas,
  });
  const venceu = () => ctx.agora() >= opcoes.prazoMs;
  const truncada = (): DescobertaEstoqueAmazon => ({
    tipo: DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada,
    contagem: contagem(),
  });
  const prazo = (etapa: EtapaDescobertaEstoqueAmazon): DescobertaEstoqueAmazon => ({
    tipo: DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.prazo,
    etapa,
    contagem: contagem(),
  });

  // A tick window the 24-hour clamp cut: a reconcile reads it, nothing here does.
  if (janela.truncada === true) return truncada();

  // 1. The window: one form after the other, under ONE page budget.
  const paginacoes: PaginacaoDaForma[] = formas.map((forma) => ({
    forma,
    cursor: null,
    completa: false,
  }));
  for (;;) {
    const atual = paginacoes.find((p) => !p.completa);
    if (atual === undefined) break;
    // A full last page, or a form never read, with no page left: truncated.
    if (paginas >= TETO_PAGINAS_JANELA) return truncada();
    if (venceu()) return prazo(ETAPA_DESCOBERTA_ESTOQUE_AMAZON.janela);
    const consulta = consultaDaJanela(db, atual.forma, janela);
    const snap = await (atual.cursor === null ? consulta : consulta.startAfter(atual.cursor)).get();
    paginas += 1;
    for (const doc of snap.docs) linhas.push(linhaDoDocumento(doc));
    if (snap.docs.length < LINHAS_POR_PAGINA_JANELA) atual.completa = true;
    else atual.cursor = snap.docs.at(-1) ?? null;
  }

  // 2. The keep rule, and the produtos of the kept rows from their paths.
  const daJanela = produtosDaJanela(linhas, janela);
  foraDeProduto = daJanela.foraDeProduto;
  mantidas = foraDeProduto + daJanela.produtos.reduce((n, p) => n + p.linhas.length, 0);

  // 3. The produtos, masked to their parent pointer.
  const rawPorProduto = new Map<string, Readonly<Record<string, unknown>> | null>();
  for (const fatia of fatias(
    daJanela.produtos.map((p) => p.produtoId),
    MAX_REFS_GETALL_ESTOQUE_AMAZON,
  )) {
    if (venceu()) return prazo(ETAPA_DESCOBERTA_ESTOQUE_AMAZON.produtos);
    const snaps = await db.getAll(...fatia.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: [...CAMPOS_PRODUTO_DESCOBERTA_ESTOQUE_AMAZON],
    });
    produtosLidos += fatia.length;
    for (const [i, id] of fatia.entries()) rawPorProduto.set(id, dadosDe(snaps[i]));
  }

  // 4. The probes, each partition listed once, a bounded batch at a time.
  const sondasPorProduto = new Map(
    daJanela.produtos.map(
      (p) =>
        [
          p.produtoId,
          sondasDoProduto(p.produtoId, rawPorProduto.get(p.produtoId) ?? null),
        ] as const,
    ),
  );
  const sondas = [...new Set([...sondasPorProduto.values()].flat())];
  const skusPorSonda = new Map<string, readonly string[]>();
  for (const fatia of fatias(sondas, LARGURA_PARTICOES_ESTOQUE_AMAZON)) {
    if (venceu()) return prazo(ETAPA_DESCOBERTA_ESTOQUE_AMAZON.vinculos);
    const listas = await Promise.all(fatia.map((sonda) => lerVinculosDaSonda(db, sonda)));
    sondasListadas += fatia.length;
    for (const [i, sonda] of fatia.entries()) {
      skusPorSonda.set(sonda, skusDaConta(listas[i] ?? [], contaId));
    }
  }

  // 5. Per SKU of the conta, its observation and its forcing.
  return {
    tipo: DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.completa,
    observacoes: observacoesDaJanela({
      produtos: daJanela.produtos,
      sondasPorProduto,
      skusPorSonda,
      janela,
    }),
    contagem: contagem(),
  };
}

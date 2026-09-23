/**
 * **The PURE planner** (#1520, step 12) — one discovered family plus one map of
 * quantities ⇒ the Cloud Tasks this sweep will enqueue, and an observable line
 * for every listing and every model it will NOT send.
 *
 * Nothing here reads Firestore, reads the clock or calls Shopee. That is not
 * tidiness: the planner is where a model can silently disappear — dropped by a
 * filter, swallowed by a dedupe, lost off the end of a chunk — and a pure
 * function is one a test can interrogate with a fixture instead of a double.
 * The sweep (`varreduraEstoque.ts`) owns the reads and the clock; the sender
 * (`enviarEstoque.ts`) owns the wire. This owns the ARITHMETIC OF WHAT GETS
 * SENT.
 *
 * ## Why the row shapes live HERE
 *
 * `descobertaEstoque.ts` produces them and this module consumes them, so one of
 * the two has to declare them. It is this one, because the planner also needs
 * them in its tests and because a cycle (`plano` → `descoberta` → `plano`) is
 * exactly what declaring them on the producing side would create.
 *
 * ⚠️ {@link MembroDaFamilia} is **not redeclared** — it is the promoted core's
 * own type, re-exported. `quantidadesDaFamiliaShopee` and its neighbours take
 * the core's `LinhaDeFamilia`, so a second structurally-identical declaration
 * here would be two names for one contract, free to drift apart the first time
 * the core gains a field. {@link LinhaDeEstoqueCrua} is the same story
 * (`RawEstoqueRow`), and {@link LinkShopeeCru} EXTENDS the gate's own
 * {@link LinkParaEstoque} so a discovery row is handed to
 * {@link podeEnviarEstoqueShopee} without a cast and without a shaping step.
 *
 * ## The three folds this module performs, and their scope
 *
 * 1. **Which conta a `prodshopee` belongs to** — the stored
 *    `contaProdutoShopeeOuterRef` compared to the integração id by its LAST
 *    path segment. EQUAL: the two stored ref encodings of one integração
 *    (`documents/integracoes/<id>` and the bare `integracoes/<id>`), because the
 *    migrated corpus carries both. DISTINCT: any other id. ⚠️ Recorded
 *    widening: only the last segment is compared, so a ref into a DIFFERENT
 *    collection whose document id happened to equal the integração id would
 *    match. Nothing writes such a value — every producer writes
 *    `integracaoCollection.docPath` — and the alternative (comparing the
 *    collection segment too) would refuse a legacy encoding this fold exists to
 *    accept.
 * 2. **Which LISTING a `variashopee` belongs to** — the stored
 *    `produtoShopeeOuterRef` compared to the `prodshopee` document id, by the
 *    same last-segment rule. ⚠️ This one is load-bearing rather than defensive:
 *    **two `prodshopee` documents under one produto are LEGAL**, so a child
 *    model must be attributed to its parent LINK and never to its parent
 *    PRODUTO. Attributing by produto would hand listing A the models of listing
 *    B, and `update_stock` would answer 200 having written the wrong numbers.
 * 3. **Which `model_id` readings mean "no usable model"** — `0` (Shopee's
 *    no-variation sentinel), absent, non-numeric and non-integer all fold to
 *    ONE outcome: the row is not a model this planner can address. DISTINCT:
 *    every positive integer, including two ids one digit apart.
 *
 * ## ⚠️ The completeness invariant
 *
 * Per listing: `models placed in tasks + models accounted for by a skip row ===
 * usable models` (and a no-model listing has exactly ONE such unit, the
 * `modelId: 0` write). {@link conferirCompletudeDoAnuncio} asserts it on every
 * listing and THROWS when it fails — a thrown `Error` is right here because a
 * mismatch is a programming error in this file, not a wire fault: nothing
 * outside can cause it and nothing downstream could act on it.
 *
 * ## What this module deliberately does NOT do
 *
 * - It does not decide WHETHER the family changed — that is
 *   `deveEnviarFamiliaShopee` in `./quantidadeEstoque`, which the sweep asks
 *   first.
 * - It does not clamp to the category band. Quantities travel UNCLAMPED and the
 *   sender clamps, because the band is a per-(conta, categoria) wire bound and
 *   belongs where the wire body is built (M-33).
 * - It does not raise the unverifiable-kit alarm Mercado Livre's twin raises.
 *   Recorded as a residual rather than forgotten: `kitNaoVerificavel` and
 *   `componentesNaoResolvidos` are exported from the core for exactly that log
 *   line, and a kit publishing 0 because its `componentesKitKeys` denorm went
 *   stale is otherwise invisible.
 */
import { idFromRef } from '@delfrance/schemas';

import {
  type LinhaDeFamilia,
  type MembroDaFamilia,
  type MovimentosDaJanela,
  type RawEstoqueRow,
  STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
  STOCK_TASK_ENCODED_BODY_WARN_BYTES,
  chaveMovimento,
  stockTaskEncodedBodyBytes,
} from '@delfrance/data/admin/estoque';

import { MAX_MODELOS_POR_TASK } from './constantesEstoque';
import {
  type MotivoEstoqueShopee,
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
} from './errosEstoque';
import { type LinkParaEstoque, podeEnviarEstoqueShopee } from './podeEnviarEstoque';
import { quantidadesAnterioresShopee } from './quantidadeEstoque';

export type { MembroDaFamilia };

/* -------------------------------------------------------------------------- */
/*                               THE ROW SHAPES                               */
/* -------------------------------------------------------------------------- */

/**
 * One raw estoque row as the discovery projection returns it.
 *
 * An ALIAS of the promoted core's `RawEstoqueRow`, never a copy: the core's
 * arithmetic reads these fields and a second declaration would let the two
 * drift while both kept compiling.
 */
export type LinhaDeEstoqueCrua = RawEstoqueRow;

/**
 * One `prodshopee` document as the discovery projection returns it —
 * unvalidated, every field `unknown`.
 *
 * ⚠️ It EXTENDS {@link LinkParaEstoque}, the gate's own row type, so the eight
 * fields the gate reads are declared once. Hand a row of this type straight to
 * {@link podeEnviarEstoqueShopee}: no parse, no shaping, no cast.
 */
export interface LinkShopeeCru extends LinkParaEstoque {
  /** Which conta owns this listing. Either stored ref encoding; see fold (1). */
  contaProdutoShopeeOuterRef?: unknown;
  /** Whether the ERP itself paused the listing. Carried, never read here. */
  pausadoPeloErp?: unknown;
  /** Shopee's category id — the sender's band lookup key. */
  category_id?: unknown;
  /** The `prodshopee` document's own id, projected by the query. */
  linkDocId?: unknown;
  /** The last refusal's slug. Carried for the surfaces; not read here. */
  estoqueRecusaMotivo?: unknown;
  /** The last refusal's provider code, verbatim. Carried; not read here. */
  estoqueRecusaCodigo?: unknown;
  /** MILLISECONDS — when the parent link was last sent cleanly. Carried. */
  estoqueEnviadoEm?: unknown;
}

/**
 * One `variashopee` document as the discovery projection returns it —
 * unvalidated, every field `unknown`.
 */
export interface VarLinkShopeeCru {
  /** Which conta owns this model link. Carried; attribution uses the LINK ref. */
  contaVariacaoShopeeOuterRef?: unknown;
  /**
   * ⚠️ **Load-bearing.** The `prodshopee` document this model belongs to. Two
   * `prodshopee` docs under one produto are LEGAL, so this — not the produto —
   * is what binds a model to a listing. See fold (2) in the module header.
   */
  produtoShopeeOuterRef?: unknown;
  /** Shopee's model id. `0`, absent and unreadable all mean "no usable model". */
  model_id?: unknown;
  model_status?: unknown;
  tier_index?: unknown;
  /** MILLISECONDS — set while a model list stopped reporting this model. */
  modeloAusenteEm?: unknown;
  /** The `variashopee` document's own id, projected by the query. */
  varLinkDocId?: unknown;
  [k: string]: unknown;
}

/** A variation child: a family member that also carries its own model links. */
export interface FilhoDaFamilia extends MembroDaFamilia {
  readonly varLinks: readonly VarLinkShopeeCru[];
}

/**
 * One discovered family, Shopee-shaped.
 *
 * ⚠️ It structurally satisfies the promoted core's `LinhaDeFamilia` (`anchor` +
 * `children`), which is what lets `quantidadesDaFamiliaShopee` and
 * {@link anterioresComDesauditado} take it without a cast. The extra keys are
 * this channel's and the core ignores them.
 */
export interface LinhaDeFamiliaShopee {
  readonly anchorId: string;
  readonly anchor: MembroDaFamilia;
  /**
   * The produto's conta denorm. Maintained by an EVENTUALLY-consistent trigger,
   * which is why the planner still checks it: the discovery query filters on it
   * server-side, but the by-ids path used by the manual push does not.
   */
  readonly integracoesComProduto: readonly string[];
  readonly links: readonly LinkShopeeCru[];
  readonly children: readonly FilhoDaFamilia[];
}

/** One keyset-paged discovery page. `nextAfterAnchorId` is null on the last one. */
export interface PaginaDeFamiliasShopee {
  readonly rows: readonly LinhaDeFamiliaShopee[];
  readonly nextAfterAnchorId: string | null;
}

/* -------------------------------------------------------------------------- */
/*                       THE DE-AUDITED ARM (C-q, M-35/36)                    */
/* -------------------------------------------------------------------------- */

/**
 * True when ONE estoque row moved inside the window without leaving a ledger
 * row behind.
 *
 * "Moved" is the row's OWN `ultimaModificacao` being strictly newer than the
 * window start. "Without a ledger row" is the absence of any entry for its
 * `(produto, depósito)` pair — absence, not a zero sum: a pair that genuinely
 * did not move has no entry either, and that is why the stamp is checked FIRST.
 *
 * ⚠️ A row with no usable join key answers TRUE, and that is the fail-open
 * direction on purpose: it moved (its stamp says so) and no ledger entry can
 * ever be attributed to it, which is the definition of unknown.
 */
function linhaDesauditada(
  linha: LinhaDeEstoqueCrua,
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
  changedSinceMs: number,
): boolean {
  const carimbo = linha.ultimaModificacao;
  // ⚠️ `changedSinceMs`, never the clock (M-36). The window is the sweep's, and
  // the planner has no clock of its own to compare against.
  if (typeof carimbo !== 'number' || !Number.isFinite(carimbo)) return false;
  if (carimbo <= changedSinceMs) return false;
  if (typeof produtoId !== 'string' || produtoId === '') return true;
  return !movimentos.has(chaveMovimento(produtoId, depositoId));
}

/**
 * **The step-9 gap, closed** (C-q). This member's stock changed inside the
 * window and the ledger cannot say by how much, so its window-start quantity
 * cannot be reconstructed — it is UNKNOWN, and an unknown member is omitted
 * from the baseline and therefore SENDS.
 *
 * ## Why the gap exists
 *
 * Shopee's own stock import (`aplicarEstoqueShopee`, step 9) merges
 * `quantidade` and `ultimaModificacao` onto the estoque document and writes
 * **no `historicoEstoque` row**. The window sees the fresh
 * `ultimaModificacao` and admits the family; the ledger aggregate then sums
 * nothing; `anterior` comes out equal to `atual`; and the send is skipped for
 * exactly the produtos an import just changed. ADR 0014 names this class
 * ("unaudited merge") and Mercado Livre's plan core names it as a blind spot it
 * cannot detect. This arm detects it.
 *
 * ## ⚠️ Per MEMBER, on the ROW's stamp — never "the family moved"
 *
 * A sibling that genuinely did not move has its own stamp OUTSIDE the window
 * and still reads as unchanged, which is what keeps the change check paying for
 * itself. Widening the test to the family would force-send every family on
 * every tick, and the tick would still look correct (M-35).
 *
 * On the reconciliação tier the baseline is `null` altogether, so this arm
 * never runs there and cannot interact with it.
 */
export function estoqueDesauditado(
  member: MembroDaFamilia,
  depositoId: string,
  movimentos: MovimentosDaJanela,
  changedSinceMs: number,
): boolean {
  if (
    member.estoque != null &&
    linhaDesauditada(member.estoque, member.produtoId, depositoId, movimentos, changedSinceMs)
  ) {
    return true;
  }
  // ⚠️ Component rows are keyed by their `parentId` denorm and a member's OWN
  // row by `member.produtoId` (#932) — the two row classes carry different join
  // keys and always will.
  return member.componentEstoques.some((linha) =>
    linhaDesauditada(linha, linha.parentId, depositoId, movimentos, changedSinceMs),
  );
}

/**
 * **The baseline the sweep must use** — `quantidadesAnterioresShopee` with the
 * de-audited members removed.
 *
 * ⚠️ `quantidadesAnterioresShopee` alone is NOT the sweep's function. It applies
 * the core's two omission arms (an unreadable ledger movement, an unverifiable
 * kit) and knows nothing about step 9's unaudited merge. Call THIS one; the
 * difference is silent, and the symptom is a Shopee import whose quantities are
 * never published back.
 *
 * ⚠️ **THE OMISSION IS THE MECHANISM** (ADR 0014 §5b). A de-audited member is
 * DELETED from the map, not replaced with a guess: `deveEnviarFamiliaShopee`
 * reads a missing entry as unknown and sends, while any fallback value would
 * read as "unchanged" and skip.
 */
export function anterioresComDesauditado(
  row: LinhaDeFamilia,
  depositoId: string,
  movimentos: MovimentosDaJanela,
  changedSinceMs: number,
): Map<string, number> {
  const anteriores = quantidadesAnterioresShopee(row, depositoId, movimentos);
  for (const member of [row.anchor, ...row.children]) {
    if (estoqueDesauditado(member, depositoId, movimentos, changedSinceMs)) {
      anteriores.delete(member.produtoId);
    }
  }
  return anteriores;
}

/* -------------------------------------------------------------------------- */
/*                            THE TASK AND THE SKIP                           */
/* -------------------------------------------------------------------------- */

/** One `stock_list` row, as the task carries it. */
export interface ModeloDaTarefaShopee {
  /**
   * ⚠️ `0` is LEGAL and means "this listing has no variations". Never fold it
   * to null and never test it for truthiness — a `if (modelId)` anywhere between
   * here and the wire turns the simple-item write into a structure error.
   */
  readonly modelId: number;
  /** The ERP produto owning this model's stock — the CHILD, or the anchor at `modelId: 0`. */
  readonly produtoId: string;
  /** The `variashopee` document id, for the per-model diagnostic. Null at `modelId: 0`. */
  readonly varLinkDocId: string | null;
  /** Computed at SWEEP time and **UNCLAMPED** by the category band. The sender clamps. */
  readonly quantidade: number;
}

/**
 * One Cloud Task: ONE `update_stock` call against ONE listing.
 *
 * ⚠️ The field set is the frozen payload (§2.8) and the sender's zod schema is
 * `.strict()`, so an added field here is a `payload-invalido` drop at the other
 * end rather than a compile error. Change both, together, or neither.
 */
export interface TarefaDeEstoqueShopee {
  readonly integracaoId: string;
  /** The family ANCHOR — the produto that owns the `prodshopee` link. */
  readonly produtoId: string;
  /** The `prodshopee` document id — the write-back target, never re-resolved. */
  readonly linkDocId: string;
  /** ⚠️ A NUMBER. A stringified id matches nothing, silently. */
  readonly itemId: number;
  /** For the band lookup at send time; `null` ⇒ the sender skips the clamp. */
  readonly categoryId: number | null;
  readonly sweepId: string;
  /** MILLISECONDS — when the sweep computed these quantities. */
  readonly sweepComputadoEmMs: number;
  /** Always `0` at plan time; only the sender's pause re-enqueue raises it. */
  readonly reenfileiramentos: number;
  /** 1-based. `1` unless a drifted listing had to be split. */
  readonly parte: number;
  readonly totalDePartes: number;
  /** ONE array, never "a quantity XOR a list" — this wire has a single body. */
  readonly modelos: readonly ModeloDaTarefaShopee[];
}

/** One observable line for something this plan will NOT send. */
export interface PuloDeEstoque {
  /** The produto the line is ABOUT — the anchor, or the child at a per-model line. */
  readonly produtoId: string;
  readonly linkDocId: string | null;
  readonly itemId: number | null;
  /** The model this line is about, or `null` when the line is listing-level. */
  readonly modelId: number | null;
  /**
   * How many of the listing's models this line is about.
   *
   * Set only where the NUMBER is the finding — both flavours of
   * `task-excede-limite`: a listing that drifted past the per-call cap and had
   * to be split, and a chunk whose encoded body outgrew the task budget and was
   * dropped. `null` everywhere else, including the per-model lines, where
   * {@link modelId} already names the one model.
   */
  readonly modelosAfetados: number | null;
  readonly motivo: MotivoEstoqueShopee;
  /**
   * The operator-facing sentence, rendered HERE by lookup.
   *
   * ⚠️ Never re-derived downstream and never decorated: `MENSAGEM_POR_MOTIVO` is
   * total over the vocabulary, so a surface that re-words a slug is a second
   * copy of the wording, free to drift from this one.
   */
  readonly mensagem: string;
}

/** What {@link montarTarefasDeEstoqueShopee} needs beyond the family and the quantities. */
export interface OpcoesDeMontagem {
  readonly integracaoId: string;
  readonly sweepId: string;
  /** MILLISECONDS — when the quantities were computed. Travels on every task. */
  readonly sweepComputadoEmMs: number;
  /** MILLISECONDS — the tick's logical instant, threaded into the per-link gate. */
  readonly nowMs: number;
  /** The route's and the CLI's `reenviarComErro`. Bypasses the gate's skip set only. */
  readonly ignorarRecusa?: boolean;
}

/** The plan for ONE family. */
export interface ResultadoDoPlanoShopee {
  readonly tarefas: TarefaDeEstoqueShopee[];
  readonly pulos: PuloDeEstoque[];
}

/* -------------------------------------------------------------------------- */
/*                              SMALL TOTAL READERS                           */
/* -------------------------------------------------------------------------- */

/** A non-empty string, or null. */
function textoNaoVazio(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

/**
 * A positive INTEGER, or null.
 *
 * ⚠️ Stricter than the publish side's finite check on purpose: the task payload
 * declares `z.number().int().positive()`, so a fractional id would pass a
 * finite test here and be dropped as `payload-invalido` at the far end, with no
 * line naming the listing.
 */
function inteiroPositivo(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isInteger(bruto) && bruto > 0 ? bruto : null;
}

/**
 * The document id a stored ref names — both encodings, or null.
 *
 * See folds (1) and (2) in the module header for what this treats as equal and
 * what it keeps distinct.
 */
function idDoRef(bruto: unknown): string | null {
  const bruta = textoNaoVazio(bruto);
  if (bruta == null) return null;
  return textoNaoVazio(idFromRef(bruta));
}

/* -------------------------------------------------------------------------- */
/*                            THE COMPLETENESS GUARD                          */
/* -------------------------------------------------------------------------- */

/**
 * **Every usable model is either planned or explained.**
 *
 * Throws when it is not. A thrown `Error` is the right shape here: a mismatch
 * can only be a defect in this file's own bookkeeping — no document, no wire
 * response and no operator input can cause it, and there is no degraded plan
 * worth enqueuing once a model has gone missing without a line.
 *
 * Exported so the property can be tested directly on numbers, rather than only
 * through fixtures that happen to satisfy it.
 */
export function conferirCompletudeDoAnuncio(ctx: {
  readonly linkDocId: string;
  readonly itemId: number;
  /** Usable models on the listing — or `1` for a no-model listing's single write. */
  readonly usaveis: number;
  /** Models placed in a task. */
  readonly planejados: number;
  /** Models a skip line accounts for — no quantity, or a chunk dropped over budget. */
  readonly pulados: number;
}): void {
  if (ctx.planejados + ctx.pulados === ctx.usaveis) return;
  throw new Error(
    '[shopee/estoque] plano incompleto: ' +
      `${ctx.planejados} planejados + ${ctx.pulados} pulados != ${ctx.usaveis} utilizáveis ` +
      `(anúncio ${ctx.itemId}, vínculo ${ctx.linkDocId})`,
  );
}

/** How many models this plan will actually write. The sweep's log line. */
export function contarModelosPlanejados(resultado: ResultadoDoPlanoShopee): number {
  return resultado.tarefas.reduce((total, tarefa) => total + tarefa.modelos.length, 0);
}

/* -------------------------------------------------------------------------- */
/*                                 THE PLANNER                                */
/* -------------------------------------------------------------------------- */

/** One attributed `variashopee`, reduced to what the planner addresses. */
interface ModeloCandidato {
  readonly modelId: number;
  readonly produtoId: string;
  readonly varLinkDocId: string | null;
}

/**
 * Every `variashopee` of the family that names THIS listing — before any
 * filtering, because "no rows at all" and "rows that were all dropped" are
 * different listings and get different lines.
 */
function varLinksDoAnuncio(
  children: readonly FilhoDaFamilia[],
  linkDocId: string,
): { readonly filho: FilhoDaFamilia; readonly varLink: VarLinkShopeeCru }[] {
  const saida: { filho: FilhoDaFamilia; varLink: VarLinkShopeeCru }[] = [];
  for (const filho of children) {
    for (const varLink of filho.varLinks) {
      if (idDoRef(varLink.produtoShopeeOuterRef) === linkDocId) saida.push({ filho, varLink });
    }
  }
  return saida;
}

/**
 * The attributed rows this planner can address, in discovery order.
 *
 * Order of operations, and it is load-bearing:
 * 1. a row marked absent by a model-list read is dropped **FIRST**, before the
 *    cut — keeping it would let a dead model push a live one past the per-call
 *    cap (M-49);
 * 2. a row whose `model_id` folds to "no usable model" is dropped;
 * 3. duplicates by `modelId` collapse to the first — `stock_list` is keyed by
 *    `model_id` and a repeat would be the same model written twice in one call.
 */
function modelosUtilizaveis(
  atribuidos: readonly { readonly filho: FilhoDaFamilia; readonly varLink: VarLinkShopeeCru }[],
): ModeloCandidato[] {
  const vistos = new Set<number>();
  const saida: ModeloCandidato[] = [];
  for (const { filho, varLink } of atribuidos) {
    // ⚠️ Any non-null reading drops the row. The field is stamped when a model
    // list stopped reporting the model, and the mark is never cleared by
    // deletion — so a junk value still means "somebody marked this gone".
    if (varLink.modeloAusenteEm != null) continue;
    const modelId = inteiroPositivo(varLink.model_id);
    if (modelId == null) continue;
    if (vistos.has(modelId)) continue;
    vistos.add(modelId);
    saida.push({
      modelId,
      produtoId: filho.produtoId,
      varLinkDocId: textoNaoVazio(varLink.varLinkDocId),
    });
  }
  return saida;
}

/**
 * **The planner.** One family ⇒ the tasks to enqueue and the lines to record.
 *
 * One task per listing per chunk; one listing's refusal never touches another's
 * (the per-listing `continue` is the whole shape). Links belonging to ANOTHER
 * conta are ignored in SILENCE — they are not this sweep's business and a line
 * for them would be noise on every tick for every multi-conta produto.
 */
export function montarTarefasDeEstoqueShopee(
  row: LinhaDeFamiliaShopee,
  quantidades: ReadonlyMap<string, number>,
  opts: OpcoesDeMontagem,
): ResultadoDoPlanoShopee {
  const tarefas: TarefaDeEstoqueShopee[] = [];
  const pulos: PuloDeEstoque[] = [];
  const { anchorId } = row;

  const pular = (
    motivo: MotivoEstoqueShopee,
    alvo: {
      produtoId?: string;
      linkDocId?: string | null;
      itemId?: number | null;
      modelId?: number | null;
      modelosAfetados?: number | null;
    } = {},
  ): void => {
    pulos.push({
      produtoId: alvo.produtoId ?? anchorId,
      linkDocId: alvo.linkDocId ?? null,
      itemId: alvo.itemId ?? null,
      modelId: alvo.modelId ?? null,
      modelosAfetados: alvo.modelosAfetados ?? null,
      motivo,
      mensagem: MENSAGEM_POR_MOTIVO[motivo],
    });
  };

  // DEFENSIVE on the sweep path (the discovery query already filters the conta
  // server-side) and LOAD-BEARING on the manual one (the by-ids read carries no
  // conta term at all). It also catches the produto whose conta denorm a trigger
  // has not caught up with, in the safe direction.
  if (!row.integracoesComProduto.includes(opts.integracaoId)) {
    pular(MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto);
    return { tarefas, pulos };
  }

  const daConta = row.links.filter(
    (link) => idDoRef(link.contaProdutoShopeeOuterRef) === opts.integracaoId,
  );
  if (daConta.length === 0) {
    pular(MOTIVO_ESTOQUE_SHOPEE.semLink);
    return { tarefas, pulos };
  }

  for (const link of daConta) {
    const linkDocId = textoNaoVazio(link.linkDocId);
    if (linkDocId == null) {
      // Defensive: the projection supplies the document id, so an absent one is
      // drift in the query rather than in the corpus.
      pular(MOTIVO_ESTOQUE_SHOPEE.semLink);
      continue;
    }

    const itemId = inteiroPositivo(link.item_id);
    const veredito = podeEnviarEstoqueShopee(link, row.anchor, {
      nowMs: opts.nowMs,
      ...(opts.ignorarRecusa === undefined ? {} : { ignorarRecusa: opts.ignorarRecusa }),
    });
    if (!veredito.enviar) {
      pular(veredito.motivo, { linkDocId, itemId });
      continue;
    }
    if (itemId == null) {
      // The gate's first rung already refuses an absent or non-positive id, so
      // only a FRACTIONAL one reaches here — and the payload schema would drop
      // it namelessly at the far end. Refused with the same slug the gate uses.
      pular(MOTIVO_ESTOQUE_SHOPEE.semItemId, { linkDocId });
      continue;
    }

    const categoryId = inteiroPositivo(link.category_id);
    const atribuidos = varLinksDoAnuncio(row.children, linkDocId);

    const modelos: ModeloDaTarefaShopee[] = [];
    let usaveis: number;
    let pulados = 0;

    if (atribuidos.length === 0) {
      // A NO-MODEL listing: one write, `model_id: 0`, carrying the ANCHOR's
      // quantity. Its single unit is the whole universe for the invariant.
      usaveis = 1;
      const quantidade = quantidades.get(anchorId);
      if (quantidade === undefined) {
        pular(MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade, {
          produtoId: anchorId,
          linkDocId,
          itemId,
          modelId: 0,
        });
        pulados = 1;
      } else {
        modelos.push({ modelId: 0, produtoId: anchorId, varLinkDocId: null, quantidade });
      }
    } else {
      const candidatos = modelosUtilizaveis(atribuidos);
      usaveis = candidatos.length;
      if (usaveis === 0) {
        // Rows exist but none is addressable — every one was marked absent or
        // carries no usable id. A different fact from "this listing has no
        // variations", and it gets its own slug.
        pular(MOTIVO_ESTOQUE_SHOPEE.semModelos, { linkDocId, itemId });
      }
      for (const candidato of candidatos) {
        const quantidade = quantidades.get(candidato.produtoId);
        if (quantidade === undefined) {
          pular(MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade, {
            produtoId: candidato.produtoId,
            linkDocId,
            itemId,
            modelId: candidato.modelId,
          });
          pulados += 1;
          continue;
        }
        modelos.push({ ...candidato, quantidade });
      }
    }

    let planejados = 0;
    if (modelos.length > 0) {
      const totalDePartes = Math.ceil(modelos.length / MAX_MODELOS_POR_TASK);
      if (totalDePartes > 1) {
        // Observability only — the listing IS still sent, in parts. ⚠️ A split
        // listing's parts are NOT atomic at Shopee, which is why the fact is
        // recorded rather than left in a log line nobody reads.
        pular(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite, {
          linkDocId,
          itemId,
          modelosAfetados: modelos.length,
        });
      }
      for (let indice = 0; indice < totalDePartes; indice += 1) {
        const fatia = modelos.slice(
          indice * MAX_MODELOS_POR_TASK,
          (indice + 1) * MAX_MODELOS_POR_TASK,
        );
        const tarefa: TarefaDeEstoqueShopee = {
          integracaoId: opts.integracaoId,
          produtoId: anchorId,
          linkDocId,
          itemId,
          categoryId,
          sweepId: opts.sweepId,
          sweepComputadoEmMs: opts.sweepComputadoEmMs,
          reenfileiramentos: 0,
          parte: indice + 1,
          totalDePartes,
          modelos: fatia,
        };
        const bytes = stockTaskEncodedBodyBytes(tarefa);
        const detalhes = {
          integracaoId: opts.integracaoId,
          produtoId: anchorId,
          itemId,
          linkDocId,
          modelos: fatia.length,
          bytes,
          orcamento: STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
        };
        if (bytes > STOCK_TASK_ENCODED_BODY_BUDGET_BYTES) {
          // The enqueue would be REJECTED, so the whole part would be lost
          // silently. Drop it here instead, where it gets a line naming the
          // listing and the count.
          console.error('[shopee/estoque] tarefa excede o orçamento de corpo', detalhes);
          pular(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite, {
            linkDocId,
            itemId,
            modelosAfetados: fatia.length,
          });
          pulados += fatia.length;
          continue;
        }
        if (bytes >= STOCK_TASK_ENCODED_BODY_WARN_BYTES) {
          console.warn('[shopee/estoque] tarefa próxima do orçamento de corpo', detalhes);
        }
        tarefas.push(tarefa);
        planejados += fatia.length;
      }
    }

    conferirCompletudeDoAnuncio({ linkDocId, itemId, usaveis, planejados, pulados });
  }

  return { tarefas, pulos };
}

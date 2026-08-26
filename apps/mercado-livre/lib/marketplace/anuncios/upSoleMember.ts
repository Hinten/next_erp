/**
 * The User-Products SOLE MEMBER (#1087) — the pure half.
 *
 * ML auto-generates a family for EVERY user product (docs: *"Família: é autogerada
 * com base nas informações dos produtos"*, *"cada UP está relacionado a uma família
 * (family_id)"*), so a "UP single" is really a family of exactly one. The IMPORTER
 * has always written it that way — parent produto + one child, stock on the child —
 * while PUBLISH wrote a root produto with no children. The two sides disagreed for
 * exactly this case, so a produto published from the ERP did not survive
 * delete → re-import: it came back a different shape, with a different sku and a
 * different `link.id`.
 *
 * This module builds the child the importer would have built, so publish converges
 * on that one shape. It is deliberately PURE — no Firestore, no clock, no ML — so
 * both callers can share it: `publish.ts` (a produto about to go out) and the
 * one-time `tools/migrations` script (the produtos already on disk). One planner is
 * the only thing that keeps those two from drifting apart.
 *
 * ---- The two repairable cases (see `classificarMembroUnico` in `publishCore.ts`)
 *
 *  - **criar** — never published. There is no ML item yet, so the child id is
 *    derived from the produto alone; the fan-out POSTs and `writeMemberLink` stamps
 *    the real item id afterwards.
 *  - **adotar** — already published under the OLD convention, so `link.id` is a real
 *    item id. ⛔ The child MUST carry that item id on its member link BEFORE the
 *    fan-out runs. Without it `publish.ts`'s `findVariacaoLink` returns null, the
 *    member is treated as new, `api.createItem` POSTs a SECOND item, and
 *    `sweepRemovedMembers` then confirms the ORIGINAL as an orphan and
 *    pauses-then-closes it — a live listing, its sales history and its search
 *    ranking, destroyed. Adoption is what makes the fan-out a PUT.
 *
 * ---- Why the child id is what it is
 *
 * `importVariations.ts:137-138` mints a UP member at
 * `XMLB000000000000000<parentLinkDocId>vMLB<itemId>` for BOTH the produto and the
 * link doc. Reusing that string verbatim in the adoption case is what makes a later
 * import land on the SAME documents instead of minting a duplicate child. In the
 * creation case there is no item id yet, so the id is derived from the produto;
 * convergence still holds one step later, because `resolveExistingChild` matches a
 * member by `itemId` first (rule 1) and by `sku` + `paiId` second (rule 2), and this
 * child satisfies both once published.
 */
import { createHash } from 'node:crypto';

import { type MlModeracao, makeEstoqueUid, reservaEfetiva, toOuterRef } from '@delfrance/schemas';

/** Mirrors `importCore.ts`'s own cap on the child `nome`. */
const PRODUTO_NOME_MAX = 100;

/** One depósito row of the PARENT, as read before the move. */
export interface MembroUnicoEstoque {
  /**
   * The row's ACTUAL Firestore document id.
   *
   * ⚠️ Not derivable. `makeEstoqueUid` is what THIS app writes, but the migrated
   * corpus also holds rows at auto-ids that are matched by `depositoOuterRef`
   * instead — so re-deriving the id here would patch a document that does not
   * exist and leave the real row untouched, silently doubling the stock.
   */
  docId: string;
  depositoId: string;
  /** The parent row's stored quantity (gross — it still includes any reserve). */
  quantidade: number;
  /** Raw stored value; run through `reservaEfetiva` before use (#931). */
  quantidadeReservada: unknown;
}

export interface PlanejarMembroUnicoArgs {
  /** `criar` (never published) or `adotar` (published under the old convention). */
  acao: 'criar' | 'adotar';
  /** The FAMILY parent produto that is gaining its sole member. */
  produtoId: string;
  parentLinkDocId: string;
  integracaoId: string;
  /** Parent produto fields the child mirrors. */
  produto: {
    nome: string;
    sku: string | null;
    ehKit: boolean;
    ehUsado: boolean;
    precos: unknown;
    pesoLiquidoKg: unknown;
    pesoBrutoKg: unknown;
    alturaCm: unknown;
    larguraCm: unknown;
    profundidadeCm: unknown;
    categoriaProdutoOuterRef: unknown;
  };
  /** The parent `produtoMercadoLivre` link, as stored. */
  link: {
    /** `null` when creating; the ML item id (`MLB…`) when adopting. */
    id: string | null;
    status: string | null;
    sub_status: string[] | null;
    userProductId: string | null;
    moderacoes: MlModeracao[] | null;
  };
  estoques: readonly MembroUnicoEstoque[];
  now: number;
}

export interface MembroUnicoPlano {
  childProdutoId: string;
  childLinkDocId: string;
  /** The child produto document, written whole. */
  produto: Record<string, unknown>;
  /** The child `variacaoMercadoLivre` link document. */
  link: Record<string, unknown>;
  /** Child estoque rows to create — one per depósito the parent held. */
  estoques: ReadonlyArray<{ docId: string; data: Record<string, unknown> }>;
  /**
   * What the parent's rows are left holding — the RESERVED units, and never a
   * delete.
   *
   * ⚠️ `onEstoqueDeleted` cascades into the row's whole `historicoEstoque`
   * subcollection, so deleting here would destroy the produto's stock audit trail
   * to save one document. Rewriting the quantity keeps the ledger AND keeps the
   * row an open pedido's release still needs.
   */
  parentEstoqueRestos: ReadonlyArray<{ docId: string; data: Record<string, unknown> }>;
  /**
   * Patch for the parent link. Under a family the `user_product_id` belongs to the
   * MEMBER (#706/#1142) — `publish.ts` and `importCore.ts` both write `null` here
   * once children exist, and leaving a stale one is "one member speaking for the
   * whole family".
   */
  parentLinkPatch: Record<string, unknown>;
}

export type MembroUnicoResultado =
  | { ok: true; plano: MembroUnicoPlano }
  | { ok: false; recusas: string[] };

/**
 * The child produto / link doc id.
 *
 * Adoption reuses the importer's own fixed-width string verbatim so a later import
 * converges onto the SAME documents (`importVariations.ts:137-138`). Creation has no
 * item id to build it from, so it derives one from the produto — stable across
 * retries, which is all it has to be.
 */
export function membroUnicoChildId(
  acao: 'criar' | 'adotar',
  produtoId: string,
  parentLinkDocId: string,
  itemId: string | null,
): string {
  if (acao === 'adotar' && itemId != null && itemId !== '') {
    return `XMLB000000000000000${parentLinkDocId}vMLB${itemId}`;
  }
  return createHash('sha256').update(`${produtoId}|up-sole-member`).digest('hex');
}

/**
 * Plan the sole member, or refuse with reasons. Pure.
 *
 * ⚠️ The one refusal that is not a validation nicety: a depósito holding a RESERVE.
 * An open pedido's reservation is keyed on the pedido line's produtoId, which names
 * the PARENT, so moving the row out from under it strands the release — the later
 * decrement lands on a document whose quantity we changed, and the difference is an
 * oversell nobody sees. Refusing whole (never half) is safe because both callers are
 * re-runnable: the produto is picked up on a later pass once the pedido closes.
 */
export function planejarMembroUnico(args: PlanejarMembroUnicoArgs): MembroUnicoResultado {
  const recusas: string[] = [];

  if (args.acao === 'adotar' && (args.link.id == null || args.link.id === '')) {
    recusas.push('adoção pedida sem um anúncio para adotar (o vínculo não tem id)');
  }

  if (recusas.length > 0) return { ok: false, recusas };

  const childId = membroUnicoChildId(args.acao, args.produtoId, args.parentLinkDocId, args.link.id);
  const now = args.now;

  // The child mirrors the parent. A UP single has an EMPTY `attribute_combinations`
  // on ML, so the importer's `[family_name, ...valueNames].join(' ')` degenerates to
  // the family name — which is the parent's own nome. The same fact gives it no
  // variation taxonomy at all: `resolveVariationCombo([], [])` returns `{null, null}`.
  const produto: Record<string, unknown> = {
    nome: args.produto.nome.slice(0, PRODUTO_NOME_MAX),
    sku: args.produto.sku,
    paiId: args.produtoId,
    publicado: true,
    ehKit: args.produto.ehKit,
    ehUsado: args.produto.ehUsado,
    precos: args.produto.precos ?? null,
    grupoDeVariacoesUid: null,
    variacoesUid: null,
    pesoLiquidoKg: args.produto.pesoLiquidoKg ?? null,
    pesoBrutoKg: args.produto.pesoBrutoKg ?? null,
    alturaCm: args.produto.alturaCm ?? null,
    larguraCm: args.produto.larguraCm ?? null,
    profundidadeCm: args.produto.profundidadeCm ?? null,
    categoriaProdutoOuterRef: args.produto.categoriaProdutoOuterRef ?? null,
    timestamp: now,
    // ⚠️ Load-bearing, not decoration: `produtoMeta.defaultQuery` sorts on this, and a
    // document missing the sort key is invisible to `orderBy` (#159/#861).
    ultimaModificacao: now,
  };

  // The member link. Every field here is the one `assembleVariationChildPlan` writes
  // for a UP member (`importCore.ts:684-742`) — this is the convergence contract.
  const link: Record<string, unknown> = {
    // ⚠️ Stays null. The numeric `id` is the LEGACY `variations[]` variation id; a UP
    // member has none, and inventing one would make `variacaoLinkHasListing` report a
    // legacy variation that does not exist.
    id: null,
    // ⛔ The whole point of adoption: carrying the existing item id here is what makes
    // the fan-out PUT instead of POST. See the module docblock.
    itemId: args.acao === 'adotar' ? args.link.id : null,
    userProductId: args.link.userProductId,
    produtoVariacaoOuterRef: toOuterRef(`produtos/${childId}`),
    produtoMercadoLivreOuterRef: toOuterRef(
      `produtos/${args.produtoId}/produtoMercadoLivre/${args.parentLinkDocId}`,
    ),
    contaOuterRef: toOuterRef(`integracao/${args.integracaoId}`),
    sku: args.produto.sku,
    // Seeded from the parent so the family has a member observation IMMEDIATELY.
    // Without it `foldFamilyStatus` has nothing to fold and the family stays
    // un-concludable until an `items` webhook that, for a listing nobody touches, may
    // never arrive.
    status: args.link.status,
    sub_status: args.link.sub_status,
    // Physically adjacent to the status, because the invariant is that ML's reason and
    // the state it explains move in ONE patch.
    moderacoes: args.link.moderacoes,
    // Empty: a sole member has no combination. Same value the importer writes.
    attributes: [],
  };

  // ⚠️ Only the AVAILABLE units move; the reserved ones stay on the parent.
  //
  // An open pedido's reservation is keyed on the produto its LINE names — the
  // parent — so the eventual release decrements the parent's row. Move the reserve
  // with the rest and that release lands on a document we emptied, while the child
  // keeps a phantom reserve for ever: the produto then under-reports its stock
  // permanently, with nothing to signal it. Leaving exactly `reservaEfetiva` behind
  // makes the parent's available quantity zero (so the sweep still sends the
  // child's number, which is the whole point) while the ledger the release needs is
  // still there and still correct.
  //
  // The residual, stated because it is real: once that pedido ships, those units sit
  // on the parent and someone has to move them to the child. They are visible in the
  // Balanço rather than lost, and this is the only tier that neither blocks a
  // publish nor oversells.
  const disponivelDe = (e: MembroUnicoEstoque) =>
    Math.max(
      0,
      e.quantidade -
        reservaEfetiva(typeof e.quantidadeReservada === 'number' ? e.quantidadeReservada : null),
    );

  const estoques = args.estoques.map((e) => ({
    docId: makeEstoqueUid(childId, e.depositoId),
    data: {
      parentId: childId,
      depositoOuterRef: toOuterRef(`depositos/${e.depositoId}`),
      quantidade: disponivelDe(e),
      dataCriacao: now,
      ultimaModificacao: now,
    } as Record<string, unknown>,
  }));

  const parentEstoqueRestos = args.estoques.map((e) => ({
    // The row's own id, never a derived one — see `MembroUnicoEstoque.docId`.
    docId: e.docId,
    data: {
      quantidade: e.quantidade - disponivelDe(e),
      ultimaModificacao: now,
    } as Record<string, unknown>,
  }));

  return {
    ok: true,
    plano: {
      childProdutoId: childId,
      childLinkDocId: childId,
      produto,
      link,
      estoques,
      parentEstoqueRestos,
      parentLinkPatch: { userProductId: null, ultimaModificacao: now },
    },
  };
}

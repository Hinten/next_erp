/**
 * Family identity — pure, total, no database.
 *
 * `produtos` is a FLAT collection: a variation child is an ordinary produto
 * document carrying `paiId`, not a subcollection. So "these two documents are
 * one produto" is a question that has to be asked of the documents themselves,
 * and this module is the one place that answers it.
 *
 * It lives here rather than in `apps/web` because `apps/web` has no dependency
 * edge to any `apps/*` and none is possible — a rule needed on both a browser
 * surface and a server one has exactly two options, share it or write it twice
 * (root `CLAUDE.md`). `precisaConsultarModeracao` (#1239) and `clienteIdentity.ts`
 * (#786) made the same move for the same reason.
 */

/** The two fields a SKU probe has to project for {@link colapsarPaiEFilhoUnico}. */
export interface CandidatoDeFamilia {
  id: string;
  /** `null` on a parent; the parent's doc id on a variation child. */
  paiId: string | null | undefined;
}

/**
 * Given the produtos a SKU probe returned, collapse **a parent and the only
 * member sharing that SKU** into the single produto that actually holds the
 * stock — the child. Returns `null` when they are genuinely distinct produtos.
 *
 * ⚠️ Read that scope literally: "the only member sharing this SKU", not "the
 * only member". A child's SKU is derived as `parentSku + variante.codigo`
 * (`variacoes.ts:172`), so a variant whose `codigo` is null or empty gets
 * EXACTLY the parent's SKU. In a family of many where exactly one variant is
 * `codigo`-less, the probe returns two documents — parent + that one child —
 * and this collapses them even though the family has other members.
 *
 * That outcome is correct, which is why the code does not guard against it: the
 * child is the only produto whose SKU is literally the scanned string, and it is
 * where the stock lives, so binding it beats reporting a duplicate. But the
 * function decides the narrower thing, and saying the wider one would be a
 * comment asserting behaviour the code does not have.
 *
 * ## Why this is needed at all
 *
 * A sole member copies its parent's SKU verbatim
 * (`upSoleMember.ts:193,233` — and the importer writes the same shape), so a
 * produto with no variations legitimately puts **two documents behind one SKU**.
 * Every unscoped `where('sku','==',x)` probe then reads that as two produtos:
 * the Balanço scan answers "SKU duplicado" and the Mercado Livre order resolver
 * answers `ambiguous-sku`, both about a produto that has exactly one SKU.
 *
 * The child is the answer, not the parent: after #1398 the parent holds no
 * available stock, and it already holds none today for anything publish has
 * converted (`upSoleMemberWrite.ts` moves the available units to the child).
 *
 * ## What must stay distinct — the near-misses this is scoped against
 *
 * ⚠️ **Two unrelated roots sharing a SKU.** Legal in this corpus and a genuine
 * ambiguity; both have `paiId == null`, so neither can be the other's child.
 *
 * ⚠️ **Two siblings sharing a SKU.** Also legal, and common: a child's SKU is
 * derived as `parentSku + variante.codigo`, so two variantes without a `codigo`
 * collide (`importVariations.ts:352-355`). Both carry the same `paiId`, and
 * neither IS that parent, so this is not a family-of-one.
 *
 * ⚠️ **A parent and some other parent's child.** The child's `paiId` names a
 * third document that is not in the pair.
 *
 * ⚠️ **A parent and one of its children when MORE THAN ONE of them shares the
 * SKU.** This function cannot see that from two documents, which is why every
 * caller probes with `limit(3)` rather than `limit(2)`: three hits mean the pair
 * is not the whole story and nothing is collapsed. A `limit(2)` caller would
 * silently collapse a parent + an arbitrary one of several same-SKU children and
 * bind stock to whichever the index happened to return.
 */
export function colapsarPaiEFilhoUnico<T extends CandidatoDeFamilia>(
  candidatos: readonly T[],
): T | null {
  if (candidatos.length !== 2) return null;
  const [a, b] = candidatos as readonly [T, T];

  const paiDe = (pai: T, filho: T): T | null => {
    // A parent has no `paiId`; the child's must name THIS parent, not another.
    // `== null` covers both an absent key and a stored null — the schema
    // defaults it to null and the legacy corpus writes it explicitly.
    if (pai.paiId != null) return null;
    if (filho.paiId !== pai.id) return null;
    // A document cannot be its own parent, and an empty id would make the
    // comparison above vacuous.
    if (pai.id === '' || filho.id === '' || pai.id === filho.id) return null;
    return filho;
  };

  return paiDe(a, b) ?? paiDe(b, a);
}

/* -------------------------------------------------------------------------- */
/*                    filhoUnicoId — deriving it, and reading it              */
/* -------------------------------------------------------------------------- */

/**
 * The value `produto.filhoUnicoId` must hold, given the produto's FULL child
 * set: the single child's id when there is exactly one, `null` otherwise.
 *
 * ⚠️ **Every writer that changes a produto's child set calls this, in the SAME
 * batch as the change.** `filhoUnicoId` is a denormalisation, and a family of
 * three still naming child #1 sends every reader to the wrong produto — it
 * would attribute the parent's stock to one arbitrary variation. There is no
 * trigger keeping it honest on purpose (root `CLAUDE.md` rejects
 * derived-state-kept-by-trigger; #869 worked that trade), so the discipline is
 * that this function is the only producer of the value.
 *
 * ⚠️ It takes the FULL set, never a delta. Passing "the children I just added"
 * yields a confident wrong answer instead of a visible error.
 */
export function derivarFilhoUnico(filhos: readonly { id: string }[]): string | null {
  if (filhos.length !== 1) return null;
  const id = filhos[0]!.id;
  return id === '' ? null : id;
}

/** What {@link unidadeVendavel} and {@link ehFamiliaDeUm} read off a produto. */
export interface ProdutoDeFamilia {
  id: string;
  /**
   * Optional, and the reason it is read is drift.
   *
   * `filhoUnicoId` is a denormalisation with no trigger keeping it honest;
   * `paiId` is authoritative by construction, because a child always carries
   * one. So consulting it turns the drift case "a child that wrongly kept a
   * stale `filhoUnicoId`" from *resolves to some other produto* into *resolves
   * to itself*, which is the safe answer for a stock read.
   *
   * A caller that does not project it gets `undefined == null` → exactly the
   * behaviour it would have had; only callers that DO project it gain the guard.
   */
  paiId?: string | null;
  filhoUnicoId?: string | null;
}

/**
 * Whether this produto is the PARENT of a family of one — i.e. a wrapper whose
 * sellable unit is somewhere else.
 *
 * False for a child, for a childless produto, and for a family of many. Note
 * the last two are false for opposite reasons and both are correct: a childless
 * legacy produto still owns its own stock, and a family of many has no single
 * unit to point at.
 */
export function ehFamiliaDeUm(produto: ProdutoDeFamilia): boolean {
  // ⚠️ A child is never the parent of a family of one, whatever it stores. This
  // reads the authoritative field to guard the denormalised one — see `paiId`
  // on {@link ProdutoDeFamilia}. `== null` covers a stored null and an absent
  // key alike, so a caller that does not project `paiId` is unaffected.
  if (produto.paiId != null) return false;
  return produto.filhoUnicoId != null && produto.filhoUnicoId !== '';
}

/**
 * The produto id that owns this produto's **available** stock.
 *
 * Tolerates BOTH shapes, which is what lets every read surface adopt it before
 * a single writer changes: a parent of a family of one resolves to its child;
 * everything else — a child, a childless legacy produto, a family of many —
 * resolves to ITSELF, exactly as today.
 *
 * ⚠️ **Available, not total.** A parent of a family of one can still hold a
 * RESERVED remainder: a reservation is keyed on the produto the pedido *line*
 * names, so the release has to find that row where it left it
 * (`upSoleMember.ts:243-257`). A surface showing what is on hand, or letting an
 * operator move stranded units, must therefore still look at the parent — see
 * `EstoqueManager`'s `residualEstoquePai`. This answers the availability
 * question only.
 */
export function unidadeVendavel(produto: ProdutoDeFamilia): string {
  return ehFamiliaDeUm(produto) ? produto.filhoUnicoId! : produto.id;
}

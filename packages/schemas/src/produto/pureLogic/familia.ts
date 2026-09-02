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

/* -------------------------------------------------------------------------- */
/*                       Minting the sole member's document                   */
/* -------------------------------------------------------------------------- */

/** The parent fields a sole member mirrors. Everything else is a schema default. */
export interface ParentParaMembroUnico {
  nome?: string | null;
  sku?: string | null;
  codPai?: string | null;
  gtin?: string | null;
  publicado?: boolean | null;
  ehKit?: boolean | null;
  ehKitVirtual?: boolean | null;
  ehUsado?: boolean | null;
  componentesKit?: Record<string, unknown> | null;
  precos?: Record<string, unknown> | null;
  categoriaProdutoOuterRef?: string | null;
  pesoLiquidoKg?: number | null;
  pesoBrutoKg?: number | null;
  alturaCm?: number | null;
  larguraCm?: number | null;
  profundidadeCm?: number | null;
}

/** Flutter caps a produto name at 100 (`produto.ts:45`); a child's must fit too. */
const PRODUTO_NOME_MAX = 100;

/**
 * The sole member's produto document, mirrored from its parent.
 *
 * ⚠️ It is a MIRROR, not a stub. The child is the sellable unit after #1398, so
 * anything a stock or pricing surface reads off "the produto" has to be on it:
 * `precos` (the pedido line reprices from the produto it names), the five
 * dimensions (freight quoting), `categoriaProdutoOuterRef` (the NF-e tax
 * cascade's tier 3 — a child without it falls through to the operação default),
 * and the kit fields.
 *
 * ⚠️ **`componentesKit` is copied, and it has to be.** A kit's availability is
 * `min` over its components, computed from the produto a surface reads — which
 * for a family of one is the child. A child carrying `ehKit: false` and no map
 * would report its own (empty) stock, so every kit would read 0: the harm #1398
 * was opened on, from a third direction. Kit-variation children already carry
 * their own map, written by "Gerar Variações" (`buildChildrenComponentesKitOps`),
 * so this matches the shape the repo already has.
 *
 * ⚠️ `variacoesUid`/`grupoDeVariacoesUid` stay NULL — a sole member has no
 * variation taxonomy, which is exactly what `resolveVariationCombo([], [])`
 * yields and what both the ML publish and import paths write.
 *
 * ⚠️ `ordem` stays null and `filhoUnicoId` is absent: a child never points at a
 * child, and nothing orders a family of one.
 */
/**
 * The four kit fields a sole member mirrors — **one unit, never four**.
 *
 * ⚠️ They are not independent. `componentesKitKeys` is DERIVED from
 * `componentesKit`, and `ehKit` gates both: `onProdutoDeleted.ts:75` states the
 * invariant outright, that the pair is *"rewritten together (never one without
 * the other)"*. A writer that decides them separately can leave a member whose
 * flag says kit while its map is null, or whose keys array names a component the
 * map does not hold — and `calcularAlteracoesEstoque` reads exactly that
 * combination as "kit with no components", so the sale moves **nothing**.
 *
 * Every place that mirrors the group goes through here, so the definition of
 * "the kit group" exists once: {@link montarMembroUnico} at birth,
 * `espelhoDoMembroUnico` on a later edit, and `buildKitStatusChildOps` when the
 * parent's kit flag is toggled.
 */
export function camposDeKitDoMembroUnico(
  parent: Pick<ParentParaMembroUnico, 'ehKit' | 'ehKitVirtual' | 'componentesKit'>,
): Record<string, unknown> {
  const ehKit = parent.ehKit === true;
  // Same rule the create page's `deriveOnSave` applies to the parent: a non-kit
  // carries no map, so the denorm can never outlive the flag.
  const componentesKit = ehKit ? (parent.componentesKit ?? null) : null;
  const temComponentes = componentesKit != null && Object.keys(componentesKit).length > 0;

  return {
    ehKit,
    ehKitVirtual: ehKit && parent.ehKitVirtual === true,
    componentesKit: temComponentes ? componentesKit : null,
    // Sorted, order-stable: the keys feed an `array-contains` query and
    // Firestore arrays are order-sensitive.
    componentesKitKeys: temComponentes ? Object.keys(componentesKit).sort() : null,
  };
}

/** The names of the fields {@link camposDeKitDoMembroUnico} owns, as a set. */
export const CAMPOS_DE_KIT_DO_MEMBRO: readonly string[] = [
  'ehKit',
  'ehKitVirtual',
  'componentesKit',
  'componentesKitKeys',
];

export function montarMembroUnico(
  parentId: string,
  parent: ParentParaMembroUnico,
): Record<string, unknown> {
  return {
    nome: (parent.nome ?? '').slice(0, PRODUTO_NOME_MAX),
    sku: parent.sku ?? null,
    paiId: parentId,
    codPai: parent.codPai ?? null,
    gtin: parent.gtin ?? null,
    publicado: parent.publicado === true,
    ehUsado: parent.ehUsado === true,
    ...camposDeKitDoMembroUnico(parent),
    precos: parent.precos ?? null,
    categoriaProdutoOuterRef: parent.categoriaProdutoOuterRef ?? null,
    pesoLiquidoKg: parent.pesoLiquidoKg ?? null,
    pesoBrutoKg: parent.pesoBrutoKg ?? null,
    alturaCm: parent.alturaCm ?? null,
    larguraCm: parent.larguraCm ?? null,
    profundidadeCm: parent.profundidadeCm ?? null,
    grupoDeVariacoesUid: null,
    variacoesUid: null,
  };
}

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
export function montarMembroUnico(
  parentId: string,
  parent: ParentParaMembroUnico,
): Record<string, unknown> {
  return {
    ...espelhoDoMembroUnico(parent),
    paiId: parentId,
    // ⚠️ `precos` rides the CREATE only. Keeping an existing member's prices in
    // step is the `onProdutoChanged` trigger's job and has been since 2026-07-21,
    // because it is the one mirrored field with an operator OPT-OUT
    // (`propagatePriceToChildren`). See {@link espelhoDoMembroUnico}.
    precos: parent.precos ?? null,
    grupoDeVariacoesUid: null,
    variacoesUid: null,
  };
}

/**
 * The fields a sole member MIRRORS from its parent — the create-time copy and
 * the ongoing sync are the same list, deliberately, so the two cannot drift into
 * disagreeing about what "a mirror" contains.
 *
 * ⚠️ **`precos` is NOT here.** Every other mirrored field is unconditional, but
 * prices already have a propagation path with an operator-facing opt-out
 * (`propagatePriceToChildren`, honoured by `onProdutoChanged`). Folding them in
 * here would silently defeat that checkbox — the parent's map would arrive at
 * the child through the mirror on the very save where the operator asked it not
 * to. `montarMembroUnico` still copies it once, at creation, where there is no
 * previous value to preserve and no propagation to race.
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

/**
 * The four kit fields the mirror moves as **one unit, never four**.
 *
 * ⚠️ They are not independent. `componentesKitKeys` is DERIVED from
 * `componentesKit`, and `ehKit` gates both — `onProdutoDeleted.ts:75` states it
 * outright, that the pair is *"rewritten together (never one without the
 * other)"*. Deciding them separately can leave a member whose flag says kit while
 * its map is null, or whose keys array names a component the map does not hold,
 * and `calcularAlteracoesEstoque` reads that combination as "kit with no
 * components": the sale moves NOTHING.
 */
export const CAMPOS_DE_KIT_DO_MEMBRO: readonly string[] = [
  'ehKit',
  'ehKitVirtual',
  'componentesKit',
  'componentesKitKeys',
];

export function espelhoDoMembroUnico(parent: ParentParaMembroUnico): Record<string, unknown> {
  return {
    nome: (parent.nome ?? '').slice(0, PRODUTO_NOME_MAX),
    sku: parent.sku ?? null,
    codPai: parent.codPai ?? null,
    gtin: parent.gtin ?? null,
    publicado: parent.publicado === true,
    ehUsado: parent.ehUsado === true,
    ...camposDeKitDoMembroUnico(parent),
    categoriaProdutoOuterRef: parent.categoriaProdutoOuterRef ?? null,
    pesoLiquidoKg: parent.pesoLiquidoKg ?? null,
    pesoBrutoKg: parent.pesoBrutoKg ?? null,
    alturaCm: parent.alturaCm ?? null,
    larguraCm: parent.larguraCm ?? null,
    profundidadeCm: parent.profundidadeCm ?? null,
  };
}

/**
 * Are two `componentesKit` maps the same kit?
 *
 * ⚠️ **`timestamp` is deliberately outside the fold, and every other field is
 * inside it.** A `Kit` entry carries `quantidade`, `limitarEstoque` and an
 * ms-epoch `timestamp` that the editor restamps on save (`kit.ts`), so a
 * timestamp-sensitive comparison would report a difference on a save that
 * changed no component at all — and in {@link planejarSincronizacaoDoMembroUnico}
 * that reads as "the operator diverged this child", which SILENCES the mirror
 * for good. The stamp records when the entry was edited; it is not part of what
 * the kit *is*.
 *
 * What must stay distinct: a different `quantidade`, a flipped `limitarEstoque`,
 * a component added or removed. All three change what the kit assembles from and
 * therefore what `kitEstoqueDisponivel` computes.
 *
 * ⚠️ `.passthrough()` means the migrated corpus can carry fields neither side
 * models. Those are NOT compared — folding on an unmodelled field would make the
 * mirror chase legacy noise — and they are preserved on whichever document is
 * not rewritten, never merged.
 */
function mesmoComponentesKit(a: unknown, b: unknown): boolean {
  const ma = (a ?? {}) as Record<string, Record<string, unknown>>;
  const mb = (b ?? {}) as Record<string, Record<string, unknown>>;
  const ka = Object.keys(ma);
  if (ka.length !== Object.keys(mb).length) return false;
  return ka.every((k) => {
    const ea = ma[k];
    const eb = mb[k];
    if (ea == null || eb == null) return false;
    return ea.quantidade === eb.quantidade && ea.limitarEstoque === eb.limitarEstoque;
  });
}

/** Order-sensitive, because `componentesKitKeys` feeds an `array-contains`. */
function mesmaListaDeChaves(a: unknown, b: unknown): boolean {
  const la = (a ?? []) as unknown[];
  const lb = (b ?? []) as unknown[];
  return la.length === lb.length && la.every((v, i) => v === lb[i]);
}

/**
 * One comparator per mirrored field that is NOT a primitive.
 *
 * ⚠️ Everything unnamed falls back to `===`, which for an object-valued field
 * means **identity** — two structurally identical maps read as different, so the
 * merge would see "the operator diverged this" on every single save and the
 * field would never propagate again. Silent, and permanent.
 *
 * That is not a hypothetical: it is what a mutation test found here. Adding
 * `precos` back to {@link espelhoDoMembroUnico} left the whole suite green,
 * because the fixture's two literals were different objects and the merge
 * declined for the wrong reason. So the field list and this map are pinned
 * TOGETHER by `familia.test.ts` — a new object-valued mirrored field with no
 * comparator fails a test instead of quietly never syncing.
 */
const COMPARADORES: Record<string, (a: unknown, b: unknown) => boolean> = {
  componentesKit: mesmoComponentesKit,
  componentesKitKeys: mesmaListaDeChaves,
};

/** The mirrored fields compared by something other than `===`. */
export const CAMPOS_ESPELHADOS_COM_COMPARADOR: readonly string[] = Object.keys(COMPARADORES);

const mesmoCampo = (campo: string, a: unknown, b: unknown): boolean =>
  (COMPARADORES[campo] ?? ((x, y) => x === y))(a, b);

/**
 * The patch that brings a sole member back in step with its parent — or `null`
 * when it is already there.
 *
 * ## Why a THREE-WAY merge and not a copy
 *
 * The sole member is an ordinary produto document and it shows up as a row in
 * the Variações tab, so an operator can rename it, give it its own SKU, or clear
 * a dimension. A straight copy would silently undo that on the parent's next
 * save — a second writer that always wins, which is the shape root `CLAUDE.md`
 * rule 7 tier 3 exists to refuse.
 *
 * So each field moves only when BOTH hold: the parent actually changed it, and
 * the child still carries the parent's PREVIOUS value. A field the operator
 * diverged is left alone **individually** — divergence on `nome` does not freeze
 * `sku`.
 *
 * ## ⚠️ The merge is also the concurrency guard, and that is deliberate
 *
 * Two rapid parent edits produce two trigger runs with no ordering guarantee
 * (rule 7). If the NEWER one lands first, the older run then reads a child that
 * no longer holds its `before` value — so it declines rather than reverting the
 * newer state. The race is made impossible by the comparison instead of being
 * detected after the fact (tier 0). The remaining window — a write landing
 * between the caller's read and its update — is closed by the caller with a
 * `lastUpdateTime` precondition (tier 1), which Admin-side callers have and
 * which is the only reason this can stay a plain read + update.
 *
 * @param paiAntes the parent BEFORE the write, or `null`/`undefined` on a
 *   create — where there is nothing to propagate, because whatever created the
 *   parent created the member from the same values.
 * @param filho the member's stored document, raw. It is normalised through
 *   {@link espelhoDoMembroUnico} before comparison so a legacy document missing
 *   a key is not mistaken for a deliberate divergence.
 */
export function planejarSincronizacaoDoMembroUnico(
  paiAntes: ParentParaMembroUnico | null | undefined,
  paiDepois: ParentParaMembroUnico,
  filho: ParentParaMembroUnico,
): Record<string, unknown> | null {
  const movidos = camposEspelhadosQueMudaram(paiAntes, paiDepois);
  if (movidos.length === 0) return null;

  const antes = espelhoDoMembroUnico(paiAntes!);
  const depois = espelhoDoMembroUnico(paiDepois);
  const atual = espelhoDoMembroUnico(filho);

  // ⛔ The kit group is decided ONCE, for all four fields together.
  //
  // `componentesKitKeys` is derived from `componentesKit` and `ehKit` gates both,
  // so deciding them independently produces states the schema forbids. Two of
  // them, both reproduced against the shipped function before this fix: a member
  // whose map the operator diverged had its KEYS moved alone (leaving keys that
  // disagree with the map), and a parent turning OFF `ehKit` moved the flag while
  // its map survived — contradicting this file's own rule that "a non-kit carries
  // no map, so the denorm can never outlive the flag".
  //
  // The member must match `antes` on ALL FOUR before any of them move: a
  // divergence anywhere in the group means the operator owns the group.
  const grupoMovido = movidos.some((c) => CAMPOS_DE_KIT_DO_MEMBRO.includes(c));
  const grupoEmSincronia = CAMPOS_DE_KIT_DO_MEMBRO.every((c) => mesmoCampo(c, atual[c], antes[c]));

  const patch: Record<string, unknown> = {};
  if (grupoMovido && grupoEmSincronia) {
    for (const campo of CAMPOS_DE_KIT_DO_MEMBRO) patch[campo] = depois[campo];
  }
  for (const campo of movidos) {
    if (CAMPOS_DE_KIT_DO_MEMBRO.includes(campo)) continue; // decided above, as a unit
    if (!mesmoCampo(campo, atual[campo], antes[campo])) continue; // the operator diverged it
    patch[campo] = depois[campo];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Which mirrored fields this parent write actually moved — pure, and the reason
 * an ordinary produto save costs **zero extra reads**.
 *
 * A caller asks this first and only then fetches the member: without it every
 * save of every family-of-one produto would read a document just to discover
 * there was nothing to write, on the most-written collection in the ERP.
 *
 * A CREATE (`paiAntes == null`) moves nothing: whatever created the parent
 * created the member from the same values, so there is no propagation to do and
 * no previous value to merge against.
 */
export function camposEspelhadosQueMudaram(
  paiAntes: ParentParaMembroUnico | null | undefined,
  paiDepois: ParentParaMembroUnico,
): string[] {
  if (paiAntes == null) return [];
  const antes = espelhoDoMembroUnico(paiAntes);
  const depois = espelhoDoMembroUnico(paiDepois);
  return Object.keys(depois).filter((campo) => !mesmoCampo(campo, antes[campo], depois[campo]));
}

import type { GrupoDeVariacoes, Variante } from '../../grupoDeVariacoes';

/**
 * Pure helpers for product variations — the Cartesian child-product
 * generation, the "fake path" wire format and the reconstruct flows. Ports of
 * the Flutter logic in `produtoTableProvider.dart` (`gerarVariacoes`,
 * `_reconstruirVariacoesFromSku`, `_reconstruirVariacoesFromSelectedVariacoes`)
 * and `models.dart` (`Produto.save(sortVariacoes:)`, `Variante.getFakePath` /
 * `remakeFakePath`). Everything here is pure so the wire-compat behavior is
 * unit-testable in isolation.
 *
 * Legacy wire shapes (must stay byte-identical to Flutter):
 *  - `Produto.grupoDeVariacoesUid`: BARE group doc ids, de-duped, sorted by
 *    `grupo.ordem`.
 *  - `Produto.variacoesUid` (parent and children): fake paths
 *    `documents/grupoDeVariacoes/<grupoId>/variacoes/<varianteId>`, de-duped,
 *    sorted group-major (groups by `ordem`, variants by their index inside
 *    `grupo.variacoes`), unknown leftovers appended.
 */

/** A `grupoDeVariacoes` doc with its id (shape of a snapshot row). */
export interface GrupoComId {
  id: string;
  data: GrupoDeVariacoes;
}

/** Mirror of Flutter `Variante.getFakePath` (`models.dart:5077`). */
export function varianteFakePath(grupoId: string, varianteId: string): string {
  return `documents/grupoDeVariacoes/${grupoId}/variacoes/${varianteId}`;
}

/**
 * The `Foto.grupoDeVariacoesOuterRef` wire shape — Flutter tags a per-variant
 * photo with the group's `docId.pathWithDocuments` (`widgets.dart:334`).
 */
export function grupoOuterRef(grupoId: string): string {
  return `documents/grupoDeVariacoes/${grupoId}`;
}

/**
 * Parse any tolerated fake-path form (`documents/...`, leading-slash, or the
 * bare `grupoDeVariacoes/<g>/variacoes/<v>`) into its ids. Mirrors Flutter's
 * `getIdFromPath` (last segment) + `getGrupoIdFromPath` (3rd from the end).
 */
export function parseFakePath(path: string): { grupoId: string; varianteId: string } | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  const varianteId = parts[parts.length - 1]!;
  const grupoId = parts[parts.length - 3]!;
  if (!grupoId || !varianteId) return null;
  return { grupoId, varianteId };
}

/** Mirror of Flutter `Variante.remakeFakePath` — normalize to the canonical form. */
export function remakeFakePath(path: string): string | null {
  const parsed = parseFakePath(path);
  return parsed ? varianteFakePath(parsed.grupoId, parsed.varianteId) : null;
}

function grupoById(grupos: GrupoComId[]): Map<string, GrupoComId> {
  return new Map(grupos.map((g) => [g.id, g]));
}

/** Groups sorted by `ordem` (stable; unknown/missing ordem keeps insertion order last). */
export function sortGruposByOrdem(grupos: GrupoComId[]): GrupoComId[] {
  return [...grupos].sort((a, b) => (a.data.ordem ?? Infinity) - (b.data.ordem ?? Infinity));
}

/**
 * Normalize a `grupoDeVariacoesUid` value for write: bare ids (tolerating
 * legacy path forms via `split('/').last`), de-duped, sorted by `grupo.ordem`
 * (mirror of `models.dart:2028-2032`). Unknown ids keep their relative order
 * at the end.
 */
export function sortGrupoUids(uids: string[], grupos: GrupoComId[]): string[] {
  const byId = grupoById(grupos);
  const bare = [...new Set(uids.map((u) => u.split('/').pop()!).filter((u) => u.length > 0))];
  return bare.sort((a, b) => {
    const oa = byId.get(a)?.data.ordem ?? Infinity;
    const ob = byId.get(b)?.data.ordem ?? Infinity;
    return oa - ob;
  });
}

/**
 * Normalize a `variacoesUid` value for write: remake every fake path, de-dup,
 * then sort group-major — groups by `ordem`, variants by their index inside
 * `grupo.variacoes` — with leftovers (unknown group/variant) appended in their
 * original order. Mirror of `models.dart:2034-2057`.
 */
export function normalizeVariacoesUid(uids: string[], grupos: GrupoComId[]): string[] {
  const remade: string[] = [];
  for (const uid of uids) {
    const canonical = remakeFakePath(uid);
    if (canonical && !remade.includes(canonical)) remade.push(canonical);
  }

  const sorted: string[] = [];
  for (const grupo of sortGruposByOrdem(grupos)) {
    const variantes = grupo.data.variacoes ?? [];
    const ofGroup = remade.filter((uid) => parseFakePath(uid)?.grupoId === grupo.id);
    ofGroup.sort((a, b) => {
      const ia = variantes.findIndex((v) => v.id === parseFakePath(a)?.varianteId);
      const ib = variantes.findIndex((v) => v.id === parseFakePath(b)?.varianteId);
      return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    });
    sorted.push(...ofGroup);
  }
  const leftovers = remade.filter((uid) => !sorted.includes(uid));
  return [...sorted, ...leftovers];
}

/** One generated child combination. */
export interface VariationCombo {
  nome: string;
  sku: string;
  variacoesUid: string[];
  /** Per-group variant index — lexicographic order = display/`ordem` order. */
  sortKey: number[];
}

/** Lexicographic compare of `sortKey`s (shorter keys sort first on ties). */
export function compareSortKeys(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Cartesian generation — port of `gerarVariacoes`
 * (`produtoTableProvider.dart:688`). For each selected group (by `ordem`) ×
 * each selected variant: `nome = "${nome} ${v.nome}"`, `sku = "${sku}${v.codigo}"`
 * (sku only concatenated when the parent has one). Returns combos sorted by
 * `sortKey`.
 *
 * Fixes vs the old app: a selected group with NO selected variants is skipped
 * (Flutter collapsed the whole generation to zero combos); a null `codigo`
 * contributes '' to the sku (Flutter interpolated the string "null"); variant
 * matching is by group+variant id from the fake path (Flutter matched variant
 * id alone, which could cross groups).
 */
export function cartesianVariations(input: {
  parentNome: string;
  parentSku: string | null;
  grupos: GrupoComId[];
  /** Selected variant fake paths (the parent's `variacoesUid` selection). */
  selectedUids: string[];
}): VariationCombo[] {
  const selected = new Set(
    input.selectedUids.map((u) => remakeFakePath(u)).filter((u): u is string => u !== null),
  );

  let combos: VariationCombo[] = [
    { nome: input.parentNome, sku: input.parentSku ?? '', variacoesUid: [], sortKey: [] },
  ];

  for (const grupo of sortGruposByOrdem(input.grupos)) {
    const variantes = (grupo.data.variacoes ?? []).filter((v) =>
      selected.has(varianteFakePath(grupo.id, v.id)),
    );
    if (variantes.length === 0) continue; // group selected but no variants picked

    const prev = combos;
    combos = [];
    for (const variante of variantes) {
      for (const base of prev) {
        combos.push({
          nome: `${base.nome} ${variante.nome}`,
          sku: base.sku === '' ? '' : `${base.sku}${variante.codigo ?? ''}`,
          variacoesUid: [...base.variacoesUid, varianteFakePath(grupo.id, variante.id)],
          sortKey: [
            ...base.sortKey,
            (grupo.data.variacoes ?? []).findIndex((v) => v.id === variante.id),
          ],
        });
      }
    }
  }

  // No group expanded anything ⇒ no variations to generate.
  if (combos.length === 1 && combos[0]!.variacoesUid.length === 0) return [];
  return combos.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
}

/** Unordered equality of two `variacoesUid` sets (the dedup key for children). */
export function sameCombo(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b.map((u) => remakeFakePath(u) ?? u));
  return a.every((u) => setB.has(remakeFakePath(u) ?? u));
}

export type ReconstructResult =
  | { ok: true; nome: string; sku: string; variacoesUid: string[]; sortKey: number[] }
  | { ok: false; error: string };

/**
 * Reconstruct a child's nome/sku/order from its `variacoesUid` (mode A — the
 * canonical data). Port of `_reconstruirVariacoesFromSelectedVariacoes`
 * (`produtoTableProvider.dart:869`): names/códigos joined in group-`ordem`
 * order.
 */
export function reconstructFromVariacoesUid(input: {
  childUids: string[];
  parentNome: string;
  parentSku: string;
  grupos: GrupoComId[];
}): ReconstructResult {
  const normalized = normalizeVariacoesUid(input.childUids, input.grupos);
  if (normalized.length === 0) {
    return { ok: false, error: 'variação sem variacoesUid' };
  }
  const nomes: string[] = [];
  let sku = input.parentSku;
  const sortKey: number[] = [];
  for (const uid of normalized) {
    const parsed = parseFakePath(uid)!;
    const grupo = input.grupos.find((g) => g.id === parsed.grupoId);
    const variante: Variante | undefined = grupo?.data.variacoes?.find(
      (v) => v.id === parsed.varianteId,
    );
    if (!grupo || !variante) {
      return { ok: false, error: `variante não encontrada para ${uid}` };
    }
    nomes.push(variante.nome);
    sku = `${sku}${variante.codigo ?? ''}`;
    sortKey.push(grupo.data.variacoes!.findIndex((v) => v.id === variante.id));
  }
  return {
    ok: true,
    nome: `${input.parentNome} ${nomes.join(' ')}`,
    sku,
    variacoesUid: normalized,
    sortKey,
  };
}

/**
 * Upper bound on the grupos {@link skuPaiPorSufixo} will match. The decomposition
 * below is O(2^n · n) with the memo, so this only exists to keep a nonsense input
 * from becoming a CPU burn; a produto with more than a handful of variation
 * grupos does not exist in this catalogue.
 */
const MAX_GRUPOS_SUFIXO = 16;

/**
 * Recover a PARENT sku from one child's, by removing the variant códigos from the
 * end — the inverse of {@link cartesianVariations}, which builds a child as
 * `parentSku + variante.codigo`, one código per grupo.
 *
 * Written for the Mercado Livre User-Products import (#1400), where a família's
 * members are separate ML items and the parent's own sku has no slot on the
 * wire: when the ERP already knows the taxonomy, the child's sku is the only
 * remaining witness of it.
 *
 * ⚠️ **Order-INDEPENDENT, and that is a correctness requirement rather than a
 * convenience.** The obvious implementation peels in reverse `ordem`, mirroring
 * the ascending sort `cartesianVariations` appends in. It is wrong: both sorts
 * are STABLE, so on an `ordem` TIE the mirrored comparator preserves the input
 * order instead of reversing it, and the peel refuses a perfectly good sku. The
 * tie is not exotic — `planTaxonomia` stamps `ordem: 1` on every grupo it
 * creates, so every multi-grupo taxonomy the ML importer built ties, which is
 * exactly the population this function exists to serve. Worse, for a tie the
 * build order is not even knowable here: it came from the produto form's grupo
 * list, while the importer's array comes from ML's `attribute_combinations`.
 *
 * What rescues it is that **order ambiguity cannot become ANSWER ambiguity**.
 * Every grupo contributes exactly one código, so the suffix length is fixed
 * whatever the order, and the parent sku is therefore determined by arithmetic
 * alone. Order only decides whether the suffix *decomposes* — never into what.
 * So this takes the fixed-length prefix and then PROVES the remainder is a
 * concatenation of all the códigos in some order.
 *
 * ⚠️ **Every uncertainty returns `null`, never a partial guess.** A sku is an
 * identity — the ERP resolves produtos by it — so a wrong one is worse than an
 * absent one. It refuses when: there are no grupos; ANY grupo's variante has no
 * `codigo` (the fresh-import case, where `planTaxonomia` creates variantes with
 * `codigo: null`, so there is nothing to remove and the answer would be the
 * child's own sku wearing the parent's name); the tail is not a concatenation of
 * the códigos; or nothing would be left of the parent.
 *
 * ⚠️ Distinct from the legacy `gessSkuFromMercadoLivre`, which stripped a FIXED
 * six characters and could not say when it was wrong. This removes the códigos
 * that are really there, or declines.
 *
 * The comparison is byte-exact on purpose. Folding case or accents would make
 * `'CAM-p'` match a `'-P'` código, and the recovered parent would then differ
 * from the one that produced it — the near-misses `'CAM-01'` vs `'CAM-1'` and
 * `'CAM-P'` vs `'CAM-PP'` must all stay distinct.
 */
export function skuPaiPorSufixo(
  childSku: string | null | undefined,
  codigos: ReadonlyArray<string | null | undefined>,
): string | null {
  const sku = typeof childSku === 'string' ? childSku.trim() : '';
  if (sku === '' || codigos.length === 0 || codigos.length > MAX_GRUPOS_SUFIXO) return null;

  const partes: string[] = [];
  for (const codigo of codigos) {
    if (typeof codigo !== 'string' || codigo === '') return null;
    partes.push(codigo);
  }

  const total = partes.reduce((n, c) => n + c.length, 0);
  // `>=`, not `>`: consuming the whole sku leaves no parent, which is a refusal
  // rather than an empty-string answer.
  if (total >= sku.length) return null;

  const corte = sku.length - total;
  if (!sufixoEhConcatenacao(sku.slice(corte), partes)) return null;
  return sku.slice(0, corte);
}

/**
 * Is `sufixo` exactly the concatenation of ALL of `partes`, in some order?
 *
 * Consumes from the END so a matching código is found with `endsWith`, and
 * backtracks — a greedy longest-match would reject `'PPP'` against
 * `['P', 'PP']` by taking `'PP'` first from a tail that needed `'P'`.
 *
 * ⚠️ The memo is keyed on the used-mask ALONE, which is sound because the mask
 * fixes how many characters have been consumed and therefore what `resto` is:
 * the same mask can never be reached with a different remainder. It only records
 * FAILURES — a success returns immediately.
 */
function sufixoEhConcatenacao(sufixo: string, partes: readonly string[]): boolean {
  const completo = (1 << partes.length) - 1;
  const semSaida = new Set<number>();

  const buscar = (resto: string, usados: number): boolean => {
    if (usados === completo) return resto === '';
    if (semSaida.has(usados)) return false;
    for (let i = 0; i < partes.length; i += 1) {
      const bit = 1 << i;
      if ((usados & bit) !== 0) continue;
      const parte = partes[i]!;
      if (!resto.endsWith(parte)) continue;
      if (buscar(resto.slice(0, resto.length - parte.length), usados | bit)) return true;
    }
    semSaida.add(usados);
    return false;
  };

  return buscar(sufixo, 0);
}

/**
 * Reconstruct a legacy child (empty `variacoesUid`) by peeling variant códigos
 * off the END of its SKU, walking the groups in reverse `ordem` order — port
 * of `_reconstruirVariacoesFromSku` (`produtoTableProvider.dart:903`).
 *
 * Fixes vs the old app: the recovered order comes from the variant-index
 * `sortKey` (lexicographic), not the `int.parse("...".padRight(index))`
 * expression that crashes at runtime (space-padded ints don't parse); variants
 * without a `codigo` are skipped instead of matching the literal "null".
 */
export function reconstructFromSkuSuffix(input: {
  childSku: string;
  parentNome: string;
  parentSku: string;
  grupos: GrupoComId[];
}): ReconstructResult {
  if (!input.childSku.startsWith(input.parentSku) || input.parentSku === '') {
    return { ok: false, error: `sku "${input.childSku}" não começa com o sku do pai` };
  }
  let suffix = input.childSku.slice(input.parentSku.length);

  const gruposDesc = sortGruposByOrdem(input.grupos).reverse();
  // Collected in reverse group order; flipped at the end.
  const nomesDesc: string[] = [];
  const uidsDesc: string[] = [];
  const sortKeyDesc: number[] = [];

  for (const grupo of gruposDesc) {
    const variantes = grupo.data.variacoes ?? [];
    const match = variantes.find(
      (v) => v.codigo != null && v.codigo !== '' && suffix.endsWith(v.codigo),
    );
    if (!match) {
      return {
        ok: false,
        error: `não foi possível encontrar a variante para o sku "${input.childSku}" na variação ${grupo.data.nome}`,
      };
    }
    suffix = suffix.slice(0, suffix.length - match.codigo!.length);
    nomesDesc.push(match.nome);
    uidsDesc.push(varianteFakePath(grupo.id, match.id));
    sortKeyDesc.push(variantes.findIndex((v) => v.id === match.id));
  }

  return {
    ok: true,
    nome: `${input.parentNome} ${nomesDesc.reverse().join(' ')}`,
    sku: input.childSku,
    variacoesUid: uidsDesc.reverse(),
    sortKey: sortKeyDesc.reverse(),
  };
}

/**
 * Non-empty trimmed SKUs shared by two or more live (non-delete-marked) rows.
 * Returns `sku → row keys` with only the offending SKUs present. Empty SKUs
 * never count — legacy data legally holds several empty-SKU children (parent
 * without SKU + variants without código), and the child-SKU == parent-SKU
 * case is also legacy-legal, so uniqueness is only enforced among siblings.
 */
export function findDuplicateSkus(
  rows: Array<{ key: string; sku: string; deleteMark: boolean }>,
): Map<string, string[]> {
  const bySku = new Map<string, string[]>();
  for (const row of rows) {
    if (row.deleteMark) continue;
    const sku = row.sku.trim();
    if (sku === '') continue;
    const keys = bySku.get(sku);
    if (keys) keys.push(row.key);
    else bySku.set(sku, [row.key]);
  }
  for (const [sku, keys] of bySku) {
    if (keys.length < 2) bySku.delete(sku);
  }
  return bySku;
}

/** The staged-row fields `reconcileStagedChildren` needs (issue #117). */
export interface ReconcilableRow {
  /** Firestore doc id — empty/null for staged creates. */
  id: string | null;
  sku: string;
  variacoesUid: string[];
  deleteMark: boolean;
}

/**
 * Reconcile staged (delete, create) pairs into id-reusing updates — the user
 * who deletes a child and recreates "the same" variation (same SKU, e.g. via
 * Gerar after an accidental delete) must keep the original doc id, because
 * the id anchors estoque docs, marketplace variation links, kit entries and
 * NF-e history (issue #117).
 *
 * Pairing rules (per staged create, in row order):
 *  1. Non-empty trimmed SKU equal to a staged-delete's SKU. Several matches
 *     (legacy duplicate SKUs) prefer the delete with the same variant combo
 *     (`sameCombo`), else the first in order.
 *  2. Empty-SKU creates pair only by `sameCombo`, and only when both combos
 *     are non-empty (two blank manual rows are not "the same variation").
 *
 * A paired create comes back with the delete's `id` (everything else
 * unchanged); the absorbed delete row is removed from the output. The caller
 * must persist the pair as an UPDATE writing the reconciled display fields
 * (nome/sku/variacoesUid/ordem) — never dims/pesos or other doc fields, which
 * is the point of preserving the doc. Unpaired deletes stay in the output for
 * the real-deletion path (reference guard + delete).
 *
 * ## Rule 3 — the SOLE MEMBER is absorbed by the first real variation (#1398)
 *
 * A produto is born as a family of one, so a produto that has never had
 * variations still owns one child: a mirror of itself, carrying its stock, its
 * estoque history, and whatever pedido lines and kit entries name it.
 *
 * The moment the operator generates real variations that child stops being a
 * sole member — and leaving it beside them is wrong twice over. It shows as a
 * phantom extra row in the Variações tab (so "the first variation" is not the
 * one the operator sees first), and the parent's `filhoUnicoId` keeps naming
 * it while the family now has several members, which sends every stock reader
 * to one arbitrary variation.
 *
 * So an UNMARKED sole member absorbs the FIRST staged create, exactly as a
 * staged delete would: same id reuse, same reason — the id anchors everything.
 * Deleting it instead would drop the produto's stock and orphan every reference
 * to it, and that is the one outcome worse than either.
 *
 * ⚠️ It absorbs at most ONE create, and only when it is not itself the create.
 * ⚠️ It applies only to a sole member with an EMPTY combo — a child that already
 * carries a `variacoesUid` is a real variation whatever the parent points at,
 * and rules 1-2 own it.
 */
export function reconcileStagedChildren<R extends ReconcilableRow>(
  rows: R[],
  /**
   * The parent's `filhoUnicoId`: the doc id of its sole member, when it has one.
   * Absent/null on a produto that already has real variations — rule 3 is then
   * inert and this behaves exactly as it did before #1398.
   */
  membroUnicoId?: string | null,
): { rows: R[]; reusedIds: string[] } {
  const deletes = rows.filter((r) => r.deleteMark && r.id);
  const paired = new Set<R>();
  const reusedBy = new Map<R, string>();

  for (const row of rows) {
    if (row.deleteMark || row.id) continue; // only staged creates
    const sku = row.sku.trim();
    let candidates: R[];
    if (sku !== '') {
      candidates = deletes.filter((d) => !paired.has(d) && d.sku.trim() === sku);
    } else {
      candidates =
        row.variacoesUid.length === 0
          ? []
          : deletes.filter(
              (d) =>
                !paired.has(d) &&
                d.variacoesUid.length > 0 &&
                sameCombo(d.variacoesUid, row.variacoesUid),
            );
    }
    const match =
      candidates.length > 1
        ? (candidates.find((d) => sameCombo(d.variacoesUid, row.variacoesUid)) ?? candidates[0]!)
        : candidates[0];
    if (!match) continue;
    paired.add(match);
    reusedBy.set(row, match.id!);
  }

  // Rule 3. Runs AFTER rules 1-2 so an explicit delete/create pair always wins:
  // the operator who deleted a variation and recreated it means that doc, and
  // the sole member is only the fallback anchor for a create nothing else claimed.
  if (membroUnicoId != null && membroUnicoId !== '') {
    const membro = rows.find(
      (r) => r.id === membroUnicoId && !r.deleteMark && r.variacoesUid.length === 0,
    );
    const primeiroCriado = rows.find(
      (r) => !r.deleteMark && !r.id && !paired.has(r) && reusedBy.get(r) === undefined,
    );
    if (membro && primeiroCriado && !paired.has(membro)) {
      paired.add(membro);
      reusedBy.set(primeiroCriado, membroUnicoId);
    }
  }

  return {
    rows: rows
      .filter((r) => !paired.has(r))
      .map((r) => {
        const reusedId = reusedBy.get(r);
        return reusedId === undefined ? r : { ...r, id: reusedId };
      }),
    reusedIds: [...reusedBy.values()],
  };
}

/** One per-variant photo section of the parent's gallery. */
export interface FotoVariantSection {
  /** Canonical variant fake path — the `Foto.variantePath` tag. */
  uid: string;
  grupoId: string;
  varianteId: string;
  grupoNome: string;
  varianteNome: string;
  /** Indexes into the input `fotos` array, in array order. */
  fotoIndexes: number[];
}

export interface FotoSections {
  /** Indexes of untagged/orphaned fotos (the parent-level gallery). */
  general: number[];
  variants: FotoVariantSection[];
}

/**
 * Split a parent's `fotos` into the per-variant gallery sections — port of the
 * Flutter `Fotos2ProdutoWidget` grouping (`widgets.dart:142-237`):
 *
 *  - One section per entry of the parent's `variacoesUid` (order preserved)
 *    whose group exists and has `permiteFotos`.
 *  - A foto belongs to a variant section when its `variantePath` matches that
 *    entry (compared canonically, tolerating legacy path forms).
 *  - Everything else — untagged fotos, tags pointing at unselected variants,
 *    unknown groups, or groups without `permiteFotos` — falls back to the
 *    general (parent-level) section, exactly like the old app.
 */
export function splitFotoSections(input: {
  fotos: Array<{ variantePath?: string | null }>;
  /** The parent's `variacoesUid` (variant fake paths). */
  parentUids: string[];
  grupos: GrupoComId[];
}): FotoSections {
  const byId = grupoById(input.grupos);

  const variants: FotoVariantSection[] = [];
  for (const rawUid of input.parentUids) {
    const uid = remakeFakePath(rawUid);
    if (!uid) continue;
    const { grupoId, varianteId } = parseFakePath(uid)!;
    const grupo = byId.get(grupoId);
    if (!grupo || grupo.data.permiteFotos !== true) continue;
    const variante = grupo.data.variacoes?.find((v) => v.id === varianteId);
    if (variants.some((s) => s.uid === uid)) continue;
    variants.push({
      uid,
      grupoId,
      varianteId,
      grupoNome: grupo.data.nome,
      varianteNome: variante?.nome ?? varianteId,
      fotoIndexes: [],
    });
  }

  const general: number[] = [];
  const byUid = new Map(variants.map((s) => [s.uid, s]));
  input.fotos.forEach((foto, index) => {
    const tag = foto.variantePath ? remakeFakePath(foto.variantePath) : null;
    const section = tag ? byUid.get(tag) : undefined;
    if (section) section.fotoIndexes.push(index);
    else general.push(index);
  });

  return { general, variants };
}

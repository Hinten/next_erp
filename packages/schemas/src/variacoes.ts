import type { GrupoDeVariacoes, Variante } from './grupoDeVariacoes';

/**
 * Pure helpers for product variations — the Cartesian child-product
 * generation, the "fake path" wire format and the reconstruct flows. Ports of
 * the Flutter logic in `produtoTableProvider.dart` (`gerarVariacoes`,
 * `_reconstruirVariacoesFromSku`, `_reconstruirVariacoesFromSelectedVariacoes`)
 * and `models.dart` (`Produto.save(sortVariacoes:)`, `Variante.getFakePath` /
 * `remakeFakePath`). Everything here is pure so the wire-compat behavior is
 * unit-testable in isolation.
 *
 * Coexistence wire shapes (must stay byte-identical to Flutter):
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

import type { ComponentesKit } from '../collection/embedded/kit';
import { type GrupoComId, parseFakePath, sameCombo } from './variacoes';

/**
 * "Gerar Variações" for a kit — pure port of the Flutter
 * `gerarComponentesParaVariacoes` (`produtoTableProvider.dart:979`). Given a
 * kit's parent components and the kit's own variation children, it resolves, for
 * each (kit-variation × component), WHICH component-variation should go into that
 * child's `componentesKit` — so a "Camiseta P (kit)" pulls in the "Estampa P"
 * variation of its estampa component, not the bare estampa parent.
 *
 * The resolution ladder, per (kit-variation `v`, component `c`):
 *  - **A** `c` has no variation children          → use `c` itself.
 *  - **B** `c` has exactly one variation child    → use that child.
 *  - **C** `c` has several variation children:
 *      - overlap `targets` = children sharing ANY variant id with `v`;
 *      - **C1** one overlap target                → use it;
 *      - **C2** a target whose variant ids ⊇ `v`'s → use the first such;
 *      - **C3** else walk `v`'s variants looking for a `variantesVinculadasIds`
 *        (linked variants) substitution that yields a single/superset target
 *        (consuming linked slots via `vinculadoUtilizado`); failing that, fall
 *        back to the overlap target with the MOST shared variant ids; if there
 *        is no overlap at all, record an error for this component.
 *
 * Everything is pure (no DB) so the wire-compat matcher is unit-testable in
 * isolation; the caller batches the produto reads (each component's variation
 * children) and the per-child `componentesKit` writes.
 *
 * Fidelity notes vs the (untested) Dart:
 *  - The best-overlap fallback compares against the ORIGINAL kit-variation
 *    variant ids and the ORIGINAL overlap targets — in Dart the linked-variant
 *    block shadows `targets`/`produtoVariacoesIds` with inner locals that go out
 *    of scope before the fallback, so the fallback reads the outer ones. Mirrored
 *    here with explicit `outerTargets` / `outerVariantIds`.
 *  - The linked-slot guard uses `>=` (Dart used `>`, which then indexed
 *    `variantesVinculadasIds[length]` and threw a RangeError); `>=` warns instead
 *    of crashing when the slots are exhausted.
 */

/** A parent kit component (one entry of the parent's `componentesKit`). */
export interface KitComponente {
  /** Component produto id (the `componentesKit` key). */
  produtoId: string;
  quantidade: number;
  limitarEstoque: boolean;
}

/** A produto carrying a `variacoesUid` selection (a kit-variation or a component-variation). */
export interface ComVariacoesUid {
  id: string;
  /** Variant fake paths; only the trailing variant id is compared. */
  variacoesUid: string[];
}

export interface GenerateKitVariacoesInput {
  /** The parent kit's live components (deleted entries already stripped). */
  componentes: KitComponente[];
  /** The kit's own variation children. */
  kitVariacoes: ComVariacoesUid[];
  /** Per parent-component id → that component's variation children (`paiId == componentId`). */
  componentVariacoesByComponentId: Record<string, ComVariacoesUid[]>;
  /** Variation groups, to resolve a variant's `variantesVinculadasIds` from its fake path. */
  grupos: GrupoComId[];
}

export interface GenerateKitVariacoesResult {
  /** kit-variation child id → its generated `componentesKit` map. */
  porFilho: Record<string, ComponentesKit>;
  warnings: string[];
  errors: string[];
}

/** Trailing variant id of a fake path (Flutter `.split('/').last`). */
function lastId(path: string): string {
  return (
    path
      .split('/')
      .filter((p) => p.length > 0)
      .pop() ?? path
  );
}

/** Resolve a variant (by its fake path) to its linked-variant ids + nome, via the grupos. */
function varianteFromPath(
  path: string,
  grupos: GrupoComId[],
): { nome: string; variantesVinculadasIds: string[] } | null {
  const parsed = parseFakePath(path);
  if (!parsed) return null;
  const grupo = grupos.find((g) => g.id === parsed.grupoId);
  const variante = grupo?.data.variacoes?.find((v) => v.id === parsed.varianteId);
  if (!variante) return null;
  return { nome: variante.nome, variantesVinculadasIds: variante.variantesVinculadasIds ?? [] };
}

export function generateKitForVariacoes(
  input: GenerateKitVariacoesInput,
): GenerateKitVariacoesResult {
  const porFilho: Record<string, ComponentesKit> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  const addEntry = (childId: string, key: string, c: KitComponente) => {
    (porFilho[childId] ??= {})[key] = {
      quantidade: c.quantidade,
      limitarEstoque: c.limitarEstoque,
      timestamp: null,
    };
  };

  for (const variacao of input.kitVariacoes) {
    // `vinculadoUtilizado` consumes one linked-variant slot per successful
    // substitution; it persists across this kit-variation's components.
    let vinculadoUtilizado = 0;
    const outerVariantIds = variacao.variacoesUid.map(lastId);

    for (const componente of input.componentes) {
      const variacoesTarget = input.componentVariacoesByComponentId[componente.produtoId] ?? [];

      // A — component without variations: use the component itself.
      if (variacoesTarget.length === 0) {
        addEntry(variacao.id, componente.produtoId, componente);
        continue;
      }
      // B — single variation child: use it.
      if (variacoesTarget.length === 1) {
        addEntry(variacao.id, variacoesTarget[0]!.id, componente);
        continue;
      }

      // C — several variation children.
      const overlaps = (target: ComVariacoesUid, ids: string[]) =>
        target.variacoesUid.map(lastId).some((id) => ids.includes(id));
      const isSuperset = (target: ComVariacoesUid, ids: string[]) => {
        const targetIds = target.variacoesUid.map(lastId);
        return ids.every((e) => targetIds.includes(e));
      };

      const outerTargets = variacoesTarget.filter((t) => overlaps(t, outerVariantIds));

      if (outerTargets.length === 1) {
        addEntry(variacao.id, outerTargets[0]!.id, componente); // C1
        continue;
      }
      const supersetTarget = outerTargets.find((t) => isSuperset(t, outerVariantIds));
      if (outerTargets.length > 0 && supersetTarget) {
        addEntry(variacao.id, supersetTarget.id, componente); // C2
        continue;
      }

      // C3 — linked-variant substitution.
      let encontrou = false;
      for (const p of variacao.variacoesUid) {
        const variante = varianteFromPath(p, input.grupos);
        if (!variante) continue;
        if (variante.variantesVinculadasIds.length === 0) continue;
        if (vinculadoUtilizado >= variante.variantesVinculadasIds.length) {
          warnings.push(
            `A variante ${variante.nome} não possui variações vinculadas suficientes para atender a demanda.`,
          );
          continue;
        }
        // Substitute the variant `p` with its `vinculadoUtilizado`-th linked variant.
        const linkedIds = [
          lastId(variante.variantesVinculadasIds[vinculadoUtilizado]!),
          ...variacao.variacoesUid.filter((x) => x !== p).map(lastId),
        ];
        const linkedTargets = variacoesTarget.filter((t) => overlaps(t, linkedIds));
        if (linkedTargets.length === 1) {
          addEntry(variacao.id, linkedTargets[0]!.id, componente);
          encontrou = true;
          vinculadoUtilizado += 1;
          break;
        }
        const linkedSuperset = linkedTargets.find((t) => isSuperset(t, linkedIds));
        if (linkedTargets.length > 0 && linkedSuperset) {
          addEntry(variacao.id, linkedSuperset.id, componente);
          encontrou = true;
          vinculadoUtilizado += 1;
          break;
        }
      }

      if (!encontrou && outerTargets.length > 0) {
        // Best-overlap fallback (against the ORIGINAL targets + variant ids).
        let best = outerTargets[0]!;
        let hits = 0;
        for (const t of outerTargets) {
          const ids = t.variacoesUid.map(lastId);
          const h = outerVariantIds.filter((e) => ids.includes(e)).length;
          if (h > hits) {
            best = t;
            hits = h;
          }
        }
        addEntry(variacao.id, best.id, componente);
      } else if (!encontrou) {
        errors.push(
          `Não foi possível encontrar uma variação válida para o componente ${componente.produtoId}`,
        );
      }
    }
  }

  return { porFilho, warnings, errors };
}

/** A kit-variation row staged in the grid (saved children carry a real `id`). */
export interface StagedKitRow {
  /**
   * Stable row key — a real produto id for saved rows. For a staged row it is
   * the produto id the caller WILL write the new child under (`apps/web`
   * pre-mints it), so it becomes a real id the moment that child exists.
   */
  key: string;
  /** The real produto id if this variation is already saved, else `null`. */
  id: string | null;
  variacoesUid: string[];
  deleteMark?: boolean;
}

/** A persisted variation child (after the parent + children flush). */
export interface RealKitChild {
  id: string;
  variacoesUid: string[];
}

/**
 * Resolve the grid's staged per-row kit maps (keyed by `StagedKitRow.key`) to
 * concrete `{ id, componentesKit }` writes against the REAL variation children —
 * the bridge that lets "Gerar Variações" target variations added in the Variações
 * tab but not yet saved.
 *
 * Resolution runs in two passes over ALL rows, exact before guess:
 *  1. every exact match — `row.id` when it names a live child (an already-saved
 *     row), else the row's own `key`, which IS the doc id the caller pre-minted
 *     for this child (see {@link StagedKitRow.key});
 *  2. only then, an unordered `variacoesUid` match (`sameCombo`), for a row
 *     whose document the caller wrote under some other id.
 *
 * ⚠️ Two passes, not one ladder per row. Both claim greedily, so resolving each
 * row completely before moving on would let a row that can only match by combo
 * consume the child a later row resolves EXACTLY — its map onto the wrong
 * document and the rightful row's map dropped — decided by nothing but the key
 * order of `stagedByKey`. Output stays in that order regardless of which pass
 * resolved each row.
 *
 * ⚠️ Step 3 requires BOTH combos to be non-empty. `sameCombo([], [])` is `true`,
 * so without that an empty-combo row — what a manually added variation carries —
 * claims the first combo-less child it meets, typically an unrelated legacy
 * sibling, and its map is written onto the WRONG document (`componentesKit` is
 * persisted as a full overwrite). Same guard, same reason, as
 * `reconcileStagedChildren` and the Mercado Livre import's sibling match. An
 * unmatched row resolves to nothing and stays staged, which is recoverable;
 * claiming a stranger is not.
 *
 * Each real child is claimed at most once; rows that are delete-marked, unknown,
 * or unmatched are dropped.
 */
export function resolveStagedKitVariacoes(input: {
  stagedByKey: Record<string, ComponentesKit | null>;
  rows: StagedKitRow[];
  realChildren: RealKitChild[];
}): Array<{ id: string; componentesKit: ComponentesKit | null }> {
  const rowByKey = new Map(input.rows.map((r) => [r.key, r]));
  const realById = new Map(input.realChildren.map((c) => [c.id, c]));
  const claimed = new Set<string>();
  const targetByKey = new Map<string, string>();

  const staged = Object.entries(input.stagedByKey).flatMap(([key, map]) => {
    const row = rowByKey.get(key);
    return row && !row.deleteMark ? [{ key, map, row }] : [];
  });

  // Pass 1 — every exact resolution, across ALL rows, before any guess runs.
  // Both passes claim greedily, so doing this per row would let a row that can
  // only match by combo consume the child a later row resolves exactly, purely
  // because it came first in `stagedByKey`.
  for (const { key, row } of staged) {
    const exact = [row.id, key].find(
      (id): id is string => id !== null && realById.has(id) && !claimed.has(id),
    );
    if (exact === undefined) continue;
    claimed.add(exact);
    targetByKey.set(key, exact);
  }

  // Pass 2 — the combo fallback, over whatever is still unclaimed.
  for (const { key, row } of staged) {
    if (targetByKey.has(key) || row.variacoesUid.length === 0) continue;
    const match = input.realChildren.find(
      (c) =>
        !claimed.has(c.id) &&
        c.variacoesUid.length > 0 &&
        sameCombo(c.variacoesUid, row.variacoesUid),
    );
    if (!match) continue;
    claimed.add(match.id);
    targetByKey.set(key, match.id);
  }

  // Emitted in `stagedByKey` order, independent of which pass resolved each row.
  return staged.flatMap(({ key, map }) => {
    const id = targetByKey.get(key);
    return id === undefined ? [] : [{ id, componentesKit: map }];
  });
}

import type { ComponentesKit } from '../collection/embedded/kit';
import { type GrupoComId, parseFakePath } from './variacoes';

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
  /**
   * Carried for `generateKitForVariacoes`, which matches on it.
   * {@link resolveStagedKitVariacoes} does NOT read it — resolution is by id.
   */
  variacoesUid: string[];
  deleteMark?: boolean;
}

/** A persisted variation child (after the parent + children flush). */
export interface RealKitChild {
  id: string;
  /** Same as {@link StagedKitRow.variacoesUid}: for the matcher, not the resolver. */
  variacoesUid: string[];
}

/** What {@link resolveStagedKitVariacoes} resolved, and what it could not. */
export interface ResolvedKitVariacoes {
  /** One write per resolved entry. `key` is the staged entry it came from. */
  writes: Array<{ key: string; id: string; componentesKit: ComponentesKit | null }>;
  /**
   * Staged keys that named a live variation but resolved to no document. The
   * caller MUST surface these: the map is not written, and silently dropping an
   * operator's work behind a success toast is what this return value exists to
   * prevent (root `CLAUDE.md` rule 7, tier 3). Deliberate drops — a delete-marked
   * row, or one the operator removed — are NOT listed.
   */
  unresolved: string[];
}

/**
 * Resolve the grid's staged per-row kit maps (keyed by `StagedKitRow.key`) to
 * concrete `{ id, componentesKit }` writes against the REAL variation children —
 * the bridge that lets "Gerar Variações" target variations added in the Variações
 * tab but not yet saved.
 *
 * Resolution is EXACT — every rung names a document id, none guesses:
 *  1. `resolvedByKey[key]`, the caller's `stagedKey → doc id` pairing, for a row
 *     whose document it wrote under a DIFFERENT id (the #117 SKU id reuse);
 *  2. `row.id`, when it names a live child (an already-saved row);
 *  3. the row's own `key`, which IS the doc id the caller pre-minted for this
 *     child (see {@link StagedKitRow.key}).
 *
 * ⚠️ Rung 1 is consulted BEFORE the row lookup and does not require the row to
 * still be there. That is the whole point of it: by the time this runs, the
 * children flush has normally already cleared the absorbed row from `rows`, so
 * demanding a row would drop the entry before any rung could fire — which is
 * exactly how the `sameCombo` fallback this replaced managed to be unreliable
 * even for the one case it existed to serve. No conflict is possible either,
 * because the flush never writes a document under an absorbed row's own key.
 *
 * ⚠️ There is deliberately NO combo fallback. Matching an unordered
 * `variacoesUid` set is a guess, and `componentesKit` is persisted as a FULL
 * overwrite, so a wrong guess silently replaces a sibling's kit. Its only
 * reachable case was the id reuse above, which rung 1 now answers exactly.
 * Anything that still fails to resolve is reported through `unresolved` rather
 * than aimed at whichever child happens to look similar.
 *
 * Each real child is claimed at most once; rows that are delete-marked, unknown,
 * or unmatched are dropped.
 */
export function resolveStagedKitVariacoes(input: {
  stagedByKey: Record<string, ComponentesKit | null>;
  rows: StagedKitRow[];
  realChildren: RealKitChild[];
  /**
   * `stagedKey → doc id` for rows the caller wrote under a different id than the
   * row's own key. `VariationManager`'s children flush returns exactly this.
   */
  resolvedByKey: Record<string, string>;
}): ResolvedKitVariacoes {
  const rowByKey = new Map(input.rows.map((r) => [r.key, r]));
  const realById = new Set(input.realChildren.map((c) => c.id));
  const claimed = new Set<string>();
  const writes: ResolvedKitVariacoes['writes'] = [];
  const unresolved: string[] = [];

  for (const [key, componentesKit] of Object.entries(input.stagedByKey)) {
    const paired = input.resolvedByKey[key];
    const row = rowByKey.get(key);

    // A row the operator deleted, or one that never belonged to this grid, is a
    // deliberate drop — not something to report at them. But a PAIRED key stays
    // in play even with no row: its document exists, the row just went away.
    if (paired === undefined && (row === undefined || row.deleteMark === true)) continue;

    const target = [paired, row?.id ?? undefined, key].find(
      (id): id is string => id !== undefined && realById.has(id) && !claimed.has(id),
    );
    if (target === undefined) {
      unresolved.push(key);
      continue;
    }
    claimed.add(target);
    writes.push({ key, id: target, componentesKit });
  }

  return { writes, unresolved };
}

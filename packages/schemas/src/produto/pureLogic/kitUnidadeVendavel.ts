import type { ComponentesKit, Kit } from '../collection/embedded/kit';

/**
 * Repoint a kit's `componentesKit` at the produtos that actually hold the stock.
 *
 * A kit's map is keyed by component **produto id**, and those ids were written
 * when a produto with no variations still owned its own estoque. After #1398 it
 * does not: the sellable unit is the sole member, and the parent is a wrapper
 * holding at most a reserved remainder. Only two of the ~fifteen component
 * readers resolve that hop for themselves — so the map itself has to name the
 * sellable unit, and then every reader agrees by construction.
 *
 * ## ⚠️ ONE implementation, two callers, on purpose
 *
 * The #1402 conversion script rewrites the corpus; the `onProdutoChanged`
 * cascade rewrites whatever is converted later (publish's `'adotar'` arm reshapes
 * an ML-linked produto long after the migration deliberately skipped it). Those
 * two run against the same documents inside the cutover window — a migration run
 * there DOES fire triggers — so they must compute the SAME target map, or
 * last-write-wins picks a winner between two answers. Sharing this function is
 * what makes that race benign instead of a coin flip, and it is why the collision
 * rule below cannot live in only one of them.
 *
 * ## ⚠️ The keys are sorted before folding, and that is load-bearing
 *
 * Two components can resolve onto ONE id — a kit listing a family-of-one parent
 * *and* its own sole member. Which entry is visited first then decides which
 * `timestamp` and which passthrough fields survive, and Firestore map ordering is
 * not a promise. Sorting makes the output a function of the input alone, which is
 * what lets the two callers converge and what makes a second run a no-op.
 */

/** One component id that moved. */
export interface ReaponteDeComponente {
  de: string;
  para: string;
}

/** Two or more component ids that folded onto one — see {@link reapontarComponentesKit}. */
export interface ColisaoDeComponente {
  alvo: string;
  /** The original keys involved, sorted. */
  de: string[];
  /** The summed `quantidade`, or `null` when the fold was REFUSED (mixed flags). */
  quantidadeSomada: number | null;
}

export interface PlanoDeReaponteKit {
  /** The map to store. Structurally identical to the input when `mudou` is false. */
  componentesKit: ComponentesKit | null;
  /** Re-derived from the map above — sorted, because it feeds an `array-contains`. */
  componentesKitKeys: string[] | null;
  /** Whether anything moved. `false` ⇒ write nothing. */
  mudou: boolean;
  movidos: ReaponteDeComponente[];
  /**
   * Every fold, including the REFUSED ones (`quantidadeSomada === null`). A
   * refusal leaves both entries where they were, so the caller must report it —
   * that kit still names a produto with no available stock and needs a human.
   */
  colisoes: ColisaoDeComponente[];
}

/** A well-formed entry, in the sense every stock reader already uses. */
function entradaValida(v: unknown): v is Kit {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const q = (v as Kit).quantidade;
  return typeof q === 'number' && Number.isFinite(q);
}

/**
 * Does this entry constrain — and therefore consume — the component's stock?
 *
 * `calcularAlteracoesEstoque` skips a `limitarEstoque: false` component outright
 * (`estoquePlan.ts:99`), so the flag decides both halves at once: such a
 * component neither caps availability nor is decremented on sale. That is exactly
 * why a mixed collision has no correct merge.
 */
const limita = (k: Kit): boolean => k.limitarEstoque !== false;

/**
 * ⛔ **A mixed collision is REFUSED, not merged.**
 *
 * The schema carries one `limitarEstoque` per key, so folding
 * `{limitarEstoque: false, quantidade: 5}` with `{limitarEstoque: true,
 * quantidade: 2}` has no correct answer: summing to 7 constrained units makes the
 * sale remove 7 where it must remove 2, while keeping only the 2 loses the 5
 * units the cost and weight rollups read. Both are silent, and neither is what
 * the operator wrote.
 *
 * So a mixed pair is left exactly as it is and reported. It needs a kit that
 * lists a parent *and* its own sole member with DIFFERENT flags, which is rare —
 * and a human choosing is strictly better than this function guessing.
 */
function fundir(entradas: readonly Kit[]): Kit | null {
  const [primeira] = entradas as readonly [Kit, ...Kit[]];
  if (entradas.length === 1) return primeira;
  const todosLimitam = entradas.every((e) => limita(e));
  const nenhumLimita = entradas.every((e) => !limita(e));
  if (!todosLimitam && !nenhumLimita) return null; // ⛔ mixed — see the docblock
  return {
    // The surviving entry keeps the FIRST key's `timestamp` and any passthrough
    // fields the migrated corpus carries — `timestamp` is deliberately outside
    // the kit fold everywhere else too (`mesmoComponentesKit`), because it
    // records when the entry was edited, not what the kit IS.
    ...primeira,
    quantidade: entradas.reduce((acc, e) => acc + e.quantidade, 0),
  };
}

/**
 * @param unidadeVendavelDe must be TOTAL — an id it cannot resolve maps to
 *   itself. A resolver answering `''` for an unknown produto would relocate a
 *   component onto an empty key, so the guard below refuses that rather than
 *   trusting the caller.
 */
export function reapontarComponentesKit(
  componentes: ComponentesKit | null | undefined,
  unidadeVendavelDe: (componenteId: string) => string,
): PlanoDeReaponteKit {
  const original = (componentes ?? {}) as Record<string, unknown>;
  const chaves = Object.keys(original).sort(); // ⚠️ see the module header
  if (chaves.length === 0) {
    return {
      componentesKit: componentes ?? null,
      componentesKitKeys: null,
      mudou: false,
      movidos: [],
      colisoes: [],
    };
  }

  // Group the original keys by where each one resolves to.
  const porAlvo = new Map<string, string[]>();
  for (const chave of chaves) {
    const bruto = unidadeVendavelDe(chave);
    // A resolver that answers with nothing leaves the component where it is:
    // moving stock onto an empty id is worse than not moving it at all.
    const alvo = typeof bruto === 'string' && bruto !== '' ? bruto : chave;
    porAlvo.set(alvo, [...(porAlvo.get(alvo) ?? []), chave]);
  }

  const saida: Record<string, unknown> = {};
  const movidos: ReaponteDeComponente[] = [];
  const colisoes: ColisaoDeComponente[] = [];

  for (const [alvo, origens] of porAlvo) {
    if (origens.length === 1) {
      const [origem] = origens as [string];
      saida[alvo] = original[origem];
      if (origem !== alvo) movidos.push({ de: origem, para: alvo });
      continue;
    }

    // ⚠️ Junk entries are invisible to every reader (`componentesKitEntries`
    // filters them), so they never win a fold — but they are not silently
    // dropped either: with no well-formed entry at all, every original key is
    // left where it is.
    const validas = origens
      .filter((o) => entradaValida(original[o]))
      .map((o) => original[o] as Kit);
    const fundida = validas.length > 0 ? fundir(validas) : null;

    if (fundida === null) {
      // ⛔ Refused. Every entry stays under its ORIGINAL key, untouched.
      colisoes.push({ alvo, de: origens, quantidadeSomada: null });
      for (const origem of origens) saida[origem] = original[origem];
      continue;
    }

    colisoes.push({ alvo, de: origens, quantidadeSomada: fundida.quantidade });
    saida[alvo] = fundida;
    for (const origem of origens) {
      if (origem !== alvo) movidos.push({ de: origem, para: alvo });
    }
  }

  const chavesNovas = Object.keys(saida).sort();
  // A fold changes the map even when no key "moved" in the `de !== para` sense
  // (two keys became one), so the key list is compared too.
  const mudou =
    movidos.length > 0 ||
    chavesNovas.length !== chaves.length ||
    chavesNovas.some((c, i) => c !== chaves[i]);

  return {
    componentesKit: saida as ComponentesKit,
    // Sorted and order-stable: the array feeds an `array-contains` query and
    // Firestore arrays are order-sensitive.
    componentesKitKeys: chavesNovas.length > 0 ? chavesNovas : null,
    mudou,
    movidos,
    colisoes,
  };
}

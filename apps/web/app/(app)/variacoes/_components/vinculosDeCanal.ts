/**
 * The channel-agnostic core of a grupo's per-channel variation links: how the
 * tab staging an array field marks its entries, what a save writes back, what
 * counts as edited, and how a conflicting save merges. Extracted from the Loja
 * Integrada linker (#1911 P14, D-6) so the Shopee linker runs the same machinery
 * instead of a second copy of it (the #1369 drift class). Neither channel's
 * vocabulary lives here; each instance names its own mark and its own key. No
 * React, no clock, no I/O.
 *
 * ## Untouched entries are written back exactly as stored
 *
 * A stored entry nobody touched is carried back as it is — valid or not, of an
 * active conta or not. Only an entry staged for removal, or one a conflict marked
 * `removido`, leaves the list; every mark comes off the rest.
 *
 * ## Edited or untouched: by VALUE, against the form's seed, failing closed
 *
 * An entry is untouched when it equals (`valuesEqual`: key set + recursive,
 * `null` ≠ absent, arrays positional) an entry of the field's SEED — what the
 * form was last reset to — each seed entry vouching for ONE entry. Anything else
 * is edited, and a seed not yet published makes every entry edited. Object
 * identity is never used: a form re-applies kept edits through clones, a staged
 * removal undone is a copy, and `validate` sees the prepared value.
 *
 * ## Transient marks
 *
 *  - `DELETE_MARK` (the app's staged deletion): the entry is dropped on save;
 *  - the instance's conflict mark: a conflict merge's note on an entry —
 *    `alterado` (both sides changed this link: the other side's version is kept,
 *    redo yours) is written as the other side left it; `removido` (the other
 *    side removed what you changed) is dropped, unless you edit it again.
 *
 * Every comparison here is exact: no case, trim or number↔string fold. The only
 * fold an instance can add is the one inside its own `chaveDe`.
 */
import {
  DELETE_MARK,
  valuesEqual,
  type ConflictRebaseInput,
  type ConflictRebaseResult,
} from '@delfrance/ui';

export const CONFLITO_VINCULO = {
  /** Both sides changed this link: the other side's version is kept. Redo yours. */
  alterado: 'alterado',
  /** The other side removed the link you changed: dropped on save unless you edit it again. */
  removido: 'removido',
} as const;
export type ConflitoVinculo = (typeof CONFLITO_VINCULO)[keyof typeof CONFLITO_VINCULO];

export type Registro = Record<string, unknown>;

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
export function ehObjeto(v: unknown): v is Registro {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
export function proprio(o: Registro, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/**
 * The form's seed for a linker: the values its two fields were last reset to.
 * Published by the tab; `null` (never published) fails closed everywhere.
 */
export interface SeedDeVinculos {
  readonly links: unknown;
  readonly variacoes: unknown;
}

/** The ids of a `variacoes` value, minus any staged for deletion. Exact, no fold. */
export function idsDasVariantes(variacoes: unknown): string[] {
  if (!Array.isArray(variacoes)) return [];
  const lista: readonly unknown[] = variacoes;
  const ids: string[] = [];
  for (const v of lista) {
    if (!ehObjeto(v) || proprio(v, DELETE_MARK) === true) continue;
    const id = proprio(v, 'id');
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/** `id → nome` over one or more `variacoes` values; the first name wins. */
export function nomesDasVariantes(...listas: unknown[]): Map<string, string> {
  const nomes = new Map<string, string>();
  for (const variacoes of listas) {
    if (!Array.isArray(variacoes)) continue;
    const lista: readonly unknown[] = variacoes;
    for (const v of lista) {
      if (!ehObjeto(v)) continue;
      const id = proprio(v, 'id');
      const nome = proprio(v, 'nome');
      if (typeof id === 'string' && typeof nome === 'string' && nome !== '' && !nomes.has(id))
        nomes.set(id, nome);
    }
  }
  return nomes;
}

/**
 * The field's value once a NEW (unsaved) entry was deleted from it (#1787). An
 * empty list goes back to the field's SEED when the seed says "nothing" (`null`,
 * `undefined` or `[]`, whichever it was), so the form reads as pristine: a fresh
 * `[]` over an absent key is dirty for ever. A seed that HOLDS something is never
 * brought back by emptying the list, and a seed that is not a list stays replaced.
 */
export function valorAposEsvaziar(lista: readonly unknown[], seed: unknown): unknown {
  if (lista.length > 0) return lista;
  if (seed === null || seed === undefined) return seed;
  return Array.isArray(seed) && seed.length === 0 ? seed : lista;
}

function comoLista(v: unknown): readonly unknown[] | null {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : null;
}

export interface OpcoesDoNucleoDeVinculos {
  /** The transient key a conflict merge sets on an entry of this channel. */
  readonly marcaConflito: string;
  /**
   * Where an element that is NOT an object waits while staged for removal: it is
   * wrapped as `{ [DELETE_MARK]: true, [chaveValorIlegivel]: elemento }`, and the
   * undo unwraps it. A save drops the wrapper with the rest of the marked entries.
   */
  readonly chaveValorIlegivel: string;
  /**
   * The string key a conflict merge groups by, or `null` when the object names
   * none. Receives the entry as it would be STORED (no marks).
   */
  readonly chaveDe: (entrada: Registro) => string | null;
}

export interface NucleoDeVinculos {
  /** Whether the operator staged this entry for removal. */
  readonly removidaNoFormulario: (entrada: unknown) => boolean;
  /** The conflict merge's note on an entry, or `null`. */
  readonly marcaDeConflito: (entrada: unknown) => ConflitoVinculo | null;
  /**
   * The entry as it would be STORED: every mark stripped (a copy only when there
   * was one), a wrapped non-object element unwrapped. Anything else is returned
   * as the very same value.
   */
  readonly normalizarEntrada: (entrada: unknown) => unknown;
  /**
   * {@link NucleoDeVinculos.preparar} plus, for each written entry, its index in
   * the form's value — so a finding on the written list can be shown on the form's.
   */
  readonly prepararComOrigem: (valor: unknown) => {
    readonly lista: unknown[];
    readonly origem: number[];
  };
  /**
   * The field's `prepareForSave`: drops the entries staged for removal (and the
   * `removido` ones), strips every mark from the rest. An entry that carries no
   * mark is written back as the very same object. A value that is not a list
   * passes through (the schema reports it).
   */
  readonly preparar: (valor: unknown) => unknown;
  /**
   * The indices of `lista` (a WRITTEN list: no marks) that this save creates or
   * changes, decided BY VALUE: an entry equal to an unused seed entry is
   * untouched, and consumes it. `seed === null` ⇒ every index (fail closed).
   */
  readonly editadasPorValor: (
    lista: readonly unknown[],
    seed: Pick<SeedDeVinculos, 'links'> | null,
  ) => Set<number>;
  /** Stage the element at `indice` for removal, or undo it: a NEW list. */
  readonly alternarRemocao: (lista: readonly unknown[], indice: number) => unknown[];
  /** The element at `indice` replaced by `nova`: a NEW list. */
  readonly substituirEntrada: (
    lista: readonly unknown[],
    indice: number,
    nova: unknown,
  ) => unknown[];
  /**
   * The field's `rebaseOnConflict` merge (ADR 0011 tier 3): the server's list is
   * the base, and every link the operator added, changed or staged for removal —
   * by value against `loaded`, keyed by `chaveDe` — is re-applied on it. Never
   * either side wholesale.
   *
   * Per key: only the operator changed it ⇒ theirs; only the server ⇒ the
   * server's; both, the same way ⇒ the server's; both, differently ⇒ COLLIDED: the
   * server's version is kept, marked `alterado` — or, when the server removed it,
   * the operator's version is shown marked `removido` and dropped on save unless
   * redone. A key held twice on either side is one block, compared whole.
   *
   * Key-less legacy entries (a half-made link) can only be staged for removal
   * here: that removal is re-applied while the server still holds the same entry,
   * and moot when it does not.
   */
  readonly rebasePorChave: (input: ConflictRebaseInput) => ConflictRebaseResult;
}

/** One instance per channel: its conflict mark, its wrapper key and its merge key. */
export function criarNucleoDeVinculos({
  marcaConflito,
  chaveValorIlegivel,
  chaveDe,
}: OpcoesDoNucleoDeVinculos): NucleoDeVinculos {
  /** The marks this instance or the app may set on an entry. */
  const marcas = [DELETE_MARK, marcaConflito] as const;

  function removidaNoFormulario(entrada: unknown): boolean {
    return ehObjeto(entrada) && proprio(entrada, DELETE_MARK) === true;
  }

  function marcaDeConflito(entrada: unknown): ConflitoVinculo | null {
    if (!ehObjeto(entrada)) return null;
    const marca = proprio(entrada, marcaConflito);
    return marca === CONFLITO_VINCULO.alterado || marca === CONFLITO_VINCULO.removido
      ? marca
      : null;
  }

  function normalizarEntrada(entrada: unknown): unknown {
    if (!ehObjeto(entrada)) return entrada;
    if (Object.hasOwn(entrada, chaveValorIlegivel)) return entrada[chaveValorIlegivel];
    if (!marcas.some((m) => Object.hasOwn(entrada, m))) return entrada;
    const copia: Registro = { ...entrada };
    for (const m of marcas) delete copia[m];
    return copia;
  }

  /** Whether a save drops this entry: staged for removal, or `removido` by a conflict. */
  function descartadaNaGravacao(entrada: unknown): boolean {
    return removidaNoFormulario(entrada) || marcaDeConflito(entrada) === CONFLITO_VINCULO.removido;
  }

  function prepararComOrigem(valor: unknown): {
    readonly lista: unknown[];
    readonly origem: number[];
  } {
    const lista: unknown[] = [];
    const origem: number[] = [];
    if (!Array.isArray(valor)) return { lista, origem };
    const elementos: readonly unknown[] = valor;
    elementos.forEach((e, i) => {
      if (descartadaNaGravacao(e)) return;
      lista.push(normalizarEntrada(e));
      origem.push(i);
    });
    return { lista, origem };
  }

  function preparar(valor: unknown): unknown {
    return Array.isArray(valor) ? prepararComOrigem(valor).lista : valor;
  }

  function editadasPorValor(
    lista: readonly unknown[],
    seed: Pick<SeedDeVinculos, 'links'> | null,
  ): Set<number> {
    const editadas = new Set<number>();
    const guardadas: readonly unknown[] =
      seed !== null && Array.isArray(seed.links) ? seed.links : [];
    const usadas = guardadas.map(() => false);
    lista.forEach((entrada, i) => {
      if (seed === null) {
        editadas.add(i);
        return;
      }
      const j = guardadas.findIndex((g, k) => !usadas[k] && valuesEqual(g, entrada));
      if (j < 0) editadas.add(i);
      else usadas[j] = true;
    });
    return editadas;
  }

  /**
   * Undo a staged removal: only what the removal ADDED goes — the staged mark, or
   * the wrapper of a non-object element. A conflict merge's note stays: an undo is
   * not an edit, so a `removido` link is still dropped on save, and an `alterado`
   * one still says so.
   */
  function desfazerRemocao(entrada: Registro): unknown {
    if (Object.hasOwn(entrada, chaveValorIlegivel)) return entrada[chaveValorIlegivel];
    const copia: Registro = { ...entrada };
    delete copia[DELETE_MARK];
    return copia;
  }

  function alternarRemocao(lista: readonly unknown[], indice: number): unknown[] {
    return lista.map((e, i) => {
      if (i !== indice) return e;
      if (ehObjeto(e) && removidaNoFormulario(e)) return desfazerRemocao(e);
      return ehObjeto(e)
        ? { ...e, [DELETE_MARK]: true }
        : { [DELETE_MARK]: true, [chaveValorIlegivel]: e };
    });
  }

  function substituirEntrada(lista: readonly unknown[], indice: number, nova: unknown): unknown[] {
    return lista.map((e, i) => (i === indice ? nova : e));
  }

  /** The key of an element, or `null` when it has none. */
  function chaveDoVinculo(entrada: unknown): string | null {
    const n = normalizarEntrada(entrada);
    return ehObjeto(n) ? chaveDe(n) : null;
  }

  function semNotaDeConflito(e: Registro): Registro {
    const copia = { ...e };
    delete copia[marcaConflito];
    return copia;
  }

  /** Same entries, in order — a staged removal counts, a conflict's note does not. */
  function mesmasEntradas(a: readonly unknown[], b: readonly unknown[]): boolean {
    return (
      a.length === b.length &&
      a.every((e, i) => {
        const semNota = ehObjeto(e) && marcaDeConflito(e) !== null ? semNotaDeConflito(e) : e;
        return valuesEqual(semNota, b[i]);
      })
    );
  }

  function comNota(entrada: unknown, nota: ConflitoVinculo): unknown {
    const n = normalizarEntrada(entrada);
    return ehObjeto(n) ? { ...n, [marcaConflito]: nota } : n;
  }

  function agruparPorChave(lista: readonly unknown[]): Map<string, unknown[]> {
    const porChave = new Map<string, unknown[]>();
    for (const e of lista) {
      const k = chaveDoVinculo(e);
      if (k === null) continue;
      const doGrupo = porChave.get(k) ?? [];
      doGrupo.push(e);
      porChave.set(k, doGrupo);
    }
    return porChave;
  }

  function rebasePorChave({ loaded, server, mine }: ConflictRebaseInput): ConflictRebaseResult {
    const carregada = comoLista(loaded);
    const doServidor = comoLista(server);
    const minha = comoLista(mine);
    if (doServidor === null || carregada === null || minha === null) {
      // A value that is not a list cannot be merged: keep the server's, and stop.
      return { value: server, collided: true };
    }
    // A `removido` note is already the server's version (absent): not a change.
    const meus = minha.filter((e) => marcaDeConflito(e) !== CONFLITO_VINCULO.removido);
    const L = agruparPorChave(carregada);
    const S = agruparPorChave(doServidor);
    const M = agruparPorChave(meus);
    let collided = false;

    const blocoDaChave = (k: string): unknown[] => {
      const l = L.get(k) ?? [];
      const s = S.get(k) ?? [];
      const m = M.get(k) ?? [];
      if (mesmasEntradas(m, l)) return s;
      if (mesmasEntradas(s, l)) return m;
      if (mesmasEntradas(preparar(m) as unknown[], s)) return s;
      collided = true;
      if (s.length > 0) return s.map((e) => comNota(e, CONFLITO_VINCULO.alterado));
      return m
        .filter((e) => !removidaNoFormulario(e))
        .map((e) => comNota(e, CONFLITO_VINCULO.removido));
    };

    const saida: unknown[] = [];
    const tratadas = new Set<string>();
    for (const e of doServidor) {
      const k = chaveDoVinculo(e);
      if (k === null) {
        saida.push(e);
        continue;
      }
      if (tratadas.has(k)) continue;
      tratadas.add(k);
      saida.push(...blocoDaChave(k));
    }
    for (const k of M.keys()) {
      if (tratadas.has(k)) continue;
      tratadas.add(k);
      saida.push(...blocoDaChave(k));
    }

    // Key-less entries: the operator's staged removals, by value.
    const semChaveCarregadas = carregada.filter((e) => chaveDoVinculo(e) === null);
    const usadas = semChaveCarregadas.map(() => false);
    const consumir = (valor: unknown): boolean => {
      const j = semChaveCarregadas.findIndex((c, k) => !usadas[k] && valuesEqual(c, valor));
      if (j < 0) return false;
      usadas[j] = true;
      return true;
    };
    const substituidas = new Set<number>();
    for (const e of meus) {
      if (chaveDoVinculo(e) !== null) continue;
      const valor = normalizarEntrada(e);
      const conhecida = consumir(valor);
      if (!removidaNoFormulario(e)) {
        if (!conhecida) saida.push(e);
        continue;
      }
      const i = saida.findIndex(
        (s, k) => !substituidas.has(k) && chaveDoVinculo(s) === null && valuesEqual(s, valor),
      );
      if (i >= 0) {
        saida[i] = e;
        substituidas.add(i);
      }
    }

    const value = saida.length === 0 && !Array.isArray(server) ? (server ?? null) : saida;
    return { value, collided };
  }

  return {
    removidaNoFormulario,
    marcaDeConflito,
    normalizarEntrada,
    prepararComOrigem,
    preparar,
    editadasPorValor,
    alternarRemocao,
    substituirEntrada,
    rebasePorChave,
  };
}

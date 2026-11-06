/**
 * The cut that turns a whole `get_category` body into a committable fixture
 * (#1911) — test-only, beside `redact.ts`, and like it imported by no `src`
 * file.
 *
 * The BR tree is ~2 000 rows, and the corpus needs only the paths to the leaves
 * it captured. So the cut keeps exactly:
 *
 * - every row that is an ANCESTOR-OR-SELF of a requested leaf — walking
 *   `parent_category_id` up to `0` — so every leaf still resolves a full
 *   `pathFromRoot`;
 * - **plus every ROOT** (`parent_category_id === 0`), so a reader's root list
 *   (`raizes()`) still answers the whole first level, not just the captured
 *   branches.
 *
 * Nothing else: a SIBLING of a path node is not kept, and neither is any other
 * non-root row. Rows keep Shopee's ORDER, and everything outside
 * `response.category_list` — the envelope (`error`, `message`, `warning`,
 * `debug_message`) and any other `response` key — is copied verbatim. The input
 * is never mutated.
 *
 * ⚠️ **It fails CLOSED, never into a smaller cut.** A body that is not a tree is
 * refused with {@link ErroDeCorteDeCategorias} rather than cut around: a
 * requested leaf absent from the list, a duplicate `category_id`, a non-root
 * parent missing from the list, a parent cycle, or a row/envelope that is not
 * the documented shape (a non-integer id, or a `category_id` of `0` — the root
 * sentinel — included). The whole list is checked,
 * not only the kept paths — the cut's promise is "the paths of a TREE", and a
 * dangling or cyclic row anywhere says the input is not one.
 *
 * ⚠️ **Idempotent by construction**: every kept non-root row's parent is kept
 * (it is an ancestor of the same leaf), every root is kept, and every requested
 * leaf is kept, so the cut is itself a valid tree holding the same leaves and
 * the same roots — cutting it again keeps every row.
 */
import type { WireValue } from './redact';

/** A body the cut refuses — named, so a test can tell it from any other throw. */
export class ErroDeCorteDeCategorias extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErroDeCorteDeCategorias';
  }
}

type Objeto = { readonly [key: string]: WireValue };

function ehObjeto(valor: WireValue | undefined): valor is Objeto {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * An id field as a non-negative integer — `category_id` must also be POSITIVE,
 * since `0` is the root sentinel a parent pointer uses, never a category.
 */
function idInteiro(linha: Objeto, campo: string, indice: number, minimo: 0 | 1): number {
  const valor = linha[campo];
  if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < minimo) {
    throw new ErroDeCorteDeCategorias(
      `response.category_list.${String(indice)}.${campo} não é um inteiro >= ${String(minimo)}.`,
    );
  }
  return valor;
}

/**
 * Cut a `get_category` body down to the paths of `folhas` plus every root. See
 * the module docblock for what is kept and for every refusal.
 */
export function cortarArvoreDeCategorias(corpo: WireValue, folhas: readonly number[]): WireValue {
  if (!ehObjeto(corpo)) throw new ErroDeCorteDeCategorias('o corpo não é um objeto.');
  const response = corpo.response;
  if (!ehObjeto(response)) throw new ErroDeCorteDeCategorias('`response` não é um objeto.');
  const lista = response.category_list;
  if (!Array.isArray(lista)) {
    throw new ErroDeCorteDeCategorias('`response.category_list` não é uma lista.');
  }

  // id → parent, over the WHOLE list.
  const paiDe = new Map<number, number>();
  const ids: number[] = [];
  lista.forEach((linha, indice) => {
    if (!ehObjeto(linha)) {
      throw new ErroDeCorteDeCategorias(
        `response.category_list.${String(indice)} não é um objeto.`,
      );
    }
    const id = idInteiro(linha, 'category_id', indice, 1);
    const pai = idInteiro(linha, 'parent_category_id', indice, 0);
    if (paiDe.has(id)) {
      throw new ErroDeCorteDeCategorias(`category_id ${String(id)} aparece mais de uma vez.`);
    }
    paiDe.set(id, pai);
    ids.push(id);
  });

  // Every non-root parent present, over the WHOLE list.
  for (const id of ids) {
    const pai = paiDe.get(id)!;
    if (pai !== 0 && !paiDe.has(pai)) {
      throw new ErroDeCorteDeCategorias(
        `a categoria ${String(id)} aponta para o pai ${String(pai)}, que não está na lista.`,
      );
    }
  }

  // No cycle, over the WHOLE list: every chain must reach `0`. A chain longer
  // than the list itself has revisited a row.
  const chegaNaRaiz = new Set<number>();
  for (const inicio of ids) {
    const caminho: number[] = [];
    let atual = inicio;
    while (atual !== 0 && !chegaNaRaiz.has(atual)) {
      if (caminho.includes(atual)) {
        throw new ErroDeCorteDeCategorias(
          `ciclo de parent_category_id passando pela categoria ${String(atual)}.`,
        );
      }
      caminho.push(atual);
      atual = paiDe.get(atual)!;
    }
    for (const id of caminho) chegaNaRaiz.add(id);
  }

  // The kept set: every root, plus every ancestor-or-self of a requested leaf.
  const mantidos = new Set<number>(ids.filter((id) => paiDe.get(id) === 0));
  for (const folha of folhas) {
    if (!paiDe.has(folha)) {
      throw new ErroDeCorteDeCategorias(`a folha ${String(folha)} não está na lista.`);
    }
    for (let atual = folha; atual !== 0; atual = paiDe.get(atual)!) mantidos.add(atual);
  }

  const cortada = lista.filter((_, indice) => mantidos.has(ids[indice]!));
  return { ...corpo, response: { ...response, category_list: cortada } };
}

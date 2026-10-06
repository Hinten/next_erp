import { z } from 'zod';

/**
 * The `tabMedi` doc's `tabelasMedidasShopee` map (step 18, #1526) — the Shopee
 * twin of `tabelaDeMedidasMercadoLivre.ts`: the stored entry shape, a READ slice
 * over one conta's list, and THE rule that picks a listing's entry.
 *
 * The map is keyed by **integração doc id**; each value is that conta's LIST of
 * picks, one per Shopee category, in the legacy corpus shape
 * `{ categoryId, size_chart_id, name }` (`TabelaDeMedidasShopee`,
 * `.old/…/tabelaMedidas/lib/src/models.dart:809-835`). The base
 * `tabelaDeMedidasSchema` keeps the field loose (`z.unknown()` per key) on
 * purpose; this module is what every reader goes through.
 *
 * ⚠️ ONE selection rule (#1369). `resolverEntradaShopee` is what publish
 * (`apps/shopee`'s `montarAnuncio`) AND the `/medidas` Shopee panel (`apps/web`)
 * both call. Never re-implement "the first entry of the category" on either
 * surface: two copies drift toward plausible, and reviewers cannot diff them by
 * eye. Pure and total — no clock, no network, no Firestore — which is what lets
 * it live here, where both surfaces can reach it.
 *
 * ⚠️ The read is RAW-INDEXED. `linhas` carries one row per STORED element,
 * unreadable ones included, and every `indice` is that element's position in the
 * stored list — never a position in a filtered list. #1369's second drift was
 * exactly a fallback keyed on the filtered list where the resolver keyed on the
 * raw one; the web's staged edits address elements by this index.
 *
 * ⚠️ No fold. A digit-string id (`'400055'`) is UNREADABLE here, not equal to
 * `400055`: the legacy model read `json['size_chart_id'] as num` and refused
 * anything else on save, so a string in the corpus is a foreign writer, not a
 * legacy shape. The wire's string → number fold lives in the package's list-row
 * reader, where the string actually arrives — one fold, one scope.
 */

/**
 * One entry of `tabMedi.tabelasMedidasShopee[<integracaoId>]` — the LEGACY CORPUS
 * SHAPE, exactly three keys. This is the WRITE side: strict, so an extra key
 * (`_pendingDelete` included) is our bug, never data.
 *
 * ⚠️ `name` is the CATEGORY's display name at pick time (legacy
 * `medidasCadastro.dart:2302-2317`, possibly "(Cópia) …"), NOT the size chart's.
 */
export const entradaTabelaShopeeSchema = z.strictObject({
  categoryId: z.number().int().positive(),
  // ⚠️ positive: `0` is `add_item`/`update_item`'s DETACH sentinel — a stored 0
  // would remove the listing's chart at publish. `.int()` also caps at
  // MAX_SAFE_INTEGER (Zod 4), so an id that lost precision is refused too.
  size_chart_id: z.number().int().positive(),
  // `''` accepted — corpus parity (the legacy model never refused it).
  name: z.string(),
});
export type EntradaTabelaShopee = z.infer<typeof entradaTabelaShopeeSchema>;

/** Why one stored element could not be read. Never carries the raw value. */
export type MotivoEntradaShopeeIlegivel =
  | 'entrada-invalida'
  | 'categoria-invalida'
  | 'tabela-invalida'
  | 'nome-invalido';
export const MOTIVO_ENTRADA_SHOPEE_ILEGIVEL = {
  /** Not a plain object (`null`, an array, a primitive). */
  entradaInvalida: 'entrada-invalida',
  /** `categoryId` is not a positive safe-integer NUMBER. */
  categoriaInvalida: 'categoria-invalida',
  /** `size_chart_id` is not a positive safe-integer NUMBER (`0` included). */
  tabelaInvalida: 'tabela-invalida',
  /** `name` is not a string. */
  nomeInvalido: 'nome-invalido',
} as const satisfies Record<string, MotivoEntradaShopeeIlegivel>;

/** What this conta's slot of the map holds, before reading its elements. */
export type EstadoListaShopee = 'sem-lista' | 'lista' | 'campo-invalido' | 'lista-invalida';
export const ESTADO_LISTA_SHOPEE = {
  /** No map, no OWN key for this conta, or a `null` per-key value. */
  semLista: 'sem-lista',
  /** An array — read element by element. */
  lista: 'lista',
  /** The map itself is not a plain object. */
  campoInvalido: 'campo-invalido',
  /** This conta's value is neither `null` nor an array. */
  listaInvalida: 'lista-invalida',
} as const satisfies Record<string, EstadoListaShopee>;

/** One STORED element of a conta's list, readable or not; `indice` = its RAW position. */
export type LinhaEntradaShopee =
  | { readonly indice: number; readonly entrada: EntradaTabelaShopee; readonly motivo: null }
  | {
      readonly indice: number;
      readonly entrada: null;
      readonly motivo: MotivoEntradaShopeeIlegivel;
    };

export interface LeituraEntradasShopee {
  readonly estado: EstadoListaShopee;
  /** One per RAW element of this conta's list, stored order; `indice` = RAW position. [] unless estado 'lista'. */
  readonly linhas: readonly LinhaEntradaShopee[];
}

/** The rows a readable linha narrows to. */
type LinhaLegivel = Extract<LinhaEntradaShopee, { readonly motivo: null }>;

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only — an inherited one is not stored data. */
function proprio(o: Record<string, unknown>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

// Each field is judged by the WRITE schema's own field — one rule, no second copy.
const CAMPOS = entradaTabelaShopeeSchema.shape;

function lerLinha(elemento: unknown, indice: number): LinhaEntradaShopee {
  if (!ehObjeto(elemento)) {
    return { indice, entrada: null, motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.entradaInvalida };
  }
  const categoryId = CAMPOS.categoryId.safeParse(proprio(elemento, 'categoryId'));
  if (!categoryId.success) {
    return { indice, entrada: null, motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.categoriaInvalida };
  }
  const sizeChartId = CAMPOS.size_chart_id.safeParse(proprio(elemento, 'size_chart_id'));
  if (!sizeChartId.success) {
    return { indice, entrada: null, motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.tabelaInvalida };
  }
  const name = CAMPOS.name.safeParse(proprio(elemento, 'name'));
  if (!name.success) {
    return { indice, entrada: null, motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.nomeInvalido };
  }
  // Rebuilt as EXACTLY the three keys: an extra stored key (a stray
  // `_pendingDelete`, a foreign writer's field) never reaches a reader.
  return {
    indice,
    entrada: { categoryId: categoryId.data, size_chart_id: sizeChartId.data, name: name.data },
    motivo: null,
  };
}

/**
 * READ slice of one conta's list. `campo` is `unknown` on purpose: a base-parse
 * failure hands readers the RAW doc. Pure, total, never throws.
 *
 * - `campo` `null`/`undefined` → `sem-lista`; not a plain object → `campo-invalido`;
 * - no OWN key `integracaoId` → `sem-lista` (so `'__proto__'`, `'constructor'`,
 *   `'toString'` read as absent); a `null`/`undefined` value → `sem-lista` (the
 *   legacy reader's own tolerance); a non-array value → `lista-invalida`;
 * - else `lista`, one linha per element. One bad element never costs its
 *   neighbours (unlike the ML slice's whole-list `safeParse → []`).
 */
export function lerEntradasShopeeDaConta(
  campo: unknown,
  integracaoId: string,
): LeituraEntradasShopee {
  if (campo === null || campo === undefined) {
    return { estado: ESTADO_LISTA_SHOPEE.semLista, linhas: [] };
  }
  if (!ehObjeto(campo)) return { estado: ESTADO_LISTA_SHOPEE.campoInvalido, linhas: [] };
  const lista = proprio(campo, integracaoId);
  if (lista === null || lista === undefined) {
    return { estado: ESTADO_LISTA_SHOPEE.semLista, linhas: [] };
  }
  if (!Array.isArray(lista)) return { estado: ESTADO_LISTA_SHOPEE.listaInvalida, linhas: [] };
  // `Array.from`, not `.map`: a hole reads as `undefined` (→ `entrada-invalida`)
  // instead of staying a hole in the output.
  return {
    estado: ESTADO_LISTA_SHOPEE.lista,
    linhas: Array.from(lista as readonly unknown[], (elemento, indice) =>
      lerLinha(elemento, indice),
    ),
  };
}

/** The ONE loop both exported entry points share. */
function primeiraLinhaDaCategoria(
  linhas: readonly LinhaEntradaShopee[],
  categoryId: number,
): LinhaLegivel | null {
  for (const linha of linhas) {
    if (linha.motivo === null && linha.entrada.categoryId === categoryId) return linha;
  }
  return null;
}

/**
 * THE selection rule (legacy `getTableaDeMedidasShopee`: the first entry whose
 * `categoryId ==`). Returns the `indice` of the first READABLE linha with
 * `entrada.categoryId === categoryId`, else -1. Keys on `categoryId` ALONE —
 * never on `size_chart_id` or `name`. Works on any subsequence of linhas (the
 * panel passes the non-marked ones): the index returned is the linha's OWN, never
 * a position in the array passed in.
 */
export function indiceDaEntradaShopee(
  linhas: readonly LinhaEntradaShopee[],
  categoryId: number,
): number {
  return primeiraLinhaDaCategoria(linhas, categoryId)?.indice ?? -1;
}

/** Why a listing gets no entry. */
export type MotivoSemTabelaShopee =
  | 'anuncio-sem-categoria'
  | 'conta-sem-entradas'
  | 'categoria-sem-entrada';
export const MOTIVO_SEM_TABELA_SHOPEE = {
  anuncioSemCategoria: 'anuncio-sem-categoria',
  contaSemEntradas: 'conta-sem-entradas',
  categoriaSemEntrada: 'categoria-sem-entrada',
} as const satisfies Record<string, MotivoSemTabelaShopee>;

export type ResolucaoEntradaShopee =
  | { readonly motivo: null; readonly indice: number; readonly entrada: EntradaTabelaShopee }
  | { readonly motivo: MotivoSemTabelaShopee; readonly indice: -1; readonly entrada: null };

/**
 * The ONE composition publish (`montarAnuncio`) and the `/medidas` panel both
 * call. Precedence: `categoryId` null → `anuncio-sem-categoria`; no readable
 * linha → `conta-sem-entradas`; no readable linha of that category →
 * `categoria-sem-entrada`; else the entry and its RAW index.
 */
export function resolverEntradaShopee(
  leitura: LeituraEntradasShopee,
  categoryId: number | null,
): ResolucaoEntradaShopee {
  if (categoryId == null) {
    return { motivo: MOTIVO_SEM_TABELA_SHOPEE.anuncioSemCategoria, indice: -1, entrada: null };
  }
  if (!leitura.linhas.some((linha) => linha.motivo === null)) {
    return { motivo: MOTIVO_SEM_TABELA_SHOPEE.contaSemEntradas, indice: -1, entrada: null };
  }
  const linha = primeiraLinhaDaCategoria(leitura.linhas, categoryId);
  if (linha === null) {
    return { motivo: MOTIVO_SEM_TABELA_SHOPEE.categoriaSemEntrada, indice: -1, entrada: null };
  }
  return { motivo: null, indice: linha.indice, entrada: linha.entrada };
}

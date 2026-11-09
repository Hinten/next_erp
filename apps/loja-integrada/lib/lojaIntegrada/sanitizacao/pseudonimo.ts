/**
 * Keyed pseudonyms for the catalogue ids of a fixture.
 *
 * The `fixture` profile keeps Loja Integrada's own numeric ids on the catalogue
 * class (categories, brands, grades and their options, products): a test keys a
 * row by its id, and a category's `categoria_pai` names another row by URI. Those
 * numbers are the stores' real resource ids, and the corpus is public. So the
 * sanitizer replaces each one with a PSEUDONYM that keeps every relation intact:
 *
 * ```
 * fake = 100 000 000 000 + (first 6 bytes of HMAC-SHA256(key, "li-fixture-id:" + id)) mod 900 000 000 000
 * ```
 *
 * - **One namespace.** The same real number always gives the same fake, whatever
 *   resource it names and wherever it sits (an `id`, a resource URI, the request
 *   path), across files and stores: a grade read as `id` in its detail, as a row
 *   of the grade list, in an option's `/grades/<g>` and in its
 *   `/grade/<g>/variacao/<v>` stays one grade; a category row and every
 *   `categoria_pai` naming it stay one category.
 * - **Keyed.** Without the key, a fake says nothing about the id behind it (a
 *   plain hash of a 4- to 9-digit number would be reversed by enumeration). The
 *   key is 32 random bytes in `.chave-fixtures`, in the capture folder; this
 *   module only receives it as data, and {@link ChaveDeFixturesLi} never prints it.
 * - **Deterministic.** The same key and the same capture give the same bytes, and a
 *   `--so` subset gives the same ids as a full run.
 * - **Canonical 12-digit safe integers.** Never a leading zero; the range is
 *   pinned by `wireCorpus.test.ts`. Twelve, because no real id comes near it
 *   (categories, brands, grades and options have 4 to 8 digits, products and
 *   images up to 9), and because it is neither 11 nor 14, the lengths the
 *   check-digit scan reads as a CPF or a CNPJ. Two different ids may share a fake
 *   (a collision, about one in 900 billion per pair): {@link PseudonimosLi} counts
 *   it and the run refuses (`colisao-de-pseudonimo`); the remedy is a new key and
 *   a re-run of every catalogue pair.
 * - **No real id inside the range.** A real id that already had 12 digits would
 *   read as a pseudonym, and the corpus test's range check could no longer tell
 *   one that leaked unmapped from a mapped one. {@link PseudonimosLi} counts every
 *   real id it maps that lies in the range, whatever resource it names, and the
 *   pair is refused (`id-real-na-faixa-do-pseudonimo`, printing no value); the
 *   remedy is a range of a length no real id has, and every catalogue fixture
 *   regenerated under the same key. That refusal is what makes the range check
 *   sound: every real id the sanitizer has mapped lies outside the range, so one
 *   of those kinds that leaked unmapped would fall outside it too.
 *
 * WHAT is mapped, and nothing else (only for the `catalogo` class, only in the
 * `fixture` profile; the logger never sees this module):
 *
 * 1. a number (or a digit-only string) under a key named `id` or ending in `_id`
 *    (`imagem_id`) that the profile KEPT (a leaf it faked stays its fake);
 * 2. every digit-only segment of a string the profile kept under a leaf whose
 *    predicate is `uriRecurso` and that passes it — the id positions of
 *    `/v1/categoria/7`, `/api/v1/grades/6062`, `/api/v1/grade/6062/variacao/31`;
 * 3. every id segment of the request path (`/v1/grades/6062/`), each id of a
 *    `/set/41;42` subset included: the path redactor keeps that segment whole;
 * 4. the value of an id query key ({@link CHAVES_DE_ID_NA_QUERY_LI}: `produto`) in
 *    the request query, and the path ids and id query values of `meta.next` and
 *    `meta.previous` (`/api/v1/produto_imagem/?limit=1&offset=1&produto=<id>`);
 * 5. every SKU: a kept string under a leaf whose predicate is `sku` (a product
 *    row's or detail's `sku`), and the `sku=` value of the request query and of
 *    `meta.next`/`meta.previous` — see "SKUs" below.
 *
 * Meta numbers (`limit`, `offset`, `total_count`) and every other query value
 * (`limit`, `offset`, a date) are never touched: they carry no store's resource
 * id, and tests rely on them. Only a 2xx body is walked: an error body follows
 * the error walk's own rule, and `capturaParaFixture` refuses a catalogue one
 * that keeps a number.
 *
 * ## SKUs
 *
 * A storefront prints a product's SKU on its public page, so a real SKU is a
 * search away from naming the store. A catalogue fixture therefore carries a
 * keyed pseudonym of each SKU, built character by character:
 *
 * ```
 * n(i)   = first 6 bytes of HMAC-SHA256(key, "li-fixture-sku:" + upper(sku[0..i-1]))
 * digit  → (d + 1 + n(i) mod 9) mod 10
 * letter → (l + 1 + n(i) mod 25) mod 26, in its own case
 * other  → kept
 * ```
 *
 * - **Prefix-preserving.** Position i depends only on the SKU before it, so a
 *   variation whose SKU is its parent's plus a suffix keeps exactly that
 *   relation, in every file and both stores, with no knowledge of which row is
 *   the parent. The same suffix under two parents maps differently.
 * - **Shape-preserving.** Same length, a digit stays a digit and a letter a
 *   letter of its case; every digit and every letter CHANGES (the step is never
 *   0). `upper` is ASCII-only, so `abc-1` and `ABC-1` stay one SKU apart in case
 *   only: the import's near-duplicate rule reads them as it read the real ones.
 * - **Injective.** Two different SKUs get one step at their first differing
 *   position (they share what precedes it), so their pseudonyms differ there. The
 *   one exception is the escape below: an escaped digit can land on the letter a
 *   real LETTER in that same position maps to. {@link PseudonimosLi} counts that
 *   as a collision, and the run is refused.
 * - **Never a document.** A pseudonym is written only after the redactor kept the
 *   real SKU, so it trips no shape pattern (they read character classes only).
 *   The check-digit layer reads values: whenever the pseudonym so far ENDS in a
 *   run that layer would mask (`fimDeTrechoDaCamadaDeDigitosLi`: an 11-digit CPF
 *   or a 14-digit or letter-bearing CNPJ with valid check digits), that last
 *   digit becomes an upper-case letter. Decided on the prefix alone, so it keeps
 *   the prefix relation; it can mark a run that more digits would have broken
 *   anyway (a letter inside a longer variation SKU), never miss one.
 *
 * Pure: the key, the raw tree and the sanitized tree in, a new tree out. The only
 * import beyond this app is `node:crypto`'s HMAC, which opens nothing.
 */
import { createHmac } from 'node:crypto';

import {
  REDIGIDO,
  type TabelaRedacaoLi,
  type ValorJsonLi,
  decodificarValorDaQueryLi,
  fimDeTrechoDaCamadaDeDigitosLi,
  passaPredicadoLi,
} from '../core/redacao';
import { segmentoDaTabela } from './folhas';

/** The smallest and the largest pseudonym: every one has exactly 12 digits. */
export const PSEUDONIMO_MINIMO_LI = 100_000_000_000;
export const PSEUDONIMO_MAXIMO_LI = 999_999_999_999;
const FAIXA = PSEUDONIMO_MAXIMO_LI - PSEUDONIMO_MINIMO_LI + 1;

/** The key's length in bytes; `.chave-fixtures` holds it as 64 hexadecimal digits. */
export const BYTES_DA_CHAVE_LI = 32;

const PREFIXO_DA_MENSAGEM = 'li-fixture-id:';
/** The SKU positions' own namespace: never the same message as an id's. */
const PREFIXO_DO_SKU = 'li-fixture-sku:';
const CODIGO_0 = 48;
const CODIGO_A = 65;
const CODIGO_A_MINUSCULO = 97;

/** ASCII letters upper-cased, every other character as it is (no length change). */
const maiusculasAscii = (t: string) => t.replace(/[a-z]/g, (c) => c.toUpperCase());

/** `c` (a char code) shifted inside the run of `tamanho` codes from `base`, or `null` outside it. */
function deslocar(c: number, base: number, tamanho: number, passo: number): string | null {
  if (c < base || c >= base + tamanho) return null;
  return String.fromCharCode(base + ((c - base + passo) % tamanho));
}
const CHAVE_HEX = /^[0-9a-fA-F]{64}$/;
const DIGITOS = /^\d+$/;
/** A canonical decimal id inside the pseudonym range: as many digits, no leading zero. */
const NA_FAIXA_DO_PSEUDONIMO = new RegExp(
  `^[1-9]\\d{${String(String(PSEUDONIMO_MINIMO_LI).length - 1)}}$`,
);
/** An id segment: one id, or a `;`-separated list (`/v1/categoria/set/41;42`). */
const LISTA_DE_IDS = /^\d+(?:;\d+)*$/;

/**
 * The pseudonym key. Its bytes sit in a private field, so neither
 * `JSON.stringify`, `String` nor `util.inspect` can print them.
 */
export class ChaveDeFixturesLi {
  readonly #bytes: Buffer;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  /**
   * A key from the text of `.chave-fixtures`: 64 hexadecimal digits, with an
   * optional BOM and surrounding whitespace (a trailing newline). Anything else is
   * `null`, and the caller says so without quoting the text.
   */
  static deTexto(texto: string): ChaveDeFixturesLi | null {
    const limpo = texto.replace(/^﻿/, '').trim();
    return CHAVE_HEX.test(limpo) ? new ChaveDeFixturesLi(Buffer.from(limpo, 'hex')) : null;
  }

  /** The pseudonym of a canonical decimal id ({@link idCanonicoLi}). */
  pseudonimo(idCanonico: string): number {
    const mac = createHmac('sha256', this.#bytes)
      .update(`${PREFIXO_DA_MENSAGEM}${idCanonico}`, 'utf8')
      .digest();
    return PSEUDONIMO_MINIMO_LI + (mac.readUIntBE(0, 6) % FAIXA);
  }

  /** `n(i)` of the module comment: the keyed value of the SKU position after `antes`. */
  #valorDaPosicao(antes: string): number {
    return createHmac('sha256', this.#bytes)
      .update(`${PREFIXO_DO_SKU}${maiusculasAscii(antes)}`, 'utf8')
      .digest()
      .readUIntBE(0, 6);
  }

  /**
   * The pseudonym of a SKU, character by character ("SKUs" in the module comment):
   * prefix- and shape-preserving, every digit and letter changed, and never ending a
   * run the redactor's check-digit layer would mask.
   */
  sku(sku: string): string {
    let saida = '';
    for (let i = 0; i < sku.length; i++) {
      const c = sku.charCodeAt(i);
      const n = this.#valorDaPosicao(sku.slice(0, i));
      const digito = deslocar(c, CODIGO_0, 10, 1 + (n % 9));
      if (digito !== null) {
        const ate = saida + digito;
        // A run the digit layer would mask ENDS here: this digit becomes a letter.
        saida =
          fimDeTrechoDaCamadaDeDigitosLi(ate) === ate.length
            ? saida + String.fromCharCode(CODIGO_A + ((Number(digito) + Math.floor(n / 9)) % 26))
            : ate;
        continue;
      }
      const passo = 1 + (n % 25);
      saida +=
        deslocar(c, CODIGO_A, 26, passo) ??
        deslocar(c, CODIGO_A_MINUSCULO, 26, passo) ??
        sku.charAt(i);
    }
    return saida;
  }

  toJSON(): string {
    return '<chave-de-fixtures>';
  }

  toString(): string {
    return '<chave-de-fixtures>';
  }
}

/** The text of a new `.chave-fixtures`: the 32 random bytes as lowercase hex, and a newline. */
export function textoDeChaveNovaLi(aleatorio: Uint8Array): string {
  if (aleatorio.length !== BYTES_DA_CHAVE_LI) {
    throw new RangeError(`a key is ${String(BYTES_DA_CHAVE_LI)} bytes`);
  }
  return `${Buffer.from(aleatorio).toString('hex')}\n`;
}

/**
 * The canonical decimal of an id: a number as `String` writes it, a digit run
 * without its leading zeros (`0007` and `7` are one id).
 */
export function idCanonicoLi(id: number | string): string {
  return typeof id === 'number' ? String(id) : id.replace(/^0+(?=\d)/, '');
}

/** What an id position (or a `sku=` value) of a URL-shaped text becomes: its pseudonym, or a blank. */
export interface TrocaDeIdsLi {
  /** The text that replaces the canonical id `idCanonico`. */
  troca(idCanonico: string): string;
  /** The text that replaces a kept SKU (a query value, decoded). */
  sku(sku: string): string;
}

/**
 * Every id position blanked as `<id>`, and every `sku=` value as `<sku>`: the
 * request line a catalogue pair with no key prints in a dry run (the pair is
 * refused, and its real ids and SKUs are never shown).
 */
export const OCULTAR_IDS_LI: TrocaDeIdsLi = { troca: () => '<id>', sku: () => '<sku>' };

/**
 * The pseudonyms of one run (or one pair): each id and each SKU mapped once,
 * every mapping recorded, and every collision and every real id inside the
 * pseudonym range counted. `ids` and `skus` hold the REAL values, in memory
 * only: nothing prints them, and a finding names a count, never a value.
 */
export class PseudonimosLi implements TrocaDeIdsLi {
  readonly #chave: ChaveDeFixturesLi;
  readonly #reais = new Map<number, string>();
  /** Real SKU → its pseudonym (each SKU is computed once). */
  readonly #skus = new Map<string, string>();
  /** SKU pseudonym → the real SKU behind it. */
  readonly #skusReais = new Map<string, string>();
  /** The distinct real ids mapped that already lie in the pseudonym range. */
  readonly #reaisNaFaixa = new Set<string>();
  #colisoes = 0;

  constructor(chave: ChaveDeFixturesLi) {
    this.#chave = chave;
  }

  /** The pseudonym of a canonical id, recorded. */
  de(idCanonico: string): number {
    if (NA_FAIXA_DO_PSEUDONIMO.test(idCanonico)) this.#reaisNaFaixa.add(idCanonico);
    const falso = this.#chave.pseudonimo(idCanonico);
    const anterior = this.#reais.get(falso);
    if (anterior === undefined) this.#reais.set(falso, idCanonico);
    else if (anterior !== idCanonico) this.#colisoes += 1;
    return falso;
  }

  /** The pseudonym of a canonical id as text, recorded. */
  troca(idCanonico: string): string {
    return String(this.de(idCanonico));
  }

  /** The pseudonym of a SKU, recorded. */
  sku(sku: string): string {
    const conhecido = this.#skus.get(sku);
    if (conhecido !== undefined) return conhecido;
    const falso = this.#chave.sku(sku);
    this.#skus.set(sku, falso);
    const anterior = this.#skusReais.get(falso);
    if (anterior === undefined) this.#skusReais.set(falso, sku);
    else if (anterior !== sku) this.#colisoes += 1;
    return falso;
  }

  /** How many times a second, different id or SKU landed on a pseudonym already taken. */
  get colisoes(): number {
    return this.#colisoes;
  }

  /**
   * How many distinct REAL ids mapped already lie in the pseudonym range (12
   * digits): each would read as a pseudonym, so the pair is refused.
   */
  get idsReaisNaFaixa(): number {
    return this.#reaisNaFaixa.size;
  }

  /** Pseudonym → the real canonical id behind it. Never printed. */
  get ids(): ReadonlyMap<number, string> {
    return this.#reais;
  }

  /** SKU pseudonym → the real SKU behind it. Never printed. */
  get skus(): ReadonlyMap<string, string> {
    return this.#skusReais;
  }
}

/**
 * Every id `/`-segment of `texto` with each id replaced by its pseudonym: a
 * digit-only segment, or a `;`-separated list of them (`/set/41;42`, which the
 * path redactor keeps; a resource URI never holds one).
 */
function trocarSegmentos(texto: string, troca: TrocaDeIdsLi): string {
  return texto
    .split('/')
    .map((s) =>
      LISTA_DE_IDS.test(s)
        ? s
            .split(';')
            .map((id) => troca.troca(idCanonicoLi(id)))
            .join(';')
        : s,
    )
    .join('/');
}

/** The request path (already through the path redactor) with each id segment mapped. */
export function pseudonimizarCaminhoLi(caminho: string, troca: TrocaDeIdsLi): string {
  return trocarSegmentos(caminho, troca);
}

/**
 * The query keys whose value is a catalogue resource id
 * (`/v1/produto_imagem/?produto=<id>`). Every other kept query value — `limit`,
 * `offset`, a date — is not an id and is never touched; a SKU is mapped as a
 * SKU ({@link CHAVE_DE_SKU_NA_QUERY_LI}).
 */
export const CHAVES_DE_ID_NA_QUERY_LI: ReadonlySet<string> = new Set(['produto']);

/** The query key whose value is a SKU (`/v1/produto/?sku=<sku>`): mapped like a body SKU. */
export const CHAVE_DE_SKU_NA_QUERY_LI = 'sku';

/**
 * A pseudonym written as a query value: the characters the redactor's split reads
 * as syntax (`%`, `&`, `=`, `#`, `+`) percent-encoded, every other one as it is,
 * so the redactor decodes it back to the pseudonym and keeps it.
 */
const paraAQuery = (t: string) =>
  t.replace(/[%&=#+]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * An id or SKU query pair with its value mapped. The redactor tests a value
 * DECODED and keeps its raw spelling (`produto=%35%35` passes as `55`), so the
 * value is decoded the same way here: every spelling the redactor kept is mapped,
 * an id written as the plain pseudonym. A value the redactor refused
 * (`<redacted>`) is no SKU and stays as it is.
 */
function trocarPar(
  [chave, valor]: readonly [string, string],
  troca: TrocaDeIdsLi,
): readonly [string, string] {
  if (chave === CHAVE_DE_SKU_NA_QUERY_LI) {
    const sku = decodificarValorDaQueryLi(valor);
    return valor !== REDIGIDO && passaPredicadoLi('sku', sku)
      ? [chave, paraAQuery(troca.sku(sku))]
      : [chave, valor];
  }
  if (!CHAVES_DE_ID_NA_QUERY_LI.has(chave)) return [chave, valor];
  const id = decodificarValorDaQueryLi(valor);
  return DIGITOS.test(id) ? [chave, troca.troca(idCanonicoLi(id))] : [chave, valor];
}

/**
 * The redacted query pairs with each id value ({@link CHAVES_DE_ID_NA_QUERY_LI})
 * and each SKU value ({@link CHAVE_DE_SKU_NA_QUERY_LI}) mapped.
 */
export function pseudonimizarQueryLi(
  query: readonly (readonly [string, string])[],
  troca: TrocaDeIdsLi,
): (readonly [string, string])[] {
  return query.map((par) => trocarPar(par, troca));
}

/**
 * A URL-shaped text the path and query redactor wrote (`meta.next`,
 * `meta.previous`): its path's id segments and its id query values mapped. The
 * redactor already split it the same way (first `?`, then `&`, then the first `=`).
 */
function pseudonimizarUrl(texto: string, troca: TrocaDeIdsLi): string {
  const interrogacao = texto.indexOf('?');
  if (interrogacao === -1) return trocarSegmentos(texto, troca);
  const query = texto
    .slice(interrogacao + 1)
    .split('&')
    .map((par) => {
      const igual = par.indexOf('=');
      if (igual === -1) return par;
      const [chave, valor] = trocarPar([par.slice(0, igual), par.slice(igual + 1)], troca);
      return `${chave}=${valor}`;
    })
    .join('&');
  return `${trocarSegmentos(texto.slice(0, interrogacao), troca)}?${query}`;
}

/** A key whose kept number is an LI id: `id`, or a name ending in `_id` (`imagem_id`). */
const ehChaveDeId = (chave: string | null) =>
  chave !== null && (chave === 'id' || chave.endsWith('_id'));

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An own property, even for `__proto__`. */
function definir(alvo: Record<string, ValorJsonLi>, chave: string, valor: ValorJsonLi): void {
  Object.defineProperty(alvo, chave, {
    value: valor,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The sanitized 2xx body with every kept catalogue id and SKU mapped (items 1, 2,
 * the `meta.next`/`meta.previous` half of 4, and 5 in the module comment).
 *
 * `bruto` (the raw tree) and `sanitizado` (the profile's output) are walked in
 * parallel BY ENTRY POSITION, as the leaf table walks them: the profile keeps
 * every object's key order and array length and renames a key in place. A leaf
 * is KEPT when both trees hold the same value there. The raw keys give the table
 * path (`objects.*.resource_uri`) and the key name (`id`); the sanitized keys are
 * written out unchanged. A subtree whose shape differs (one the profile replaced
 * past its depth cap) is copied as the profile wrote it.
 */
export function pseudonimizarCorpoLi(
  bruto: unknown,
  sanitizado: ValorJsonLi,
  tabela: TabelaRedacaoLi | null,
  pseudonimos: PseudonimosLi,
): ValorJsonLi {
  function folha(b: unknown, s: ValorJsonLi, caminho: string, chave: string | null): ValorJsonLi {
    const predicado = tabela?.permitidas.get(caminho);
    // `meta.next`/`meta.previous`: the profile always rewrites them through the path
    // and query redactor, so what it wrote is kept whether or not it equals the raw.
    if (predicado === 'urlLi' && typeof s === 'string' && typeof b === 'string') {
      return pseudonimizarUrl(s, pseudonimos);
    }
    if (b !== s) return s;
    if (ehChaveDeId(chave)) {
      if (typeof s === 'number' && Number.isSafeInteger(s)) {
        return pseudonimos.de(idCanonicoLi(s));
      }
      if (typeof s === 'string' && DIGITOS.test(s)) {
        return String(pseudonimos.de(idCanonicoLi(s)));
      }
    }
    if (typeof s === 'string' && predicado === 'uriRecurso' && passaPredicadoLi('uriRecurso', s)) {
      return trocarSegmentos(s, pseudonimos);
    }
    if (typeof s === 'string' && predicado === 'sku' && passaPredicadoLi('sku', s)) {
      return pseudonimos.sku(s);
    }
    return s;
  }

  function andar(
    b: unknown,
    s: ValorJsonLi,
    caminho: readonly string[],
    chave: string | null,
  ): ValorJsonLi {
    if (Array.isArray(s)) {
      if (!Array.isArray(b) || b.length !== s.length) return s;
      return s.map((x: ValorJsonLi, i) => andar(b[i], x, [...caminho, '*'], chave));
    }
    if (ehObjeto(s)) {
      if (!ehObjeto(b)) return s;
      const entradasBrutas = Object.entries(b);
      const entradas = Object.entries(s as Record<string, ValorJsonLi>);
      if (entradasBrutas.length !== entradas.length) return s;
      const saida: Record<string, ValorJsonLi> = {};
      entradas.forEach(([k, valor], i) => {
        const [kb, vb] = entradasBrutas[i] ?? ['', undefined];
        definir(saida, k, andar(vb, valor, [...caminho, segmentoDaTabela(kb)], kb));
      });
      return saida;
    }
    return folha(b, s, caminho.join('.'), chave);
  }

  return andar(bruto, sanitizado, [], null);
}

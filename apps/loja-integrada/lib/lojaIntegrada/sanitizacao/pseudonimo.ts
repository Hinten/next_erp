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
 * fake = 100 000 000 + (first 6 bytes of HMAC-SHA256(key, "li-fixture-id:" + id)) mod 900 000 000
 * ```
 *
 * - **One namespace.** The same real number always gives the same fake, whatever
 *   resource it names and wherever it sits (an `id`, a resource URI, the request
 *   path), across files and stores: a grade read as `id` in its detail, as a row
 *   of the grade list, in an option's `/grades/<g>` and in its
 *   `/grade/<g>/variacao/<v>` stays one grade; a category row and every
 *   `categoria_pai` naming it stay one category.
 * - **Keyed.** Without the key, a fake says nothing about the id behind it (a
 *   plain hash of a 4- to 8-digit number would be reversed by enumeration). The
 *   key is 32 random bytes in `.chave-fixtures`, in the capture folder; this
 *   module only receives it as data, and {@link ChaveDeFixturesLi} never prints it.
 * - **Deterministic.** The same key and the same capture give the same bytes, and a
 *   `--so` subset gives the same ids as a full run.
 * - **Canonical 9-digit safe integers.** Never a leading zero; the range is
 *   pinned by `wireCorpus.test.ts`. Two different ids may share a fake (a
 *   collision, about one in 900 million per pair): {@link PseudonimosLi} counts
 *   it and the run refuses (`colisao-de-pseudonimo`); the remedy is a new key and
 *   a re-run of every catalogue pair.
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
 *    `meta.previous` (`/api/v1/produto_imagem/?limit=1&offset=1&produto=<id>`).
 *
 * Meta numbers (`limit`, `offset`, `total_count`) and every other query value
 * (`limit`, `offset`, a date) are never touched: they carry no store's resource
 * id, and tests rely on them. Only a 2xx body is walked: an error body follows
 * the error walk's own rule, and `capturaParaFixture` refuses a catalogue one
 * that keeps a number.
 *
 * Pure: the key, the raw tree and the sanitized tree in, a new tree out. The only
 * import beyond this app is `node:crypto`'s HMAC, which opens nothing.
 */
import { createHmac } from 'node:crypto';

import {
  type TabelaRedacaoLi,
  type ValorJsonLi,
  decodificarValorDaQueryLi,
  passaPredicadoLi,
} from '../core/redacao';
import { segmentoDaTabela } from './folhas';

/** The smallest and the largest pseudonym: every one has exactly 9 digits. */
export const PSEUDONIMO_MINIMO_LI = 100_000_000;
export const PSEUDONIMO_MAXIMO_LI = 999_999_999;
const FAIXA = PSEUDONIMO_MAXIMO_LI - PSEUDONIMO_MINIMO_LI + 1;

/** The key's length in bytes; `.chave-fixtures` holds it as 64 hexadecimal digits. */
export const BYTES_DA_CHAVE_LI = 32;

const PREFIXO_DA_MENSAGEM = 'li-fixture-id:';
const CHAVE_HEX = /^[0-9a-fA-F]{64}$/;
const DIGITOS = /^\d+$/;
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

/** What an id position of a URL-shaped text becomes: its pseudonym, or a blank. */
export interface TrocaDeIdsLi {
  /** The text that replaces the canonical id `idCanonico`. */
  troca(idCanonico: string): string;
}

/**
 * Every id position blanked as `<id>`: the request line a catalogue pair with no
 * key prints in a dry run (the pair is refused, and its real ids are never shown).
 */
export const OCULTAR_IDS_LI: TrocaDeIdsLi = { troca: () => '<id>' };

/**
 * The pseudonyms of one run (or one pair): each id mapped once, every mapping
 * recorded, and every collision counted. `ids` holds the REAL ids, in memory
 * only: nothing prints it, and a finding names a collision, never an id.
 */
export class PseudonimosLi implements TrocaDeIdsLi {
  readonly #chave: ChaveDeFixturesLi;
  readonly #reais = new Map<number, string>();
  #colisoes = 0;

  constructor(chave: ChaveDeFixturesLi) {
    this.#chave = chave;
  }

  /** The pseudonym of a canonical id, recorded. */
  de(idCanonico: string): number {
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

  /** How many times a second, different id landed on a pseudonym already taken. */
  get colisoes(): number {
    return this.#colisoes;
  }

  /** Pseudonym → the real canonical id behind it. Never printed. */
  get ids(): ReadonlyMap<number, string> {
    return this.#reais;
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
 * `offset`, a date, a SKU — is not an id and is never touched.
 */
export const CHAVES_DE_ID_NA_QUERY_LI: ReadonlySet<string> = new Set(['produto']);

/**
 * An id query pair with its value mapped. The redactor tests a value DECODED and
 * keeps its raw spelling (`produto=%35%35` passes as `55`), so the value is
 * decoded the same way here: every spelling the redactor kept is mapped, and
 * written as the plain pseudonym.
 */
function trocarPar(
  [chave, valor]: readonly [string, string],
  troca: TrocaDeIdsLi,
): readonly [string, string] {
  if (!CHAVES_DE_ID_NA_QUERY_LI.has(chave)) return [chave, valor];
  const id = decodificarValorDaQueryLi(valor);
  return DIGITOS.test(id) ? [chave, troca.troca(idCanonicoLi(id))] : [chave, valor];
}

/** The redacted query pairs with each id value ({@link CHAVES_DE_ID_NA_QUERY_LI}) mapped. */
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
 * The sanitized 2xx body with every kept catalogue id mapped (items 1, 2 and the
 * `meta.next`/`meta.previous` half of 4 in the module comment).
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

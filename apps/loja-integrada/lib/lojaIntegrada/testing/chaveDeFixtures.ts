/**
 * TEST pseudonym keys for the sanitizer's suites, and a collision finder.
 *
 * Neither key is ever the owner's: the real key lives only in the capture folder,
 * outside every checkout (`scripts/README.md`), and no test reads that folder.
 */
import { ChaveDeFixturesLi } from '../sanitizacao/pseudonimo';

/** A fixed TEST key, as `.chave-fixtures` holds it (64 hexadecimal digits). */
export const CHAVE_DE_TESTE_HEX = '7e57'.repeat(16);

/** A second TEST key: the near-miss of the first (same ids, other pseudonyms). */
export const OUTRA_CHAVE_DE_TESTE_HEX = `${'0'.repeat(63)}1`;

/** A key from its hexadecimal text; throws when the text is not a key (a test bug). */
export function chaveDeTeste(hex: string = CHAVE_DE_TESTE_HEX): ChaveDeFixturesLi {
  const chave = ChaveDeFixturesLi.deTexto(hex);
  if (chave === null) throw new TypeError('not a 64-digit hexadecimal key');
  return chave;
}

const colisoes = new Map<string, readonly [number, number]>();

/**
 * Two different ids that share one pseudonym under `hex`: the first collision
 * among 1, 2, 3, … Pseudonyms span 900 000 000 values, so by the birthday bound
 * one turns up after some tens of thousands of ids. Memoized per key.
 */
export function colisaoDePseudonimo(hex: string = CHAVE_DE_TESTE_HEX): readonly [number, number] {
  const memo = colisoes.get(hex);
  if (memo !== undefined) return memo;
  const chave = chaveDeTeste(hex);
  const vistos = new Map<number, number>();
  for (let id = 1; id <= 1_000_000; id++) {
    const falso = chave.pseudonimo(String(id));
    const anterior = vistos.get(falso);
    if (anterior !== undefined) {
      const par = [anterior, id] as const;
      colisoes.set(hex, par);
      return par;
    }
    vistos.set(falso, id);
  }
  throw new RangeError('no collision among the first million ids');
}

/**
 * An 11-digit SKU whose pseudonym under `hex` had its last digit ESCAPED to a
 * letter (it would have ended a run with valid CPF check digits): the first among
 * 10000000000, 10000000001, … About one in a hundred is.
 */
export function skuEscapado(hex: string = CHAVE_DE_TESTE_HEX): string {
  const chave = chaveDeTeste(hex);
  for (let i = 0; i < 100_000; i++) {
    const sku = String(10_000_000_000 + i);
    if (/[A-Z]/.test(chave.sku(sku))) return sku;
  }
  throw new RangeError('no escaped SKU among the first hundred thousand');
}

/**
 * Two different SKUs that share one pseudonym under `hex` — the only way two
 * can: an escaped SKU ({@link skuEscapado}) and the SKU with a LETTER in that
 * last position whose own pseudonym is the same escape letter.
 */
export function colisaoDeSku(hex: string = CHAVE_DE_TESTE_HEX): readonly [string, string] {
  const chave = chaveDeTeste(hex);
  const escapado = skuEscapado(hex);
  const falso = chave.sku(escapado);
  for (let c = 65; c <= 90; c++) {
    const letra = `${escapado.slice(0, -1)}${String.fromCharCode(c)}`;
    if (chave.sku(letra) === falso) return [escapado, letra];
  }
  throw new RangeError('no letter lands on the escape');
}

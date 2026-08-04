import { type CMunTable, decodeCMunTable } from './codec';
import { CMUN_RANGES } from './ranges.data';
import { cleanCep } from '../cep';

/**
 * Binary-search the faixa covering `cepNum`; `-1` when none does.
 *
 * ⚠️ The `cepNum > ends[found]` check on the last line is the whole reason this
 * function exists rather than being inlined. The legacy Flutter query
 * (`.old/packages/clientes/lib/src/models.dart:1069-1075`) was
 *
 *     where('cepFinal', '>=', cep).orderBy('cepFinal').orderBy('cepInicial')
 *       .startAt(cep).limit(1)
 *
 * whose `startAt` cursor carried ONE value against TWO orderBy fields, so
 * Firestore bound it positionally to `cepFinal` and the cursor was a no-op. It
 * therefore had **no `cepInicial <= cep` predicate at all**: a CEP falling in a
 * GAP between faixas silently returned the next faixa ABOVE it — a wrong
 * município, straight into the signed NF-e XML. (The author knew something was
 * off: `//todo porque functiona? não sei, se der pau deve ser essa query aqui`.)
 *
 * We return `-1` in a gap instead, and the caller falls through to ViaCEP.
 */
export function searchRanges(table: CMunTable, cepNum: number): number {
  const { starts, ends } = table;

  // Greatest `i` with `starts[i] <= cepNum` (upper bound − 1). `starts` is
  // strictly increasing by construction — see `encodeCMunTable`.
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= cepNum) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (found < 0) return -1; // below the first faixa
  if (cepNum > ends[found]!) return -1; // in a gap, or above the last faixa
  return found;
}

/**
 * Resolve a CEP against an explicit table. Exported for tests, which build
 * small fixtures rather than leaning on the ~11k-range vendored data.
 */
export function lookupCodigoMunicipioIn(table: CMunTable, cep: string): string | null {
  const clean = cleanCep(cep);
  if (clean.length !== 8) return null;

  // `Number` drops leading zeros — exactly what the legacy `int.parse(cep)`
  // did, and what the vendored `cepInicial`/`cepFinal` integers were parsed
  // with. Lossless here because CEP is fixed-width 8 digits, so stripping
  // leading zeros is order-preserving.
  const index = searchRanges(table, Number(clean));
  if (index < 0) return null;

  // cMun's first digit is 1-5 (IBGE state prefixes 11..53), never 0, so the
  // decimal string is always 7 chars — no zero-padding needed.
  return String(table.codes[index]!);
}

let cached: CMunTable | undefined;

/** The vendored table, decoded once per process (~2 ms) on first use. */
export function cmunTable(): CMunTable {
  cached ??= decodeCMunTable(CMUN_RANGES);
  return cached;
}

/**
 * CEP → IBGE município code (`cMun`) from the offline table.
 *
 * Synchronous, no IO, never throws. `null` means "this table has no answer" —
 * a malformed CEP, a CEP below the first faixa, above the last, or inside a
 * gap between faixas. Callers that need an answer fall through to ViaCEP; see
 * `resolveCodigoMunicipio`.
 */
export function lookupCodigoMunicipio(cep: string): string | null {
  return lookupCodigoMunicipioIn(cmunTable(), cep);
}

/**
 * UF ↔ IBGE state code.
 *
 * The IBGE município code (`cMun`, 7 digits) is prefixed by its state's 2-digit
 * code, so this map is what lets a resolved `codigoMunicipio` be cross-checked
 * against the endereço's `estado` — the guard that stops a São Paulo cMun being
 * emitted under `UF=AC` and earning SEFAZ rejection 273 (#785).
 *
 * Constitutional data: the 26 states + DF, plus the NF-e pseudo-UF `EX`
 * (exterior, `cUF=99`). It has not changed since Tocantins was created in 1988.
 *
 * ⚠️ This is the SINGLE source of truth — `UF_TO_IBGE` in
 * `packages/integrations/nfe/src/generator/tz.ts` re-exports it, typed as
 * `Record<UF, string>` so a missing UF is still a compile error there.
 * `@delfrance/core` cannot import `@delfrance/schemas` (schemas depends on
 * core), which is why the exhaustiveness check lives on that side.
 */
export const IBGE_UF_CODES = {
  AC: '12',
  AL: '27',
  AM: '13',
  AP: '16',
  BA: '29',
  CE: '23',
  DF: '53',
  ES: '32',
  GO: '52',
  MA: '21',
  MG: '31',
  MS: '50',
  MT: '51',
  PA: '15',
  PB: '25',
  PE: '26',
  PI: '22',
  PR: '41',
  RJ: '33',
  RN: '24',
  RO: '11',
  RR: '14',
  RS: '43',
  SC: '42',
  SE: '28',
  SP: '35',
  TO: '17',
  EX: '99',
} as const;

/** IBGE 2-digit state code → UF sigla. Inverse of {@link IBGE_UF_CODES}. */
const UF_BY_IBGE_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IBGE_UF_CODES).map(([uf, code]) => [code, uf]),
);

/**
 * The UF a 7-digit IBGE município code belongs to, or `null` when the input is
 * not 7 digits or its prefix is not a real state code.
 */
export function ufFromCodigoMunicipio(codigoMunicipio: string | null | undefined): string | null {
  if (codigoMunicipio == null || !/^\d{7}$/.test(codigoMunicipio)) return null;
  return UF_BY_IBGE_CODE[codigoMunicipio.slice(0, 2)] ?? null;
}

/** True when `codigoMunicipio` is 7 digits whose prefix matches `uf`. */
export function codigoMunicipioMatchesUf(
  codigoMunicipio: string | null | undefined,
  uf: string | null | undefined,
): boolean {
  if (uf == null || uf === '') return false;
  return ufFromCodigoMunicipio(codigoMunicipio) === uf.toUpperCase();
}

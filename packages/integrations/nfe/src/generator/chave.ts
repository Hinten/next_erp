/**
 * Chave de acesso da NF-e (44 digits) + módulo-11 check digit.
 *
 * See `.claude/skills/nfe/references/chave-acesso.md`. The chave is computed
 * **before** sending so the doc can be persisted with its anti-loss anchor:
 * if the SOAP response is lost, the recovery flow re-queries SEFAZ with this
 * exact chave.
 */
import { randomInt } from 'node:crypto';

import { CHAVE_NFE_REGEX } from '@delfrance/schemas';

import { datePartsInOffset } from './tz';

export class NFeChaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeChaveError';
  }
}

export interface ChaveParts {
  /** IBGE UF code of the issuer (2 digits, e.g. '35' for SP). */
  readonly cUF: string;
  /** Year and month of emission as `AAMM` (e.g. `2605` for 2026-05). */
  readonly aamm: string;
  /**
   * Issuer CNPJ (14 characters) — or CPF zero-padded to 14.
   *
   * ⚠️ NOT 14 digits. RFB IN 2.229/2024 (NF-e: NT 2026.004) makes the CNPJ's
   * first 12 positions alphanumeric; only its 2 check digits stay numeric. A
   * zero-padded CPF is a subset of that shape, so the Produtor Rural emitente
   * needs no special case.
   */
  readonly cnpjOrCpf: string;
  /** Document model — `'55'` for NF-e, `'65'` for NFC-e. */
  readonly mod: '55' | '65';
  /** Série (3 digits, zero-padded). */
  readonly serie: string;
  /** nNF (9 digits, zero-padded). */
  readonly nNF: string;
  /** tpEmis (1 digit). */
  readonly tpEmis: string;
  /** cNF (8 random digits, must not equal nNF). */
  readonly cNF: string;
}

/**
 * Build the first 43 digits of the chave from its component parts.
 * Throws when any part has the wrong length or contains non-digit chars.
 */
export function composeChave43(parts: ChaveParts): string {
  assertDigits('cUF', parts.cUF, 2);
  assertDigits('aamm', parts.aamm, 4);
  // The ONLY alphanumeric field in the chave — see `CNPJ_OR_CPF_14`.
  assertShape('cnpjOrCpf', parts.cnpjOrCpf, CNPJ_OR_CPF_14, 14);
  if (parts.mod !== '55' && parts.mod !== '65') {
    throw new NFeChaveError(`mod must be '55' or '65', got '${parts.mod}'`);
  }
  assertDigits('serie', parts.serie, 3);
  assertDigits('nNF', parts.nNF, 9);
  assertDigits('tpEmis', parts.tpEmis, 1);
  assertDigits('cNF', parts.cNF, 8);
  // SEFAZ rule B03: cNF must not equal nNF. They compare numerically — the
  // length difference (cNF is 8, nNF is 9) does not save us from collision.
  if (parts.cNF === parts.nNF.slice(-8)) {
    throw new NFeChaveError('cNF must not equal nNF (SEFAZ rejects this)');
  }
  return (
    parts.cUF +
    parts.aamm +
    parts.cnpjOrCpf +
    parts.mod +
    parts.serie +
    parts.nNF +
    parts.tpEmis +
    parts.cNF
  );
}

/**
 * Módulo-11 check digit over the first 43 characters of the chave.
 *
 * Weights `2..9` cycle right-to-left; sum × weight, `resto = soma mod 11`,
 * `DV = 11 - resto`, with `resto ∈ {0,1} ⇒ DV = 0`.
 *
 * ⚠️ Each character contributes `ASCII − 48`, not `Number(c)` — the NT 2026.004
 * rule for an alphanumeric chave (`0-9` → `0-9`, `A-Z` → `17-42`), and the same
 * weighting `validateCNPJ` in `@delfrance/core/documents` already uses. For a
 * digit the two are identical, so every numeric chave yields a byte-identical
 * DV and the existing numeric pins in `chave.test.ts` are the regression guard.
 *
 * ⚠️ `Number('A')` is `NaN`, so the old spelling did not merely reject a letter
 * — with the guard relaxed it returned `11 - NaN`, and `composeChave` appended
 * `cDV.toString()` to produce a **46-character** chave carrying `<cDV>NaN</cDV>`
 * with nothing throwing anywhere. The guard was the only thing standing between
 * us and persisting that as a document's anti-loss anchor.
 */
export function computeCDV(chave43: string): number {
  assertShape('chave43', chave43, CHAVE43_SHAPE, 43);
  let soma = 0;
  let peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += (chave43.charCodeAt(i) - 48) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto <= 1 ? 0 : 11 - resto;
}

/** Compose the full 44-digit chave including its check digit. */
export function composeChave(parts: ChaveParts): { chave: string; cDV: number } {
  const chave43 = composeChave43(parts);
  const cDV = computeCDV(chave43);
  return { chave: chave43 + cDV.toString(), cDV };
}

/**
 * Build the `AAMM` slice of the chave from an instant, in the ISSUER's fixed
 * UTC offset (`offsetForUF(filial.sede.estado)`). `AA` is the last 2 digits of
 * the year; `MM` is 01–12 zero-padded. SEFAZ cross-checks the chave AAMM
 * against the `dhEmi` string, so this MUST use the same offset `buildIde` uses
 * to format `dhEmi` — never the process timezone (#395).
 */
export function aammFromDate(dhEmi: Date, offsetMinutes: number): string {
  const { year, month } = datePartsInOffset(dhEmi, offsetMinutes);
  const aa = (year % 100).toString().padStart(2, '0');
  const mm = month.toString().padStart(2, '0');
  return aa + mm;
}

/**
 * Extract the 8-digit `cNF` from a 44-character chave. Used on retry to
 * keep the chave stable when re-emitting a rejeitada NF-e — see
 * `apps/nfe/lib/nfe/orchestrator/emitir.ts` reuse branches.
 *
 * ⚠️ Guarded by the SHARED `CHAVE_NFE_REGEX`, never a local `\d{44}`. This sits
 * on the RE-EMISSION path, so a numeric-only guard here throws *after* a
 * successful first emit — the worst possible place to discover that the
 * emitente's CNPJ is alphanumeric. `slice(35, 43)` is positionally correct
 * either way: the alfa window is positions 6–17.
 */
export function extractCNFFromChave(chave: string): string {
  assertShape('chave', chave, CHAVE_NFE_REGEX, 44);
  return chave.slice(35, 43);
}

/**
 * Generate 8 random digits for `cNF`. Retries on the (vanishingly rare)
 * collision with `nNF` — SEFAZ rejects `cNF === nNF`.
 */
export function randomCNF(nNF: string): string {
  assertDigits('nNF', nNF, 9);
  for (let attempt = 0; attempt < 8; attempt++) {
    const n = randomInt(0, 100_000_000);
    const cNF = n.toString().padStart(8, '0');
    if (cNF !== nNF.slice(-8)) return cNF;
  }
  throw new NFeChaveError('Could not generate a cNF distinct from nNF after 8 attempts');
}

const ALL_DIGITS = /^\d+$/;

/**
 * A CNPJ inside the chave: 12 alphanumeric positions + 2 numeric check digits
 * (RFB IN 2.229/2024). ⚠️ NOT `[0-9A-Z]{14}` — the DVs never carry a letter.
 * A CPF emitente zero-padded to 14 is a subset, so it needs no separate arm.
 */
const CNPJ_OR_CPF_14 = /^[0-9A-Z]{12}[0-9]{2}$/;

/**
 * The first 43 characters of a chave — `CHAVE_NFE_REGEX` minus its trailing
 * cDV: cUF(2) + AAMM(4) + CNPJ body(12, ALPHANUMERIC) + CNPJ DVs(2) + mod(2) +
 * serie(3) + nNF(9) + tpEmis(1) + cNF(8) = 6 + 12 + 25.
 */
const CHAVE43_SHAPE = /^[0-9]{6}[0-9A-Z]{12}[0-9]{25}$/;

/**
 * ⚠️ Deliberately still digits-only, and used by SEVEN genuinely numeric fields
 * (cUF, aamm, serie, nNF, tpEmis, cNF, and `randomCNF`'s nNF). The alphanumeric
 * CNPJ widened exactly one field; loosening `ALL_DIGITS` to serve it would have
 * silently stopped guarding the other seven. Use `assertShape` instead.
 */
function assertDigits(name: string, value: string, expectedLength: number): void {
  assertShape(name, value, ALL_DIGITS, expectedLength, 'digits');
}

/** Assert `value` has `expectedLength` characters and matches `shape`. */
function assertShape(
  name: string,
  value: string,
  shape: RegExp,
  expectedLength: number,
  unit = 'characters',
): void {
  if (typeof value !== 'string' || value.length !== expectedLength) {
    throw new NFeChaveError(
      `${name} must be ${expectedLength} ${unit}, got '${value}' (${value?.length ?? 0})`,
    );
  }
  if (!shape.test(value)) {
    throw new NFeChaveError(`${name} must match ${shape.source}, got '${value}'`);
  }
}

/**
 * Chave de acesso (NF-e / NFC-e, 44 characters) — check digit and decomposition.
 *
 * Pure and total, so the SAME rule runs where a chave is typed (apps/web, the
 * pedido page model) and where one is generated (`packages/integrations/nfe`'s
 * `computeCDV` wraps {@link dvChaveAcesso}): one module-11 implementation, not a
 * browser copy of the generator's (root CLAUDE.md — "extract, don't re-implement").
 *
 * ⚠️ Characters, not digits: positions 6–17 carry the emitente CNPJ's body and
 * may hold `A-Z` (NT 2026.004). `CHAVE_NFE_REGEX` is the shape of record.
 */
import { CHAVE_NFE_REGEX } from './nfe';

/**
 * Módulo-11 check digit over the first 43 characters. Weights `2..9` cycle
 * right-to-left; `resto = soma mod 11`, `DV = 11 − resto`, `resto ∈ {0,1} ⇒ 0`.
 * Each character contributes `ASCII − 48` (NT 2026.004: `0-9` → 0–9, `A-Z` →
 * 17–42), which is identical to its value for a digit.
 *
 * Returns `null` for anything that is not 43 characters of the chave's shape,
 * instead of a number computed from garbage — `Number('A')` once made this
 * return `NaN` and the generator append it to a 46-character "chave".
 */
export function dvChaveAcesso(chave43: string): number | null {
  if (!CHAVE_NFE_REGEX.test(`${chave43}0`)) return null;
  let soma = 0;
  let peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += (chave43.charCodeAt(i) - 48) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto <= 1 ? 0 : 11 - resto;
}

/** A 44-character chave whose shape AND check digit are right. */
export function chaveAcessoValida(chave: string): boolean {
  if (!CHAVE_NFE_REGEX.test(chave)) return false;
  return dvChaveAcesso(chave.slice(0, 43)) === Number(chave[43]);
}

/** The fields a chave encodes (MOC 7.0 §2.2.6), as the strings they are. */
export interface ChaveAcessoDecomposta {
  readonly cUF: string;
  readonly aamm: string;
  /** CNPJ of the emitente — or a CPF left-padded with zeros to 14. */
  readonly cnpjCpfEmitente: string;
  readonly mod: string;
  readonly serie: string;
  readonly nNF: string;
  readonly tpEmis: string;
  readonly cNF: string;
  readonly cDV: string;
}

/** Split a VALID chave into its fields; `null` when the chave is not valid. */
export function decomporChaveAcesso(chave: string): ChaveAcessoDecomposta | null {
  if (!chaveAcessoValida(chave)) return null;
  return {
    cUF: chave.slice(0, 2),
    aamm: chave.slice(2, 6),
    cnpjCpfEmitente: chave.slice(6, 20),
    mod: chave.slice(20, 22),
    serie: chave.slice(22, 25),
    nNF: chave.slice(25, 34),
    tpEmis: chave.slice(34, 35),
    cNF: chave.slice(35, 43),
    cDV: chave.slice(43, 44),
  };
}

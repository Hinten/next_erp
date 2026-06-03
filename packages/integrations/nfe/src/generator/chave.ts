/**
 * Chave de acesso da NF-e (44 digits) + módulo-11 check digit.
 *
 * See `.claude/skills/nfe/references/chave-acesso.md`. The chave is computed
 * **before** sending so the doc can be persisted with its anti-loss anchor:
 * if the SOAP response is lost, the recovery flow re-queries SEFAZ with this
 * exact chave.
 */
import { randomInt } from 'node:crypto';

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
  /** Issuer CNPJ (14 digits) — or CPF zero-padded to 14. */
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
  assertDigits('cnpjOrCpf', parts.cnpjOrCpf, 14);
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
 * Módulo-11 check digit over the 43-digit chave.
 *
 * Weights `2..9` cycle right-to-left; sum × weight, `resto = soma mod 11`,
 * `DV = 11 - resto`, with `resto ∈ {0,1} ⇒ DV = 0`.
 */
export function computeCDV(chave43: string): number {
  assertDigits('chave43', chave43, 43);
  let soma = 0;
  let peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso;
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
 * Build the `AAMM` slice of the chave from a Date. `AA` is the last 2 digits
 * of the year; `MM` is 01–12 zero-padded. UTC is **not** used — SEFAZ wants
 * the issuer's local time, which the caller has already encoded in `dhEmi`.
 */
export function aammFromDate(dhEmi: Date): string {
  const aa = (dhEmi.getFullYear() % 100).toString().padStart(2, '0');
  const mm = (dhEmi.getMonth() + 1).toString().padStart(2, '0');
  return aa + mm;
}

/**
 * Extract the 8-digit `cNF` from a 44-digit chave. Used on retry to
 * keep the chave stable when re-emitting a rejeitada NF-e — see
 * `apps/nfe/lib/nfe/orchestrator/emitir.ts` reuse branches.
 */
export function extractCNFFromChave(chave: string): string {
  assertDigits('chave', chave, 44);
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

function assertDigits(name: string, value: string, expectedLength: number): void {
  if (typeof value !== 'string' || value.length !== expectedLength) {
    throw new NFeChaveError(
      `${name} must be ${expectedLength} digits, got '${value}' (${value?.length ?? 0})`,
    );
  }
  if (!ALL_DIGITS.test(value)) {
    throw new NFeChaveError(`${name} must contain only digits, got '${value}'`);
  }
}

/**
 * DV-valid Brazilian documents, made at RUN time — **for tests only**, the same
 * rule as `fakeDb.ts`: nothing outside a `*.test.ts` imports this.
 *
 * ⚠️ The repository is public, and a committed DV-valid CPF or CNPJ is
 * indistinguishable from a real person's or company's. So no such value is ever
 * written in a file: only a BASE (9 digits for a CPF, 12 characters for a CNPJ)
 * is, and the check digits are computed here, when the test runs. A base alone
 * fails every check-digit test.
 */

/** Mod-11 CPF check digit over `digitos` with weights `peso..2`. */
function dvCpf(digitos: string, peso: number): number {
  let soma = 0;
  for (let i = 0; i < digitos.length; i++) soma += Number(digitos[i]) * (peso - i);
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

/**
 * An 11-digit CPF with VALID check digits, from a 9-digit base (bare).
 * `gerarCpf('123456789')` → the base plus its two check digits.
 */
export function gerarCpf(base = '123456789'): string {
  if (!/^\d{9}$/.test(base)) throw new RangeError('gerarCpf: a base de 9 dígitos');
  const d1 = dvCpf(base, 10);
  const d2 = dvCpf(`${base}${String(d1)}`, 11);
  return `${base}${String(d1)}${String(d2)}`;
}

/** Mod-11 CNPJ check digit (alphanumeric-aware: each char counts as `charCode - 48`). */
function dvCnpj(chars: string): number {
  const pesos =
    chars.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < pesos.length; i++) soma += (chars.charCodeAt(i) - 48) * (pesos[i] ?? 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * A 14-character CNPJ with VALID check digits, from a 12-character base of
 * digits or uppercase letters (the alphanumeric CNPJ, IN RFB 2.229/2024).
 */
export function gerarCnpj(base = '434567890001'): string {
  if (!/^[0-9A-Z]{12}$/.test(base)) throw new RangeError('gerarCnpj: a base de 12 caracteres');
  const d1 = dvCnpj(base);
  const d2 = dvCnpj(`${base}${String(d1)}`);
  return `${base}${String(d1)}${String(d2)}`;
}

/** `00000000000` → `000.000.000-00`. */
export function pontuarCpf(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9, 11)}`;
}

/** `00000000000000` → `00.000.000/0000-00` (letters kept). */
export function pontuarCnpj(cnpj: string): string {
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12, 14)}`;
}

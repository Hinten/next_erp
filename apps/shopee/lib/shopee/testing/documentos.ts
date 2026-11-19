/**
 * Check-digit-valid CPFs (and CNPJs) made at RUN time — **for tests only**, the
 * same rule as `fakeDb.ts`: nothing outside a `*.test.ts` imports this.
 *
 * ⚠️ The repository is public, and a committed DV-valid document is
 * indistinguishable from a real person's or company's. So a test writes only a
 * BASE (9 digits for a CPF, 12 for a CNPJ) and the check digits are computed
 * here, when the test runs; a base alone fails every check-digit test. (The repo's one sanctioned fake, in
 * `pedidos/comprador.ts`, stays the only literal.)
 */

/** Mod-11 CPF check digit over `digitos` with weights `peso..2`. */
function dvCpf(digitos: string, peso: number): number {
  let soma = 0;
  for (let i = 0; i < digitos.length; i += 1) soma += Number(digitos[i]) * (peso - i);
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

/** An 11-digit CPF with VALID check digits, from a 9-digit base (bare digits). */
export function gerarCpf(base: string): string {
  if (!/^\d{9}$/.test(base)) throw new RangeError('gerarCpf: a base tem 9 dígitos');
  const d1 = dvCpf(base, 10);
  const d2 = dvCpf(`${base}${String(d1)}`, 11);
  return `${base}${String(d1)}${String(d2)}`;
}

/** Mod-11 CNPJ check digit (numeric base; weights 5..2,9..2 then 6..2,9..2). */
function dvCnpj(digitos: string): number {
  const pesos =
    digitos.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < pesos.length; i += 1) soma += Number(digitos[i]) * (pesos[i] ?? 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** A 14-digit CNPJ with VALID check digits, from a 12-digit base. */
export function gerarCnpj(base: string): string {
  if (!/^\d{12}$/.test(base)) throw new RangeError('gerarCnpj: a base tem 12 dígitos');
  const d1 = dvCnpj(base);
  const d2 = dvCnpj(`${base}${String(d1)}`);
  return `${base}${String(d1)}${String(d2)}`;
}

/** `00000000000000` → `00.000.000/0000-00`. */
export function pontuarCnpj(cnpj: string): string {
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12, 14)}`;
}

/** `00000000000` → `000.000.000-00`. */
export function pontuarCpf(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9, 11)}`;
}

/** The same CPF with its LAST check digit moved by one — a near-miss that fails mod-11. */
export function cpfComDvErrado(cpf: string): string {
  const ultimo = (Number(cpf[10]) + 1) % 10;
  return `${cpf.slice(0, 10)}${String(ultimo)}`;
}

'use client';

/**
 * ViaCEP lookup — resolves a Brazilian CEP to its address parts so the
 * endereço forms can autofill logradouro/bairro/cidade/estado/codigoMunicipio.
 * Public API, no key: `GET https://viacep.com.br/ws/{cep}/json/`.
 *
 * Returns `null` for a malformed CEP, a non-OK response, or ViaCEP's
 * `{ "erro": true }` (CEP not found). Network (`TypeError`) and malformed-JSON
 * (`SyntaxError`) failures are left to propagate so the caller can narrow them
 * (no generic catch here — see CLAUDE.md rule 6).
 */

export interface EnderecoViaCep {
  logradouro: string;
  bairro: string;
  cidade: string;
  estado: string;
  /** IBGE município code (maps to `codigoMunicipio`). */
  codigoMunicipio: string;
}

interface ViaCepResponse {
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  ibge?: string;
  erro?: boolean | string;
}

export function cleanCep(input: string): string {
  return input.replace(/\D/g, '').slice(0, 8);
}

export async function buscarCep(cep: string): Promise<EnderecoViaCep | null> {
  const clean = cleanCep(cep);
  if (clean.length !== 8) return null;

  const res = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
  if (!res.ok) return null;

  const data = (await res.json()) as ViaCepResponse;
  // ViaCEP signals "not found" with `{ "erro": true }` (sometimes the string
  // "true") and HTTP 200 — both are truthy here.
  if (data.erro) return null;

  return {
    logradouro: data.logradouro ?? '',
    bairro: data.bairro ?? '',
    cidade: data.localidade ?? '',
    estado: data.uf ?? '',
    codigoMunicipio: data.ibge ?? '',
  };
}

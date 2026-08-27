'use client';

/**
 * Public CNPJ lookup — resolves a CNPJ to a company's razão social, address and
 * (best-effort) inscrição estadual so the cliente form can autofill `nome`/`ie`
 * and offer to register the returned endereço. Mirrors the ViaCEP lookup
 * (`@delfrance/core/cep`): public API, no key.
 *
 * Provider: BrasilAPI `GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}` (free,
 * CORS-enabled, sourced from the Receita Federal national registry). It returns
 * razão social + full address + UF reliably; it does NOT expose the inscrição
 * estadual (IE is state-level, not in the federal registry), so `ie` is left
 * `null` here and SEFAZ Consulta Cadastro (the authoritative source) fills it.
 * Keeping the provider behind this one module lets it be swapped (e.g. for an
 * API that does return IE) without touching the UI.
 *
 * Returns `null` for a malformed/short CNPJ, a "not found" (404) or any non-OK
 * response. Network (`TypeError`) and malformed-JSON (`SyntaxError`) failures
 * are left to propagate so the caller can narrow them (no generic catch here —
 * see CLAUDE.md rule 6).
 */

import { z } from 'zod';

import type { UF } from '@delfrance/schemas';

/** Address shape aligned to `enderecoSchema` keys, ready to seed an address form. */
export interface ClienteCnpjEndereco {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  estado: string;
  /** IBGE município code (maps to `codigoMunicipio`). */
  codigoMunicipio: string;
}

export interface ClienteCnpjData {
  /** Razão social. */
  nome: string;
  nomeFantasia: string | null;
  /** Best-effort IE from the public API (BrasilAPI returns none → null; SEFAZ is authoritative). */
  ie: string | null;
  /** UF of the head office — drives which SEFAZ UF webservice to query. */
  uf: string;
  endereco: ClienteCnpjEndereco | null;
}

/** BrasilAPI CNPJ response — every field optional (defensive). */
/**
 * BrasilAPI's CNPJ answer, as much of it as this module reads.
 *
 * ⚠️ Every field carries `.catch(undefined)`, which makes this schema strictly
 * MORE tolerant than the `as BrasilApiCnpj` cast it replaces: an unusable field
 * degrades to absent and the rest of the record still fills the form, so
 * nothing that works today can start failing. What it fixes is the other
 * direction — `razao_social`, `uf`, `municipio` and friends are `.trim()`ed
 * immediately below, so a numeric field was a TypeError thrown at the operator
 * mid-form rather than a "não encontrado".
 *
 * ⚠️ `cep` and `codigo_municipio_ibge` really are `string | number` — that is
 * why they were already typed as a union, and `digitsOnly` handles both.
 */
const brasilApiCnpjSchema = z.object({
  razao_social: z.string().optional().catch(undefined),
  nome_fantasia: z.string().optional().catch(undefined),
  descricao_tipo_de_logradouro: z.string().optional().catch(undefined),
  logradouro: z.string().optional().catch(undefined),
  numero: z.string().optional().catch(undefined),
  complemento: z.string().optional().catch(undefined),
  bairro: z.string().optional().catch(undefined),
  cep: z.union([z.string(), z.number()]).optional().catch(undefined),
  municipio: z.string().optional().catch(undefined),
  uf: z.string().optional().catch(undefined),
  codigo_municipio_ibge: z.union([z.string(), z.number()]).optional().catch(undefined),
});
type BrasilApiCnpj = z.infer<typeof brasilApiCnpjSchema>;

/** Strip a typed/pasted CNPJ down to the clean wire format (uppercase alphanumeric, max 14). */
export function cleanCnpj(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 14);
}

function digitsOnly(value: string | number | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

function buildLogradouro(data: BrasilApiCnpj): string {
  return [data.descricao_tipo_de_logradouro, data.logradouro]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function mapEndereco(data: BrasilApiCnpj): ClienteCnpjEndereco | null {
  const cep = digitsOnly(data.cep).slice(0, 8);
  const cidade = (data.municipio ?? '').trim();
  const estado = (data.uf ?? '').trim().toUpperCase();
  // Without a UF/city the address can't seed a valid endereço — skip the offer.
  if (!estado || !cidade) return null;
  return {
    cep,
    logradouro: buildLogradouro(data),
    numero: (data.numero ?? '').trim(),
    complemento: (data.complemento ?? '').trim(),
    bairro: (data.bairro ?? '').trim(),
    cidade,
    estado,
    codigoMunicipio: digitsOnly(data.codigo_municipio_ibge).slice(0, 8),
  };
}

export async function buscarCnpj(cnpj: string): Promise<ClienteCnpjData | null> {
  const clean = cleanCnpj(cnpj);
  // BrasilAPI keys off the 14-digit Receita CNPJ; the alphanumeric CNPJ
  // (IN RFB 2.229/2024) isn't queryable there, so a non-numeric value is a miss.
  if (clean.length !== 14 || !/^\d{14}$/.test(clean)) return null;

  const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${clean}`);
  if (res.status === 404) return null;
  if (!res.ok) return null;

  const leitura = brasilApiCnpjSchema.safeParse((await res.json()) as unknown);
  // Only a non-object body reaches here — every field degrades on its own — and
  // a body that is not an object is a miss, which is what this lookup already
  // returns for a CNPJ it cannot resolve.
  if (!leitura.success) return null;
  const data = leitura.data;

  const nome = (data.razao_social ?? '').trim();
  if (!nome) return null;

  return {
    nome,
    nomeFantasia: data.nome_fantasia?.trim() || null,
    ie: null,
    uf: (data.uf ?? '').trim().toUpperCase(),
    endereco: mapEndereco(data),
  };
}

/** The `estado` keys the public lookup can emit are the 27 Brazilian UFs (never 'EX'). */
export type ClienteCnpjUF = Exclude<UF, 'EX'>;

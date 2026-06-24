'use client';

/**
 * Shared CNPJ lookup used by both the schema-driven `CnpjLookupField` (cliente
 * create/detail pages) and the hand-built `ClienteQuickCreateModal`. Resolves a
 * CNPJ to `{ nome, ie, endereco }` via the public BrasilAPI (nome + endereço +
 * UF) plus a **best-effort** SEFAZ Consulta Cadastro for the authoritative IE
 * (preferred over the public IE). Pure (no React) so it unit-tests without a
 * component; each caller writes the result into its own form.
 *
 * `nfe`/`filialId` are optional — without them the SEFAZ leg is skipped and the
 * IE falls back to the public value (or null). A SEFAZ failure never throws; it
 * is advisory and reported via `sefazNote`.
 */

import {
  NFeHttpError,
  NFeNetworkError,
  type NFeConsultaCadastroResult,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import { type ClienteCnpjEndereco, buscarCnpj, cleanCnpj } from '@/lib/clientes/consultaCnpj';

export interface CnpjLookupData {
  /** Razão social. */
  nome: string;
  ie: string | null;
  endereco: ClienteCnpjEndereco | null;
  /** When no IE came back, a human reason (SEFAZ cStat / coverage); else null. */
  sefazNote: string | null;
}

export type CnpjLookupOutcome =
  | { ok: true; data: CnpjLookupData }
  | { ok: false; reason: 'not-found' | 'network' | 'invalid-response' };

/**
 * Human-readable reason the SEFAZ Consulta Cadastro returned no usable IE, so the
 * operator can tell a genuine "no registration" (cStat 258/259) or a coverage gap
 * (UF unsupported / cross-UF / SEFAZ down) from an actual problem.
 */
function sefazIeNote(cad: NFeConsultaCadastroResult, uf: string): string {
  if (!cad.supported) return cad.xMotivo ?? `Consulta Cadastro indisponível para a UF ${uf}`;
  if (cad.degraded) return 'SEFAZ indisponível no momento';
  if (cad.cStat) return `SEFAZ ${cad.cStat}${cad.xMotivo ? `: ${cad.xMotivo}` : ''}`;
  return 'SEFAZ não retornou inscrição estadual';
}

export async function resolveCnpj(
  cnpj: string,
  nfe: NFeHttpClient | null,
  filialId?: string,
): Promise<CnpjLookupOutcome> {
  const clean = cleanCnpj(cnpj);

  let pub: Awaited<ReturnType<typeof buscarCnpj>>;
  try {
    pub = await buscarCnpj(clean);
  } catch (err) {
    // Narrow the two propagated failures (see consultaCnpj.ts / CLAUDE.md rule 6).
    if (err instanceof TypeError) return { ok: false, reason: 'network' };
    if (err instanceof SyntaxError) return { ok: false, reason: 'invalid-response' };
    throw err;
  }
  if (!pub) return { ok: false, reason: 'not-found' };

  // Authoritative IE from SEFAZ Consulta Cadastro (best-effort).
  let sefazIe: string | null = null;
  let sefazNote: string | null = null;
  if (nfe && filialId && pub.uf) {
    try {
      const cad = await nfe.consultaCadastro(clean, pub.uf, filialId);
      const habilitada = cad.infCad.find((c) => c.situacao === '1') ?? cad.infCad[0];
      sefazIe = habilitada?.ie ?? null;
      if (!sefazIe) sefazNote = sefazIeNote(cad, pub.uf);
    } catch (err) {
      // Advisory — a typed NFe failure just falls back to the public IE.
      if (!(err instanceof NFeHttpError) && !(err instanceof NFeNetworkError)) throw err;
      sefazNote = 'não foi possível consultar a SEFAZ';
    }
  }

  return {
    ok: true,
    data: { nome: pub.nome, ie: sefazIe ?? pub.ie, endereco: pub.endereco, sefazNote },
  };
}

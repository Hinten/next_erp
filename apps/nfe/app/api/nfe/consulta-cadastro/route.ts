/**
 * `POST /api/nfe/consulta-cadastro` — SEFAZ Consulta Cadastro (NFeConsultaCadastro4).
 *
 * The server half of "buscar dados por CNPJ": query a taxpayer's IE registry
 * (razão social + endereço + situação cadastral) so the clientes form can
 * pre-fill from SEFAZ. **Advisory, best-effort**: the lookup is never on a
 * fiscal-mutation path, so transport failures and unsupported UFs degrade
 * gracefully (200 with `supported:false` / `degraded:true`) instead of 5xx.
 *
 * Body (JSON, POST): `{ cnpj: <14 digits>, uf: <2 letters>, filialId: <id> }`. POST
 * (not GET) keeps the queried CNPJ out of the URL — query strings leak into access
 * logs, proxies and browser history. filialId REQUIRED in v1 — the lookup signs the
 * mTLS handshake with that filial's A1 cert.
 *
 * Returns (always 200 unless auth/runtime/cert/our-bug):
 *   200 { supported:true, uf, cStat, xMotivo, infCad:[...] }   — 111/112 found
 *   200 { supported:true, cStat, xMotivo, infCad:[] }          — 258/259/108/… none
 *   200 { supported:false, uf, cStat:null, xMotivo, infCad:[] } — UF unsupported / cross-UF
 *   200 { supported:true, cStat:null, xMotivo, degraded:true, infCad:[] } — SEFAZ inacessível
 *   400  bad query (ZodError)
 *   401  no/invalid token
 *   403  insufficient perm (needs PERM.fiscal.read)
 *   422  filial has no cert (NFeCertError)
 *   500  our bug (malformed request XML / parse failure)
 *   503  runtime not ready
 *
 * The request `consCad` XML is hand-built and the `retConsCad` response is
 * hand-parsed in `consultarCadastro` (the consCad v2.00 XSDs aren't in the
 * codegen — issue #251). The request is still **XSD-validated before sending**
 * (`validateConsCad`) — SEFAZ rule: never POST schema-invalid XML, since
 * repeated `cStat=215/225` trips `cStat=656` (Consumo Indevido). A schema-
 * invalid request throws before the POST and surfaces here as a 500.
 * See `packages/integrations/nfe/src/operations/index.ts:consultarCadastro`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  NFeCertError,
  NFeTransportError,
  consultarCadastro,
  getConsultaCadastroEndpoint,
  type ConsultaCadastroInfCad,
  type NFeConsultaCadastroInfCad,
  type SefazCall,
} from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import { resolveFilialRuntime } from '@/lib/nfe/filial-cert';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  cnpj: z.string().regex(/^\d{14}$/, 'cnpj deve ter 14 dígitos'),
  uf: z.string().regex(/^[A-Za-z]{2}$/, 'uf deve ter 2 letras'),
  // filialId is REQUIRED in v1 — the lookup signs the mTLS handshake with this
  // filial's cert, and the home-UF restriction is checked against the runtime.
  filialId: z.string().min(1).max(200),
});

/** Map the raw-ish SEFAZ `infCad` shape onto the browser-safe friendly keys. */
function toFriendlyInfCad(raw: ConsultaCadastroInfCad): NFeConsultaCadastroInfCad {
  return {
    ie: raw.IE,
    cnpj: raw.CNPJ,
    cpf: raw.CPF,
    uf: raw.UF,
    situacao: raw.cSit,
    razaoSocial: raw.xNome,
    ender: raw.ender
      ? {
          logradouro: raw.ender.xLgr,
          numero: raw.ender.nro,
          complemento: raw.ender.xCpl,
          bairro: raw.ender.xBairro,
          codigoMunicipio: raw.ender.cMun,
          municipio: raw.ender.xMun,
          cep: raw.ender.CEP,
        }
      : null,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.read);
  if ('error' in auth) return auth.error;

  let query: z.infer<typeof querySchema>;
  try {
    const body: unknown = await req.json();
    query = querySchema.parse(body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: 'Bad query', code: e.issues[0]?.message });
    }
    // Malformed / non-JSON body — `req.json()` throws SyntaxError.
    if (e instanceof SyntaxError) {
      return authError(400, { error: 'Corpo da requisição inválido (JSON esperado)' });
    }
    throw e;
  }

  const uf = query.uf.toUpperCase();

  let base;
  try {
    base = getNFeRuntime();
  } catch (e) {
    return authError(503, { error: e instanceof Error ? e.message : 'runtime not ready' });
  }

  // Resolve the UF endpoint FIRST — a UF that doesn't offer Consulta Cadastro
  // (or isn't wired) degrades to a graceful supported:false, never a 5xx.
  const endpoint = getConsultaCadastroEndpoint(uf, base.ambiente);
  if (endpoint === null) {
    return NextResponse.json({
      supported: false,
      uf,
      cStat: null,
      xMotivo: 'UF não oferece Consulta Cadastro',
      infCad: [],
    });
  }

  // v1 CROSS-UF RESTRICTION: the runtime's mTLS chain is pinned to the home UF,
  // so only same-UF lookups are supported until other UFs' TLS chains are
  // vendored. A cross-UF request degrades to supported:false.
  if (uf !== base.uf.toUpperCase()) {
    return NextResponse.json({
      supported: false,
      uf,
      cStat: null,
      xMotivo: 'Consulta Cadastro disponível apenas para a UF da filial',
      infCad: [],
    });
  }

  let rt;
  try {
    rt = await resolveFilialRuntime(getAdminFirestore(), base, query.filialId);
  } catch (e) {
    if (e instanceof NFeCertError) return authError(422, { error: e.message, code: e.name });
    throw e;
  }

  // Build the SefazCall inline against the consulta-cadastro URL — `sefazCallFor`
  // can't address this op (its SefazService type excludes consulta cadastro).
  const call: SefazCall = {
    url: endpoint,
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
  };

  try {
    const ret = await consultarCadastro(call, { uf, cnpj: query.cnpj });
    return NextResponse.json({
      supported: true,
      uf: ret.uf,
      cStat: ret.cStat,
      xMotivo: ret.xMotivo,
      infCad: ret.infCad.map(toFriendlyInfCad),
    });
  } catch (e) {
    if (e instanceof NFeTransportError) {
      // SEFAZ unreachable — advisory, so NEVER a 5xx. The request was valid;
      // surface a degraded payload so the UI can fall back to manual entry.
      return NextResponse.json({
        supported: true,
        uf,
        cStat: null,
        xMotivo: 'SEFAZ inacessível',
        degraded: true,
        infCad: [],
      });
    }
    // A genuine bug (our consCad XML malformed / retConsCad parse failure) —
    // surface as 500 so it's visible, not silently swallowed as "no match".
    safeLog('error', '[nfe/consulta-cadastro]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

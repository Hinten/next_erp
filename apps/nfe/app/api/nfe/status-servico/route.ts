/**
 * `GET /api/nfe/status-servico` — SEFAZ availability check (NfeStatusServico4).
 *
 * The decision-support half of manual contingency: before flipping the
 * filial's `contingencia_modo`, the operator checks whether the home SEFAZ
 * is down (cStat 108/109) and whether the SVC is answering (107; 113/114 =
 * SVC em desativação / desabilitada).
 *
 * Query: `?target=normal|svc` — `normal` asks the home SEFAZ, `svc` asks the
 * UF's SVC environment. Both query the **issuer's** cUF.
 *
 * Returns:
 *   200  { target, authorizer, cStat, xMotivo, dhRecbto, tMed, category }
 *   400  bad query
 *   401  no/invalid token
 *   403  insufficient perm (needs PERM.fiscal.read)
 *   502  SEFAZ/SVC unreachable (transport error — itself a "down" signal)
 *   503  runtime not ready
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  NFeTransportError,
  classifyCStat,
  consultarStatusServico,
  cUFFromUF,
  svcAuthorizerForUF,
  type CUFCode,
} from '@delfrance/integrations-nfe';
import type { UF } from '@delfrance/schemas';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { safeLog } from '@/lib/nfe/log';
import { sefazCallFor } from '@/lib/nfe/orchestrator/sefaz-call';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  target: z.enum(['normal', 'svc']).default('normal'),
});

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.read);
  if ('error' in auth) return auth.error;

  let query: z.infer<typeof querySchema>;
  try {
    const url = new URL(req.url);
    query = querySchema.parse(Object.fromEntries(url.searchParams));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: 'Bad query', code: e.issues[0]?.message });
    }
    throw e;
  }

  let rt;
  try {
    rt = getNFeRuntime();
  } catch (e) {
    return authError(503, { error: e instanceof Error ? e.message : 'runtime not ready' });
  }

  try {
    const uf = rt.uf as UF;
    // `svc` routes through the same tpEmis-aware helper emission uses: the
    // UF's SVC authorizer (6 = SVC-AN, 7 = SVC-RS). The consStatServ payload
    // still carries the ISSUER's cUF — that's who we ask the SVC about.
    const authorizer = query.target === 'svc' ? svcAuthorizerForUF(uf) : 'sefaz';
    const call = sefazCallFor(
      rt,
      query.target === 'svc' ? (authorizer === 'svc-an' ? 6 : 7) : 1,
      'NfeStatusServico',
    );
    const ret = await consultarStatusServico(call, { cUF: cUFFromUF(uf) as CUFCode });
    return NextResponse.json({
      target: query.target,
      authorizer,
      cStat: ret.cStat,
      xMotivo: ret.xMotivo,
      dhRecbto: ret.dhRecbto ?? null,
      tMed: ret.tMed ?? null,
      category: classifyCStat(ret.cStat),
    });
  } catch (e) {
    if (e instanceof NFeTransportError) {
      // Unreachable IS an answer for this endpoint — surface it as a typed
      // "down" payload instead of a generic 500.
      return authError(502, {
        error: `${query.target === 'svc' ? 'SVC' : 'SEFAZ'} inacessível: ${e.message}`,
        code: 'NFeTransportError',
      });
    }
    safeLog('error', '[nfe/status-servico]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

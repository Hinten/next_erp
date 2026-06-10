/**
 * `GET /api/nfe/consultar?chave=<44>` — recovery query.
 *
 * Runs `consultarSituacaoNFe` against SEFAZ. Returns the typed
 * `TRetConsSitNFe` plus a flattened `{ cStat, xMotivo, nProt? }`
 * for caller convenience.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { consultarSituacaoNFe } from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { safeLog } from '@/lib/nfe/log';
import { sefazCallFor, tpEmisFromChave } from '@/lib/nfe/orchestrator/sefaz-call';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  chave: z
    .string()
    .length(44)
    .regex(/^\d{44}$/, 'chave must be 44 digits'),
});

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.read);
  if ('error' in auth) return auth.error;

  const url = new URL(req.url);
  let query: z.infer<typeof querySchema>;
  try {
    query = querySchema.parse({ chave: url.searchParams.get('chave') ?? '' });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: e.issues[0]?.message ?? 'bad query' });
    }
    throw e;
  }

  let runtimeInstance;
  try {
    runtimeInstance = getNFeRuntime();
  } catch (e) {
    return authError(503, { error: e instanceof Error ? e.message : 'runtime not ready' });
  }

  try {
    // The chave's own tpEmis digit (position 35) routes the consulta to the
    // authorizer that owns the NF-e (home SEFAZ, SVC-AN or SVC-RS).
    const ret = await consultarSituacaoNFe(
      sefazCallFor(runtimeInstance, tpEmisFromChave(query.chave), 'NfeConsultaProtocolo'),
      { chave: query.chave },
    );
    const protInf = ret.protNFe?.infProt;
    return NextResponse.json({
      chave: query.chave,
      cStat: protInf?.cStat ?? ret.cStat,
      xMotivo: protInf?.xMotivo ?? ret.xMotivo,
      nProt: protInf?.nProt ?? null,
      raw: ret,
    });
  } catch (e) {
    safeLog('error', '[nfe/consultar]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

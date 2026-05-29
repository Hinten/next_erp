/**
 * `POST /api/nfe/inutilizar` — burn an unused NF-e número range
 * (NfeInutilizacao4). Synchronous; on cStat=102 the range is homologada.
 *
 * Returns:
 *   200 { filialId, serie, nNFIni, nNFFin, cStat:'102', xMotivo, nProt }  — homologado
 *   400  bad body / range (nNFIni > nNFFin) / filial not found
 *   401  no/invalid token
 *   403  insufficient perm
 *   422  SEFAZ rejected the inutilização
 *   500  signer / transport error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { NFeInutilizacaoError } from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import {
  inutilizarNumeracao,
  NFeOrchestratorError,
} from '@/lib/nfe/orchestrator';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z
  .object({
    filialId: z.string().min(1).max(200),
    serie: z.number().int().min(0).max(999),
    nNFIni: z.number().int().min(1).max(999_999_999),
    nNFFin: z.number().int().min(1).max(999_999_999),
    xJust: z.string().trim().min(15, 'xJust deve ter ao menos 15 caracteres').max(255),
  })
  .refine((b) => b.nNFIni <= b.nNFFin, {
    message: 'nNFIni deve ser ≤ nNFFin',
    path: ['nNFIni'],
  });

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.write);
  if ('error' in auth) return auth.error;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: 'Bad body', code: e.issues[0]?.message });
    }
    if (e instanceof SyntaxError) {
      return authError(400, { error: 'Bad JSON body' });
    }
    throw e;
  }

  let runtimeInstance;
  try {
    runtimeInstance = getNFeRuntime();
  } catch (e) {
    return authError(503, {
      error: 'NF-e runtime not ready',
      code: e instanceof Error ? e.message : undefined,
    });
  }

  try {
    const result = await inutilizarNumeracao(getAdminFirestore(), runtimeInstance, body);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof NFeInutilizacaoError) {
      return authError(422, { error: e.message });
    }
    if (e instanceof NFeOrchestratorError) {
      return authError(400, { error: e.message });
    }
    safeLog('error', '[nfe/inutilizar]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

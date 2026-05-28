/**
 * `POST /api/nfe/emitir` — generate + sign + persist (estado='enviando')
 * + send to SEFAZ + apply outcome.
 *
 * Persist-before-send is the anti-loss invariant — see
 * `lib/nfe/orchestrator.ts:emitirPedido` and the master plan's
 * "Cert lifecycle (operations)" / A8 sections.
 *
 * Returns:
 *   200 { nfeId, estado, chave, nRec, cStat, xMotivo }   — happy paths (incl. 103, 100, 105)
 *   400  bad body
 *   401  no/invalid token
 *   403  insufficient perm
 *   404  pedido not found
 *   409  bloquearEmissaoNFe set on the pedido
 *   422  SEFAZ rejected (cStat that maps to estado='rejeitada')
 *   500  generator / sign / transport error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ESTADO_NFE } from '@delfrance/schemas';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import {
  emitirPedido,
  NFeBlockedError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  pedidoId: z.string().min(1).max(200),
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
    const result = await emitirPedido(getAdminFirestore(), runtimeInstance, body.pedidoId);
    const status = result.estado === ESTADO_NFE.rejeitada ? 422 : 200;
    return NextResponse.json(result, { status });
  } catch (e) {
    if (e instanceof NFePedidoNotFoundError) {
      return authError(404, { error: e.message });
    }
    if (e instanceof NFeBlockedError) {
      return authError(409, { error: e.message });
    }
    if (e instanceof NFeOrchestratorError) {
      return authError(400, { error: e.message });
    }
    // Library errors (NFeXsdValidationError, NFeSignatureError, NFeTransportError, …)
    // surface as 500 with their structured message. `safeLog` runs every
    // arg through `redactSensitive` first, so the `responseBody` field
    // that `NFeTransportError` carries (raw SEFAZ SOAP reply — can echo
    // signed XML on cStat=215/225) never reaches stdout. Belt-and-
    // suspenders on top of the transport layer's `sanitizeTransportError`,
    // which already strips the httpsAgent.
    safeLog('error', '[nfe/emitir]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

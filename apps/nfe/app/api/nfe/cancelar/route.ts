/**
 * `POST /api/nfe/cancelar` — cancel an authorized NF-e (RecepcaoEvento,
 * tpEvento=110111).
 *
 * Consults SEFAZ for the authoritative protocol, sends the cancelamento
 * evento, and on cStat 135/155 persists estado='c' (cancelada).
 *
 * Returns:
 *   200 { nfeId, estado:'c', chave, cStat, xMotivo }  — cancelled (135/155)
 *   400  bad body / orchestrator precondition (missing chave, etc.)
 *   401  no/invalid token
 *   403  insufficient perm
 *   404  pedido not found
 *   422  SEFAZ rejected the cancelamento, or the NF-e isn't cancellable
 *   500  signer / transport error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import {
  cancelarPedido,
  NFeCancelamentoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  pedidoId: z.string().min(1).max(200),
  // SEFAZ requires the justification to be 15–255 chars.
  xJust: z.string().trim().min(15, 'xJust deve ter ao menos 15 caracteres').max(255),
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
    const result = await cancelarPedido(
      getAdminFirestore(),
      runtimeInstance,
      body.pedidoId,
      body.xJust,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof NFePedidoNotFoundError) {
      return authError(404, { error: e.message });
    }
    if (e instanceof NFeCancelamentoError) {
      // Surface the SEFAZ cStat + xMotivo (when present) so the client can show
      // a clean rejection message instead of the raw error string.
      return authError(422, { error: e.message, cStat: e.cStat, xMotivo: e.xMotivo });
    }
    if (e instanceof NFeOrchestratorError) {
      return authError(400, { error: e.message });
    }
    safeLog('error', '[nfe/cancelar]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

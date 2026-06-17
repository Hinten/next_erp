/**
 * `POST /api/nfe/emitir-lote` — batch emit up to 50 pedidos per request.
 *
 * Mirrors `emitir/route.ts` but for `emitirPedidosLote`. Per-pedido
 * failures are part of the JSON response body (HTTP 200 with `results[i]`
 * shaped as either an EmitResult or an EmitError) — HTTP-level errors
 * only fire for auth / validation / runtime-boot failures.
 *
 * Returns:
 *   200 { results: Array<EmitResult | EmitError> }   — mixed per-pedido outcomes
 *   400  bad body (empty pedidoIds, >50, malformed JSON)
 *   401  no/invalid token
 *   403  insufficient perm
 *   503  runtime not ready
 *   500  uncaught error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import { emitirPedidosLote, NFeOrchestratorError } from '@/lib/nfe/orchestrator';
import { getNFeRuntime } from '@/lib/nfe/runtime';
import { createTaskScheduler, NFeTasksConfigError } from '@/lib/nfe/tasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  pedidoIds: z.array(z.string().min(1).max(200)).min(1).max(50),
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
    const result = await emitirPedidosLote(
      getAdminFirestore(),
      runtimeInstance,
      body.pedidoIds,
      createTaskScheduler(),
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof NFeTasksConfigError) {
      return authError(503, { error: e.message, code: e.name });
    }
    if (e instanceof NFeOrchestratorError) {
      return authError(400, { error: e.message });
    }
    safeLog('error', '[nfe/emitir-lote]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

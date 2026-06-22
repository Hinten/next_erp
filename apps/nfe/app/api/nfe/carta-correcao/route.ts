/**
 * `POST /api/nfe/carta-correcao` — register a carta de correção eletrônica
 * (CC-e) for an authorized NF-e (RecepcaoEvento, tpEvento=110110).
 *
 * Computes the next `nSeqEvento`, sends the CC-e evento, and persists a durable
 * `cartacorrecao` record. A CC-e can be issued many times per NF-e (each a new
 * sequence).
 *
 * Returns:
 *   200 { …, cStat:'135', accepted:true, pending:false } — registrada e vinculada
 *   200 { …, cStat:'136', accepted:false, pending:true } — registrada, aguardando
 *        vínculo: an async re-send was enqueued (the client shows "em processamento"),
 *        the re-check resolves it to 135 or, past the cap, to error (#81)
 *   400  bad body / orchestrator precondition (missing chave, etc.)
 *   401  no/invalid token
 *   403  insufficient perm
 *   404  pedido / NF-e not found
 *   422  SEFAZ rejected the CC-e (any other cStat), or the NF-e isn't aprovada
 *   500  signer / transport error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { NFeCertError, sanitizeNFeText } from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import {
  cartaCorrecaoService,
  NFeCartaCorrecaoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';
import { getNFeRuntime } from '@/lib/nfe/runtime';
import { createTaskScheduler } from '@/lib/nfe/tasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z
  .object({
    pedidoId: z.string().min(1).max(200),
    // The specific nfev4 doc id — a pedido may hold more than one NF-e.
    nfeId: z.string().min(1).max(200),
    // SEFAZ requires the correction text to be 15–1000 chars.
    xCorrecao: z.string().trim().min(15, 'xCorrecao deve ter ao menos 15 caracteres').max(1000),
  })
  // The builder sanitizes xCorrecao (drops SEFAZ-restricted chars, collapses
  // spaces) before emitting <xCorrecao>; validate the SANITIZED length so a
  // correction that passes .min(15) raw can't reach SEFAZ below the 15-char
  // minimum (which SEFAZ rejects — and rejected events count toward consumo
  // indevido).
  .refine((b) => (sanitizeNFeText(b.xCorrecao) ?? '').length >= 15, {
    message:
      'A correção fica com menos de 15 caracteres após remover caracteres não aceitos pela SEFAZ.',
    path: ['xCorrecao'],
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
    const result = await cartaCorrecaoService(
      getAdminFirestore(),
      runtimeInstance,
      body.pedidoId,
      body.nfeId,
      body.xCorrecao,
      createTaskScheduler(),
    );
    // 200 for both registrada (135) and aguardandoVinculo (136 → pending); only
    // a hard rejection (any other cStat) throws NFeCartaCorrecaoError → 422.
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof NFePedidoNotFoundError) {
      return authError(404, { error: e.message });
    }
    if (e instanceof NFeCartaCorrecaoError) {
      // Surface the SEFAZ cStat + xMotivo (when present) so the client can show
      // a clean rejection message instead of the raw error string.
      return authError(422, { error: e.message, cStat: e.cStat, xMotivo: e.xMotivo });
    }
    if (e instanceof NFeOrchestratorError) {
      return authError(400, { error: e.message });
    }
    if (e instanceof NFeCertError) {
      // No SEFAZ contact — per-filial cert pre-flight failure. The `code` lets
      // the client show the pt-BR message instead of "SEFAZ rejected".
      return authError(422, { error: e.message, code: e.name });
    }
    safeLog('error', '[nfe/carta-correcao]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

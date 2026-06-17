/**
 * `POST /api/nfe/reconciliar` — Cloud Task target: reconcile one async lote.
 *
 * Triggered by a Cloud Task scheduled at `now + tMed` (then per-attempt backoff)
 * carrying `{ kind, filialId, nRec, tpEmis, attempt }`. Consults the lote by
 * receipt (`consReciNFe`), applies the per-chave outcome, and — while still
 * `cStat=105` and under the attempt cap — re-enqueues the next consult.
 *
 * Auth: a Google **OIDC** token from the `nfe-task-runner` service account
 * (`verifyServiceCaller`), NOT a Firebase user token — Cloud Tasks mints the
 * OIDC token at dispatch.
 *
 * Status-code contract (Cloud Tasks retries on non-2xx):
 *   - **200** on any handled outcome — including `cStat=656` (consumo indevido),
 *     which is terminal: we must NOT let Cloud Tasks retry it (re-querying after
 *     656 risks a SEFAZ ban, #77).
 *   - **4xx** on bad auth / bad body (no point retrying).
 *   - **5xx** only on runtime-not-ready or an unexpected transport error, where
 *     a bounded Cloud Tasks retry (governed by the queue's conservative
 *     retryConfig) is the right recovery.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { nextConsultaDelayMs } from '@delfrance/integrations-nfe';

import { allowedServiceEmails, authError, verifyServiceCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { getNFeRuntime } from '@/lib/nfe/runtime';
import { resolveFilialRuntime } from '@/lib/nfe/filial-cert';
import { reconcileByRecibo } from '@/lib/nfe/orchestrator/reconcile';
import {
  consultaTaskPayloadSchema,
  createTaskScheduler,
  NFeTasksConfigError,
} from '@/lib/nfe/tasks';
import { safeErrorShape } from '@/lib/nfe/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  // OIDC service-caller check (Cloud Tasks). Audience = our own reconcile URL.
  const auth = await verifyServiceCaller(req, {
    audience: process.env.NFE_TASKS_ENDPOINT,
    allowedEmails: allowedServiceEmails(),
  });
  if ('error' in auth) return auth.error;

  let payload: z.infer<typeof consultaTaskPayloadSchema>;
  try {
    payload = consultaTaskPayloadSchema.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError)
      return authError(400, { error: e.issues[0]?.message ?? 'bad body' });
    if (e instanceof SyntaxError) return authError(400, { error: 'Bad JSON body' });
    throw e;
  }

  // Build the scheduler UP FRONT so a missing-config error fails before any
  // SEFAZ consult — never after, where a 500 would retry the whole task and
  // re-consult (consumo-indevido risk).
  let scheduler;
  try {
    scheduler = createTaskScheduler();
  } catch (e) {
    if (e instanceof NFeTasksConfigError) return authError(503, { error: e.message, code: e.name });
    throw e;
  }

  let baseRt;
  try {
    baseRt = getNFeRuntime();
  } catch (e) {
    return authError(503, { error: e instanceof Error ? e.message : 'runtime not ready' });
  }

  const fs = getAdminFirestore();
  const { filialId, nRec, tpEmis, attempt } = payload;

  try {
    const rt = await resolveFilialRuntime(fs, baseRt, filialId);
    const result = await reconcileByRecibo({
      fs,
      rt,
      filialId,
      nRec,
      tpEmis,
      attempt,
    });

    // Still processing (under the cap) → schedule the next consult with backoff.
    // 656 and the attempt cap leave `stillPending === 0`, so neither re-enqueues.
    if (result.stillPending > 0) {
      const nextAttempt = attempt + 1;
      await scheduler.enqueueConsulta({
        filialId,
        nRec,
        tpEmis,
        attempt: nextAttempt,
        scheduleAtMs: Date.now() + nextConsultaDelayMs(nextAttempt),
      });
      return NextResponse.json({ ...result, reEnqueued: true, nextAttempt });
    }

    return NextResponse.json({ ...result, reEnqueued: false });
  } catch (e) {
    // Transport / unexpected error: a bounded Cloud Tasks retry (queue
    // retryConfig) is the recovery. Never log the raw error (may carry SEFAZ
    // XML); the backstop sweep also covers a permanently-failing task.
    const shape = safeErrorShape(e);
    return authError(502, { error: `Falha ao reconciliar lote: ${shape.name}` });
  }
}

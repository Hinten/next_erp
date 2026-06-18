/**
 * `POST /api/nfe/processar-pendentes` — anti-loss poller (manual / ops trigger).
 *
 * Thin HTTP adapter: auth (Firebase user, `PERM.fiscal.write`) + parse + build
 * runtime/Firestore, then delegate to the shared `runProcessarPendentes` core
 * (also executed in-process by the `nfeReconcileSweep` Cloud Function). Returns
 * `{ scanned, recovered, stillPending, errors }`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { DEFAULT_STUCK_TIMEOUT_MS } from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { getNFeRuntime } from '@/lib/nfe/runtime';
import { runProcessarPendentes } from '@/lib/nfe/handlers/runProcessarPendentes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z
  .object({
    batchSize: z.number().int().min(1).max(500).default(100),
    timeoutMs: z.number().int().min(60_000).default(DEFAULT_STUCK_TIMEOUT_MS),
  })
  .partial()
  .default({});

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.write);
  if ('error' in auth) return auth.error;

  let params: z.infer<typeof bodySchema>;
  try {
    const rawBody = await req.text();
    params = bodySchema.parse(rawBody ? JSON.parse(rawBody) : {});
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: e.issues[0]?.message ?? 'bad body' });
    }
    if (e instanceof SyntaxError) {
      return authError(400, { error: 'Bad JSON body' });
    }
    throw e;
  }

  let baseRt;
  try {
    baseRt = getNFeRuntime();
  } catch (e) {
    return authError(503, { error: e instanceof Error ? e.message : 'runtime not ready' });
  }

  const result = await runProcessarPendentes({ fs: getAdminFirestore(), baseRt, params });
  return NextResponse.json(result);
}

/**
 * `POST /api/nfe/verificar` — manual re-verification of enviNfe audit msgs
 * (the "Verificar novamente" action on `/nfe/comunicacoes`).
 *
 * Thin HTTP adapter: auth (Firebase user, `PERM.fiscal.write` — the run
 * mutates nfev4 docs + appends audit msgs) + parse + build runtime/Firestore,
 * then delegate to `verificarEnviNfeMsgs`. A valid authorized request always
 * returns **200** with the `VerificarEnviNfeResult` body — per-chave failures
 * live in its `results[]` entries, never as an HTTP error.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { NFeCertError, NFeTransportError } from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import { verificarEnviNfeMsgs } from '@/lib/nfe/orchestrator/verificar';
import { getNFeRuntime, NFeRuntimeConfigError } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Ids become Firestore path segments (`filiais/{filialId}/enviNfe/{msgId}`) —
// a '/' would make the Admin SDK throw on an invalid path (unhandled 500).
const pathSegment = z
  .string()
  .min(1)
  .regex(/^[^/]+$/, 'não pode conter "/"');

const bodySchema = z.object({
  filialId: pathSegment,
  // 1..10 msgs per call — the UI sends exactly one. This caps the number of
  // msg LOOKUPS; the per-request SEFAZ fan-out is bounded separately by
  // `MAX_CHAVES_POR_VERIFICACAO` in `verificarEnviNfeMsgs` (a legacy batch
  // msg can carry many chaves in `targetsChnfe`, so 10 msgs alone would not
  // prevent a consulta burst).
  enviNfeMsgIds: z.array(pathSegment).min(1).max(10),
});

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.write);
  if ('error' in auth) return auth.error;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
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
    // Misconfigured runtime (bad NFE_AMBIENTE / missing TLS chain) → 503.
    // Anything else is a genuine bug and must surface, not hide behind a 503.
    if (e instanceof NFeRuntimeConfigError) {
      return authError(503, { error: e.message });
    }
    throw e;
  }

  try {
    const result = await verificarEnviNfeMsgs(getAdminFirestore(), baseRt, body);
    return NextResponse.json(result);
  } catch (e) {
    // No usable A1 for the filial — resolved before any SEFAZ contact.
    if (e instanceof NFeCertError) {
      return authError(422, { error: e.message, code: e.name });
    }
    // A transport failure outside the per-chave isolation (rare). Message
    // only — `responseBody` (raw SEFAZ reply) never leaves the server.
    if (e instanceof NFeTransportError) {
      safeLog('error', '[nfe/verificar]', e);
      return authError(500, { error: e.message });
    }
    throw e;
  }
}

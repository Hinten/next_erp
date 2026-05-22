/**
 * `POST /api/nfe/processar-pendentes` — anti-loss poller.
 *
 * Collection-group scans the `nfev4` subcollections for NF-e docs stuck
 * in `enviando` / `aguardandoResposta` past the timeout, then queries
 * SEFAZ via `consultarSituacaoNFe(chave)` to learn the true status
 * (the doc still carries the chave + `xml_assinado` from the
 * persist-before-send step).
 *
 * Driven by Cloud Scheduler. Required perm: `fiscal.write` (or service
 * account with the same claim).
 *
 * Returns `{ scanned, recovered, stillPending, errors }` so the
 * scheduler can log the per-run shape.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  applyOutcome,
  consultarSituacaoNFe,
  DEFAULT_STUCK_TIMEOUT_MS,
  isStuckEnviando,
  outcomeFromRetConsSit,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe } from '@delfrance/schemas';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z
  .object({
    batchSize: z.number().int().min(1).max(500).default(100),
    timeoutMs: z.number().int().min(60_000).default(DEFAULT_STUCK_TIMEOUT_MS),
  })
  .partial()
  .default({});

interface PendingDoc {
  readonly path: string;
  readonly estado: EstadoNFe;
  readonly chave: string | null;
  readonly ultima_modificacao: string | null;
  readonly retries: number | null;
}

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

  let runtimeInstance;
  try {
    runtimeInstance = getNFeRuntime();
  } catch (e) {
    return authError(503, { error: e instanceof Error ? e.message : 'runtime not ready' });
  }

  const fs = getAdminFirestore();
  const batchSize = params.batchSize ?? 100;
  const timeoutMs = params.timeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
  const now = new Date();

  const snap = await fs
    .collectionGroup('nfev4')
    .where('estado', 'in', [ESTADO_NFE.enviando, ESTADO_NFE.aguardandoResposta])
    .limit(batchSize)
    .get();

  let scanned = 0;
  let recovered = 0;
  let stillPending = 0;
  const errors: { chave: string | null; error: string }[] = [];

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data() as PendingDoc;
    const stuck = isStuckEnviando(
      { estado: data.estado, ultima_modificacao: data.ultima_modificacao ?? null },
      now,
      timeoutMs,
    );
    if (!stuck) {
      stillPending++;
      continue;
    }
    if (!data.chave) {
      errors.push({ chave: null, error: `${doc.ref.path}: missing chave on stuck doc` });
      continue;
    }
    try {
      const retSit = await consultarSituacaoNFe(
        {
          url: runtimeInstance.endpoints.NfeConsultaProtocolo,
          cert: runtimeInstance.cert,
          agent: runtimeInstance.agent,
          tpAmb: runtimeInstance.tpAmb,
        },
        { chave: data.chave },
      );
      const outcome = outcomeFromRetConsSit(retSit);
      const patch = applyOutcome({ estado: data.estado, retries: data.retries }, outcome);
      await doc.ref.set(
        {
          estado: patch.estado,
          cStat: patch.cStat,
          xMotivo: patch.xMotivo,
          retries: patch.retries,
          nRec: patch.nRec,
          ultima_modificacao: new Date().toISOString(),
        },
        { merge: true },
      );
      recovered++;
    } catch (e) {
      errors.push({
        chave: data.chave,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({ scanned, recovered, stillPending, errors });
}

/**
 * `POST /api/marketplace/amazon/atualizar-precos/cancelar` — cancel the conta's
 * price run (master plan step 13, PR 13-g). Body: `{ integracaoId }`, strict.
 * Answers 200 `respostaCancelamentoExecucaoPrecoAmazonSchema` (`{ execucaoId,
 * fase }`: `cancelada` — a live run, or an ended one with work still in flight —,
 * or the phase of an ended run with nothing in flight, answered unchanged), or
 * the `erroPrecoAmazonSchema` envelope: 404
 * `AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA` when the conta has no run, the body,
 * conta and read-switch refusals.
 *
 * THIN: the strict body, the read switch and the conta live in
 * `lib/amazon/preco/envioManualPreco.ts`; the cancel in
 * `lib/amazon/preco/inicioExecucaoPreco.ts`: ONE tier-1 write through the
 * run's one write helper. The run's pages, tasks and batches stand down on its
 * phase; a feed already submitted is not cancelled, and a 15-minute read-back
 * of a patch already sent still runs (at most one re-send of that same offer).
 * No Amazon call, no enqueue.
 *
 * `PERM.integracao.write`, as the run it stops. What the bodies rethrow
 * reaches the platform as a 500. Every answer built here carries
 * `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { comCabecalhosAmazon, respostaJson } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { cancelarAtualizacaoPrecosAmazon } from '@/lib/amazon/preco/envioManualPreco';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await cancelarAtualizacaoPrecosAmazon(req, {
    ambiente: process.env,
    db: getAdminFirestore,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
  });
  return respostaJson(r.status, r.corpo);
}

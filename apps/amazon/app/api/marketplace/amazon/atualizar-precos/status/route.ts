/**
 * `GET /api/marketplace/amazon/atualizar-precos/status?integracaoId=<id>` — the
 * conta's price run as it stands (master plan step 13, PR 13-g). Answers 200
 * `resumoExecucaoPrecoAmazonSchema` (its phase, counts, decision and batches —
 * each with its recorded end, `pendente` or `sem-desfecho` —, `parada` for a
 * live run 15 minutes without progress, and the conta's price feed in flight
 * with its age), or the `erroPrecoAmazonSchema` envelope: 404
 * `AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA` when the conta has no run, the query,
 * conta and read-switch refusals.
 *
 * THIN: the strict query, the read switch and the conta live in
 * `lib/amazon/preco/envioManualPreco.ts`; the summary in
 * `lib/amazon/preco/inicioExecucaoPreco.ts`, which reads the run and the price
 * lease raw by id, masked. READ-ONLY: no Amazon call, no Firestore write, no
 * enqueue.
 *
 * `PERM.integracao.write`, as the run it reports on. What the bodies rethrow
 * (a stored run or lease that no longer parses, a Firestore failure) reaches
 * the platform as a 500. Every answer built here carries
 * `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { comCabecalhosAmazon, respostaJson } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { resumoAtualizacaoPrecosAmazon } from '@/lib/amazon/preco/envioManualPreco';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await resumoAtualizacaoPrecosAmazon(req, {
    ambiente: process.env,
    db: getAdminFirestore,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
  });
  return respostaJson(r.status, r.corpo);
}

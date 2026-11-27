/**
 * `POST /api/marketplace/amazon/enviar-precos` — push the CURRENT price of a
 * hand-picked set of produtos to their Amazon listings (master plan step 13,
 * PR 13-g): ONE named price task per sendable SKU of the conta onto the jobs
 * queue `processAmazonListingsJob` (`tipo: 'preco-sku'`). Body:
 * `{ integracaoId, produtoIds[1..50], baixarPreco? }`, strict (`baixarPreco`
 * absent ⇒ `false`: no `our_price` decrease without the operator's consent).
 * Answers 200 `envioPrecoManualAmazonSchema` (one row per listing, even when
 * none was sent; never a price), or the `{ error, code, issues?, detalhes? }`
 * envelope (`erroPrecoAmazonSchema`, codes from `CODIGO_ERRO_PRECO_AMAZON` plus
 * the read switch's `AMAZON_CHAMADAS_DESLIGADAS`).
 *
 * THIN: every decision — the strict body, the read switch and the queue's
 * region before any read, the conta and its normal tabela, the anchor hop, the
 * listings, the per-SKU skips, the 30-SKU bound, the ONE batch of named
 * enqueues and the budget — lives in `lib/amazon/preco/envioManualPreco.ts`.
 * ENQUEUE-ONLY: no Amazon call, no Firestore write, no price computed, and no
 * price write valve, canary list or preview flag read here (the task decides
 * at run time).
 *
 * `PERM.integracao.write`: the action is conta-scoped, and its callers are
 * the people who run the channel. The web dialog's Amazon provider comes
 * later; `apps/web` is not touched here.
 *
 * What the body module rethrows (a missing or malformed region, a Cloud Tasks
 * transient, a raw SDK failure already sanitized, a Firestore failure) reaches
 * the platform as a 500: part of the batch may have been enqueued, so no coded
 * answer is invented for it. Every answer built here carries
 * `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  filaLotesDesligadaAmazon,
  produtorDaFilaPrecoAmazon,
  regiaoDaFilaLeituraAmazon,
} from '@/lib/firebase/filaLeitura';
import { comCabecalhosAmazon, respostaJson } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { enviarPrecoManualAmazon } from '@/lib/amazon/preco/envioManualPreco';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await enviarPrecoManualAmazon(req, {
    ambiente: process.env,
    db: getAdminFirestore,
    filaDesligada: filaLotesDesligadaAmazon(),
    regiao: regiaoDaFilaLeituraAmazon,
    produtor: produtorDaFilaPrecoAmazon,
    agora: () => Date.now(),
    // The Web Crypto global: a request id, never a digest of the selection.
    gerarReferencia: () => crypto.randomUUID(),
    logger: LOGGER_STDOUT_AMAZON,
  });
  return respostaJson(r.status, r.corpo);
}

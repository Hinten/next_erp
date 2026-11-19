/**
 * `POST /api/marketplace/amazon/enviar-estoque` — push the CURRENT stock of a
 * hand-picked set of produtos to their Amazon listings (master plan step 12,
 * PR 12-g): ONE named patch task per SKU of the conta onto the stock queue
 * `processAmazonStockPatch`. Body: `{ integracaoId, produtoIds[1..50] }`,
 * strict. Answers 200 `envioEstoqueManualAmazonSchema` (one row per listing,
 * even when none was sent), or the `{ error, code, issues?, detalhes? }`
 * envelope (`erroEnvioEstoqueManualAmazonSchema`, codes from
 * `CODIGO_ERRO_ESTOQUE_AMAZON` plus the read switch's
 * `AMAZON_CHAMADAS_DESLIGADAS`).
 *
 * THIN: every decision — the strict body, the read switch and the queue's
 * region before any read, the conta and its depósito, the anchor hop, the
 * listings, the 30-SKU bound, the ONE batch of named enqueues and the budget —
 * lives in `lib/amazon/estoque/envioManualEstoque.ts`. ENQUEUE-ONLY: no Amazon
 * call, no Firestore write, and the stock write valve is never read here (the
 * task decides at run time).
 *
 * `PERM.integracao.write`, not a pedido bit: the action is conta-scoped (this
 * conta's listings), and its callers are the people who run the channel. The
 * web dialog's Amazon provider comes later; `apps/web` is not touched here.
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
  filaEstoqueDesligadaAmazon,
  produtorDaFilaEstoqueAmazon,
  regiaoDaFilaLeituraAmazon,
} from '@/lib/firebase/filaLeitura';
import { comCabecalhosAmazon, respostaJson } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { enviarEstoqueManualAmazon } from '@/lib/amazon/estoque/envioManualEstoque';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await enviarEstoqueManualAmazon(req, {
    ambiente: process.env,
    db: getAdminFirestore,
    filaDesligada: filaEstoqueDesligadaAmazon(),
    regiao: regiaoDaFilaLeituraAmazon,
    produtor: produtorDaFilaEstoqueAmazon,
    agora: () => Date.now(),
    // The Web Crypto global: a request id, never a digest of the selection.
    gerarReferencia: () => crypto.randomUUID(),
    logger: LOGGER_STDOUT_AMAZON,
  });
  return respostaJson(r.status, r.corpo);
}

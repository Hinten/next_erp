/**
 * `POST /api/marketplace/amazon/etiqueta` — the Easy Ship ZPL label of ONE Amazon
 * pedido, in the request (master plan step 15, PR 15-d). Body: `{ pedidoId }`,
 * strict. Answers 200 with the label's bytes (`Content-Type` exactly `text/plain`,
 * an attachment named `amazon-<orderId>.zpl`), or the `{ error, code, issues?,
 * motivo? }` envelope (`erroEtiquetaAmazonSchema`, codes from
 * `CODIGO_ERRO_ETIQUETA_AMAZON` plus the read switch's
 * `AMAZON_CHAMADAS_DESLIGADAS`).
 *
 * THIN: every decision lives in `lib/amazon/agendamento/etiquetaAmazon.ts`. A route
 * handler in this API-only backend because the label must be in the request's
 * answer: the zip behind Amazon's pre-signed link lives for minutes and is never
 * stored, and a functions HTTPS endpoint would be a new surface for no gain
 * (step-15 plan §3 decision 13).
 *
 * `PERM.frete.read` prints; `PERM.frete.write` is what may make a FIRST schedule,
 * since for an order not scheduled yet the same Amazon call schedules it. A reprint
 * over an existing schedule needs only the read bit.
 *
 * What the body module rethrows (the LWA pair missing from the deploy, a Firestore
 * failure, a bug) reaches the platform as a 500. Every answer built here carries
 * `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';
import { hasPerm } from '@delfrance/auth';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { imprimirEtiquetaAmazon } from '@/lib/amazon/agendamento/etiquetaAmazon';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { comCabecalhosAmazon, respostaEtiquetaZpl, respostaJson } from '@/lib/amazon/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await imprimirEtiquetaAmazon(req, {
    ambiente: process.env,
    db: getAdminFirestore,
    logger: LOGGER_STDOUT_AMAZON,
    podeAgendar: hasPerm(auth.caller.permissions, PERM.frete.write),
  });
  return r.tipo === 'zpl' ? respostaEtiquetaZpl(r) : respostaJson(r.status, r.corpo);
}

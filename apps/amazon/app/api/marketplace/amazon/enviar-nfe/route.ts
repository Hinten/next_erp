/**
 * `POST /api/marketplace/amazon/enviar-nfe` — re-drive the NF-e upload of ONE
 * Amazon pedido (master plan step 14, PR 14-d): put its approved sale NF-e back
 * on the NF-e queue `processAmazonNfeUpload`. Body: `{ pedidoId, nfeId? }`,
 * strict. Answers 202 `respostaEnvioNfeAmazonSchema` (`{ enfileirado: true,
 * pedidoId, nfeId }`), or the `{ error, code, issues?, motivo? }` envelope
 * (`erroEnvioNfeAmazonSchema`, codes from `CODIGO_ERRO_NFE_AMAZON` plus the
 * read switch's `AMAZON_CHAMADAS_DESLIGADAS`).
 *
 * THIN: every decision — the strict body, the read switch and the queue valve
 * before any read, the pedido's proof, the slot, the ONE unnamed enqueue —
 * lives in `lib/amazon/nfe/reenvioNfe.ts`. ENQUEUE-ONLY: no Amazon call, no
 * Firestore write, and the NF-e write valve is never read here (the task
 * decides at run time; step-14 plan §3 decision 20).
 *
 * `PERM.pedido.write`, not the `integracao` bit the conta routes use: the action
 * is pedido-scoped (send THIS pedido's note), and its callers are the people
 * who handle orders — the same choice as the other channels' `enviar-nfe`.
 * The button and its copy are master-plan step 21's (step-14 plan §3 decision
 * 21); `apps/web` is not touched here.
 *
 * What the body module rethrows (a missing or malformed region — checked before
 * any read —, a Cloud Tasks transient, a raw SDK failure already sanitized, a
 * Firestore failure) reaches the platform as a 500: the outcome is unknown, so
 * no coded answer is invented for it (`reenvioNfe.ts`, "An enqueue that
 * fails"). Every answer built here carries `Cache-Control: no-store` and
 * `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  agendadorDaFilaNfeAmazon,
  filaNfeDesligadaAmazon,
  regiaoDaFilaLeituraAmazon,
} from '@/lib/firebase/filaLeitura';
import { comCabecalhosAmazon, respostaJson } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { reenviarNfeAmazon } from '@/lib/amazon/nfe/reenvioNfe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.pedido.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await reenviarNfeAmazon(req, {
    ambiente: process.env,
    db: getAdminFirestore,
    filaDesligada: filaNfeDesligadaAmazon(),
    regiao: regiaoDaFilaLeituraAmazon,
    agendador: agendadorDaFilaNfeAmazon,
    logger: LOGGER_STDOUT_AMAZON,
  });
  return respostaJson(r.status, r.corpo);
}

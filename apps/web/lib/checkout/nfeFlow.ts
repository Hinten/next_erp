import { getDocs, type Firestore } from 'firebase/firestore';
import { ESTADO_NFE } from '@delfrance/schemas';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import { nfeCollection } from '../data/nfeCollection';
import {
  notificationForNFeError,
  notificationForNFeResult,
  type NotificationShape,
} from '../nfe/errors';
import { downloadDanfe, printDanfe } from '../nfe/downloadDanfe';
import type { printJob } from '../print-agent/printJob';

/**
 * The checkout NF-e flow. NO polling: `apps/nfe` sends a single-NFe lote with
 * `indSinc='1'`, so `emitir` resolves with the FINAL SEFAZ estado (the legacy
 * 6×10s poll loop is dead weight). `emitir` also carries `nfeId`/`chave`, so an
 * approval needs no re-fetch.
 */

/** The latest printable (aprovada / EPEC-aprovada) NF-e of a pedido, or null. */
export async function resolveAprovadaNfe(
  db: Firestore,
  pedidoId: string,
): Promise<{ nfeId: string; chave: string } | null> {
  const snap = await getDocs(nfeCollection.ref(db, { pedidoId }));
  const authorized = snap.docs
    .filter((d) => {
      const n = d.data();
      return (
        (n.estado === ESTADO_NFE.aprovada || n.estado === ESTADO_NFE.epecAprovado) &&
        n.chave != null
      );
    })
    .sort((a, b) => (b.data().ultima_modificacao ?? 0) - (a.data().ultima_modificacao ?? 0));
  const first = authorized[0];
  if (first === undefined) return null;
  const chave = first.data().chave;
  return chave != null ? { nfeId: first.id, chave } : null;
}

export type EnsureNfeResult =
  | { ok: true; nfeId: string; chave: string; reused: boolean }
  /** the NF-e is processing async (enviando / aguardandoResposta) — the reconciler lands it. */
  | { ok: false; pending: true }
  /** rejected or errored — carries a ready-to-show notification. */
  | { ok: false; pending: false; notification: NotificationShape };

/**
 * Ensure the pedido has a printable NF-e: reuse an existing aprovada/EPEC doc, or
 * emit one. The server dedups (an existing bloqueada NF-e → `reused:true`), so
 * this reproduces the legacy "aprovada OR bloqueada → don't re-emit". A pending
 * estado is NOT an error — the async reconciler finishes it; the operator reprints
 * from the Outros Checkouts panel. Errors narrow to the typed NF-e classes (per
 * the no-generic-catch rule); anything unexpected rethrows.
 */
export async function ensureNfeAprovada(
  db: Firestore,
  client: NFeHttpClient,
  pedidoId: string,
): Promise<EnsureNfeResult> {
  const existing = await resolveAprovadaNfe(db, pedidoId);
  if (existing !== null) return { ok: true, ...existing, reused: true };

  try {
    const result = await client.emitir(pedidoId);
    if (result.estado === ESTADO_NFE.aprovada || result.estado === ESTADO_NFE.epecAprovado) {
      return { ok: true, nfeId: result.nfeId, chave: result.chave, reused: result.reused ?? false };
    }
    if (result.estado === ESTADO_NFE.enviando || result.estado === ESTADO_NFE.aguardandoResposta) {
      return { ok: false, pending: true };
    }
    return { ok: false, pending: false, notification: notificationForNFeResult(result) };
  } catch (err) {
    if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
      return { ok: false, pending: false, notification: notificationForNFeError(err) };
    }
    throw err;
  }
}

/** The checkout sidebar's DANFE-format dropdown. */
export type CheckoutDanfeFormat = 'simplificadoPdf' | 'retrato' | 'paisagem' | 'simplificadoZpl2';

/**
 * Map the checkout DANFE-format dropdown to the underlying print/download call.
 * The A4 formats deliberately print via the agent (legacy A4 was download-only);
 * `simplificadoZpl2` still DOWNLOADS. Returns which delivery path ran.
 *
 * On the ZPL question this used to say the agent's raw-ZPL passthrough was
 * "unverified", which reads as unknown-and-unknowable. It is narrower than that:
 * the agent has a `text/plain` → `_printPlainText` branch doing a `RAW` spooler
 * write (`printJob.dart:268`), and that function already runs in production for
 * marketplace ZPL — but reached through `_printFromZip`, never from a top-level
 * `text/plain` job. `lib/checkout/etiqueta/providers/genericLabel.ts` is the
 * first caller to use that entry point (#376). Once a real Zebra has confirmed
 * it, this can switch to `printDanfe(..., 'etq')` too; until then a download is
 * the honest default for a fiscal document.
 */
export async function printDanfeForCheckout(
  client: NFeHttpClient,
  pedidoId: string,
  nfeId: string,
  format: CheckoutDanfeFormat,
  printJobFn?: typeof printJob,
): Promise<'printed' | 'downloaded'> {
  switch (format) {
    case 'simplificadoPdf':
      return printDanfe(client, pedidoId, nfeId, 'simplificado', 'etq', printJobFn);
    case 'retrato':
      return printDanfe(client, pedidoId, nfeId, 'retrato', 'a4', printJobFn);
    case 'paisagem':
      return printDanfe(client, pedidoId, nfeId, 'paisagem', 'a4', printJobFn);
    case 'simplificadoZpl2':
      await downloadDanfe(client, pedidoId, nfeId, 'zpl2');
      return 'downloaded';
  }
}

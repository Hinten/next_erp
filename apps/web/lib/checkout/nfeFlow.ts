import { getDocs, type Firestore } from 'firebase/firestore';
import { ESTADO_NFE, nfeImprimivel } from '@delfrance/schemas';
import {
  NFeHttpError,
  NFeNetworkError,
  NFeTimeoutError,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import { nfeCollection } from '../data/nfeCollection';
import { carregadorContextoRejeicao } from '../nfe/contextoRejeicao';
import {
  notificationForNFeErrorComContexto,
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

/**
 * The latest printable NF-e of a pedido (`nfeImprimivel` — aprovada, or
 * EPEC-aprovada WITH its EPEC protocol), or null. An EPEC whose protocol was
 * never recovered (#1675) is not printable: apps/nfe refuses its DANFE.
 */
export async function resolveAprovadaNfe(
  db: Firestore,
  pedidoId: string,
): Promise<{ nfeId: string; chave: string } | null> {
  return (await lerNfesDoPedido(db, pedidoId)).imprimivel;
}

/**
 * One read of the pedido's nfev4 docs: the latest printable one, and whether an
 * EPEC-approved doc WITHOUT its protocol is there (#1675 — registered by an
 * earlier send, protocol not recovered: nothing to print, and nothing an emit
 * may usefully do, since its full NF-e is transmitted after the outage).
 */
async function lerNfesDoPedido(
  db: Firestore,
  pedidoId: string,
): Promise<{
  imprimivel: { nfeId: string; chave: string } | null;
  epecSemProtocolo: boolean;
}> {
  const snap = await getDocs(nfeCollection.ref(db, { pedidoId }));
  const epecSemProtocolo = snap.docs.some((d) => {
    const n = d.data();
    return n.estado === ESTADO_NFE.epecAprovado && !nfeImprimivel(n);
  });
  const authorized = snap.docs
    .filter((d) => {
      const n = d.data();
      return nfeImprimivel(n) && n.chave != null;
    })
    .sort((a, b) => (b.data().ultima_modificacao ?? 0) - (a.data().ultima_modificacao ?? 0));
  const first = authorized[0];
  const chave = first?.data().chave ?? null;
  return {
    imprimivel: first !== undefined && chave != null ? { nfeId: first.id, chave } : null,
    epecSemProtocolo,
  };
}

/** What the checkout tells the operator about an EPEC whose protocol was never recovered. */
const EPEC_SEM_PROTOCOLO: NotificationShape = {
  title: 'EPEC já registrado — protocolo não recuperado',
  message:
    'A DANFE desta NF-e só sai após a transmissão da NF-e completa, quando a SEFAZ ' +
    'normalizar (automática quando a contingência for desligada).',
  color: 'yellow',
};

export type EnsureNfeResult =
  | { ok: true; nfeId: string; chave: string; reused: boolean }
  /**
   * The outcome is not final yet: the NF-e is processing async (enviando /
   * aguardandoResposta, which the reconciler lands), OR the emit call timed out
   * (#1094) and the emission may or may not be running. Either way the operator
   * reprints later — a reprint re-checks, and emits if nothing exists.
   */
  | { ok: false; pending: true }
  /** rejected or errored — carries a ready-to-show notification. */
  | { ok: false; pending: false; notification: NotificationShape };

/**
 * Ensure the pedido has a printable NF-e: reuse an existing aprovada/EPEC doc, or
 * emit one. The server dedups a repeat: a SEQUENTIAL one gets the existing
 * bloqueada NF-e back (`reused:true`), so this reproduces the legacy "aprovada OR
 * bloqueada → don't re-emit"; one that overlaps a still-running emission gets the
 * in-flight doc back (#1675 — `reused:true`, estado enviando → `pending` below),
 * with no second send. A timeout below is `pending` too, never an error: the
 * emission may still be running. A pending estado is NOT an error — the async
 * reconciler finishes it; the operator reprints from the Outros Checkouts panel.
 * Errors narrow to the typed NF-e classes (per the no-generic-catch rule);
 * anything unexpected rethrows.
 */
export async function ensureNfeAprovada(
  db: Firestore,
  client: NFeHttpClient,
  pedidoId: string,
): Promise<EnsureNfeResult> {
  const lidas = await lerNfesDoPedido(db, pedidoId);
  if (lidas.imprimivel !== null) return { ok: true, ...lidas.imprimivel, reused: true };
  // An EPEC registered without its protocol (#1675): an emit would only try the
  // pós-EPEC transmission (or, in EPEC mode, the down home SEFAZ) — say why the
  // DANFE is not available instead.
  if (lidas.epecSemProtocolo) {
    return { ok: false, pending: false, notification: EPEC_SEM_PROTOCOLO };
  }

  try {
    const result = await client.emitir(pedidoId);
    if (result.estado === ESTADO_NFE.aprovada) {
      return { ok: true, nfeId: result.nfeId, chave: result.chave, reused: result.reused ?? false };
    }
    if (result.estado === ESTADO_NFE.epecAprovado) {
      // Printable only with its EPEC protocol, which the result does not carry:
      // re-read the doc. An EPEC our earlier send registered but whose protocol
      // was never recovered (#1675) cannot print yet — say so instead of
      // sending the operator to a DANFE the server refuses.
      const imprimivel = await resolveAprovadaNfe(db, pedidoId);
      if (imprimivel !== null) return { ok: true, ...imprimivel, reused: result.reused ?? false };
      return { ok: false, pending: false, notification: notificationForNFeResult(result) };
    }
    if (result.estado === ESTADO_NFE.enviando || result.estado === ESTADO_NFE.aguardandoResposta) {
      return { ok: false, pending: true };
    }
    return { ok: false, pending: false, notification: notificationForNFeResult(result) };
  } catch (err) {
    // ⚠️ #1094: a timeout — our deadline, or the platform's gateway 504 — means
    // the emission may STILL BE RUNNING on the server, possibly mid-SOAP with
    // SEFAZ. That is "em processamento", not a failure: a red error here sends
    // the operator to reprint, and the reprint calls `emitir` again over the live
    // run. Checked before the generic arm because it is an `NFeNetworkError`.
    if (err instanceof NFeTimeoutError) return { ok: false, pending: true };
    if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
      // A cStat 805 rejection reads the rejected NF-e, the pedido and the cliente
      // (#852) so the notification can say what to fix and link the cadastro.
      // Those extra reads happen ONLY on 805 — every other error maps without a
      // read. On the reprint path (`reprintCheckout.ts`) they run INSIDE the
      // `withDeadline` wrapping this whole function (REPRINT_STAGE_TIMEOUT_MS,
      // 30s), so they share that budget rather than extending it.
      return {
        ok: false,
        pending: false,
        notification: await notificationForNFeErrorComContexto(err, carregadorContextoRejeicao(db)),
      };
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
 *
 * ⚠️ That switch is NOT a one-liner. The agent matches the content type with
 * `==`, and the DANFE route answers `text/plain; charset=utf-8`, which
 * `printDanfe` would forward as is: the job would fail inside the agent behind
 * a `200 OK`, so no download fallback and no toast. Send the bare `text/plain`,
 * as `genericLabel.ts` does.
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

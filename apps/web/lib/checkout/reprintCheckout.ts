import { getDoc, type Firestore } from 'firebase/firestore';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { MercadoLivreClient } from '../mercado-livre/client';
import type { ShopeeClient } from '../shopee/client';
import { pedidoCollection } from '../data/pedidoCollection';
import { notificationForNFeError, type NotificationShape } from '../nfe/errors';
import { ensureNfeAprovada, printDanfeForCheckout, type CheckoutDanfeFormat } from './nfeFlow';
import { resolverIntFrete } from './etiqueta/intFrete';
import { emitirOuImprimirEtiqueta } from './etiqueta/registry';
import type { EtiquetaOutcome, EtiquetaProviderUi } from './etiqueta/types';
import { printJob } from '../print-agent/printJob';
import { DeadlineExceededError, REPRINT_STAGE_TIMEOUT_MS, withDeadline } from './withDeadline';

/**
 * Reprint the NF-e DANFE and the shipping label for a SPECIFIC past checkout —
 * the "Outros Checkouts" panel action. The port of the legacy per-row reprint
 * (`.old/lib/despacho/pages/checkout.dart:2491-2537`), whose wrong-label bug was
 * a reprint handler bound (via an un-keyed list) to a NEIGHBOURING checkout.
 *
 * The armor here is structural: EVERY identifier is derived from the caller's
 * `pedidoId` (the frozen row's own id, parsed from its doc path), and the frete
 * is the LIVE `pedido.freteInicial` re-fetched for THAT pedido — never a shared
 * "current pedido" and never the frozen checkout snapshot. So a reprint can only
 * ever target its own row's order. Reuses the exact post-save machinery
 * (`ensureNfeAprovada` / `printDanfeForCheckout` / the etiqueta registry + gates)
 * so a reprint behaves identically to the original emit/print — including the
 * integração itself, which is `resolverIntFrete`, the one rule all three
 * etiqueta entry points share (#1523).
 */

export type ReprintEtiquetaResult =
  | EtiquetaOutcome
  | { status: 'no-pedido' }
  | { status: 'no-frete' }
  | { status: 'no-integration' }
  /**
   * A stage outlived its deadline. `stage` names WHICH await hung, so the toast
   * and any bug report point at one link in the chain instead of "it froze".
   */
  | { status: 'timeout'; stage: string; message: string };

/**
 * Reprint the shipping label for the pedido `pedidoId`. Fetches THAT pedido's
 * live frete, resolves its integração, and dispatches through the etiqueta
 * registry (sem-frete skip + already-posted risk confirm + carrier provider). A
 * Melhor Envio pedido with a `printLabelId` reprints its existing label; a
 * generic carrier rebuilds the PDF — same as the initial post-save path.
 */
export async function reprintCheckoutEtiqueta(args: {
  db: Firestore;
  pedidoId: string;
  freightClient: FreightHttpClient | null;
  nfeClient: NFeHttpClient | null;
  mercadoLivreClient: MercadoLivreClient | null;
  /** Required like the provider dep it feeds — a screen must say which client it threads. */
  shopeeClient: ShopeeClient | null;
  formato: 'pdf' | 'zpl2';
  ui: EtiquetaProviderUi;
  printJobFn?: typeof printJob;
  /** Per-stage deadline; defaults to {@link REPRINT_STAGE_TIMEOUT_MS}. */
  timeoutMs?: number;
}): Promise<ReprintEtiquetaResult> {
  const { db, pedidoId, freightClient, nfeClient, mercadoLivreClient, shopeeClient, formato, ui } =
    args;
  const timeoutMs = args.timeoutMs ?? REPRINT_STAGE_TIMEOUT_MS;

  // Every await here is bounded and NAMED. Before this, a stall in any one of
  // them left both modal buttons spinning on the shared print mutex with no
  // toast and no log — see `withDeadline`.
  try {
    const snap = await withDeadline(
      'carregar o pedido',
      getDoc(pedidoCollection.docRef(db, {}, pedidoId)),
      timeoutMs,
    );
    if (!snap.exists()) return { status: 'no-pedido' };
    const pedido = snap.data();
    const frete = pedido.freteInicial;
    if (frete === null) return { status: 'no-frete' };

    const intFrete = await withDeadline(
      'resolver a integração de frete',
      resolverIntFrete(db, frete),
      timeoutMs,
    );
    if (intFrete === null) return { status: 'no-integration' };

    // ⚠️ NOT bounded, for two independent reasons — either alone is sufficient.
    // (1) The registry can legitimately await the OPERATOR: the already-posted
    // risk confirm, the ME buy modal and the Shopee pickup/drop-off question
    // (`ui.escolherEnvio`) all block on a human, and a deadline would cancel a
    // dialog someone is reading. (2) It reaches the side effects —
    // `comprarEtiqueta` BUYS a label, and the provider opens/prints the label URL
    // once `freightClient.imprimir` returns it. Every bounded stage in this file
    // sits strictly before any side effect, which is what makes "timeout, then
    // re-click" safe; a deadline around the whole registry would free the mutex
    // after the buy POST and the re-click would buy a second label.
    //
    // What IS bounded inside it (#1094) is each FREIGHT transport call on its own
    // terms: `imprimir` only FETCHES the URL (a read), so it gives up at 60 s
    // before anything opens; `comprar` waits past the platform's own request
    // ceiling and then reports "may still be in progress", never a plain failure.
    // The Shopee provider bounds its OWN calls (`SHOPEE_ETIQUETA_LIMITES` in
    // `etiqueta/providers/shopee.ts`: machine time, dialogs excluded) — safe
    // there because its route is resumable and never ships a package twice.
    // ⚠️ The Mercado Livre client and the print agent this registry also reaches
    // are NOT bounded yet (#1678) — a stall there still spins until a reload.
    return await emitirOuImprimirEtiqueta({
      db,
      pedido,
      pedidoId,
      frete,
      intFrete,
      formato,
      deps: {
        freightClient,
        nfeClient,
        mercadoLivreClient,
        shopeeClient,
        printJob: args.printJobFn ?? printJob,
      },
      ui,
    });
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      return { status: 'timeout', stage: err.stage, message: err.message };
    }
    throw err;
  }
}

export type ReprintDanfeResult =
  | { status: 'printed' | 'downloaded' }
  /** the NF-e is still processing async — reprint again once it lands. */
  | { status: 'pending' }
  | { status: 'no-nfe'; notification: NotificationShape }
  | { status: 'error'; notification: NotificationShape }
  /** A stage outlived its deadline — see the etiqueta twin. */
  | { status: 'timeout'; stage: string; message: string };

/**
 * Reprint the DANFE for the pedido `pedidoId`: ensure it has a printable
 * (aprovada/EPEC) NF-e, then print in the requested format. Never re-emits a
 * fresh NF-e when one already exists (`ensureNfeAprovada` reuses it).
 */
export async function reprintCheckoutDanfe(args: {
  db: Firestore;
  nfeClient: NFeHttpClient | null;
  pedidoId: string;
  formato: CheckoutDanfeFormat;
  printJobFn?: typeof printJob;
  /** Per-stage deadline; defaults to {@link REPRINT_STAGE_TIMEOUT_MS}. */
  timeoutMs?: number;
}): Promise<ReprintDanfeResult> {
  const { db, nfeClient, pedidoId, formato } = args;
  const timeoutMs = args.timeoutMs ?? REPRINT_STAGE_TIMEOUT_MS;
  if (nfeClient === null) {
    return {
      status: 'no-nfe',
      notification: { title: 'NF-e', message: 'Cliente NF-e indisponível.', color: 'red' },
    };
  }

  try {
    // Bounded for the same reason as the etiqueta twin, and it matters just as
    // much: this button shares `usePrintInFlight` with that one, and BOTH render
    // `loading={printInFlight.inFlight}` — so a stall here spins both buttons
    // and looks identical to the failure this module exists to eliminate.
    // `ensureNfeAprovada` wraps an unbounded `getDocs` plus `client.emitir`, whose
    // own transport deadline (#1094) is the platform ceiling + 60 s — far past
    // this stage's budget.
    const nfe = await withDeadline(
      'carregar a NF-e',
      ensureNfeAprovada(db, nfeClient, pedidoId),
      timeoutMs,
    );
    if (!nfe.ok) {
      if (nfe.pending) return { status: 'pending' };
      return { status: 'no-nfe', notification: nfe.notification };
    }

    // ⚠️ `printDanfeForCheckout` is deliberately NOT bounded, and the reason is
    // the invariant that makes every deadline in this file safe: each bounded
    // stage sits BEFORE any side effect, so "timeout, then the operator
    // re-clicks" cannot double-print. This call IS the side effect — a deadline
    // here would free the mutex after the job reached the print agent, and the
    // re-click would print a second copy. #1094 pushed deadlines down into the
    // transports WITHOUT moving that line: the DANFE download inside this call is
    // bounded, but it resolves before `printJob` runs, so a timed-out download
    // printed nothing. A deadline placed past a side effect silently converts a
    // hang into a duplicate.
    //
    // (`ensureNfeAprovada` is bounded above although it calls `emitir`: the server
    // dedups a repeat — a SEQUENTIAL one gets the existing NF-e back `reused:
    // true`, and one that overlaps an emission still inside its SOAP call gets the
    // in-flight doc back (#1675, the server's send reservation), so a re-click
    // after this stage's 30 s — shorter than an emission can take — never sends a
    // second lote.)
    const outcome = await printDanfeForCheckout(
      nfeClient,
      pedidoId,
      nfe.nfeId,
      formato,
      args.printJobFn,
    );
    return { status: outcome };
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      return { status: 'timeout', stage: err.stage, message: err.message };
    }
    if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
      return { status: 'error', notification: notificationForNFeError(err) };
    }
    throw err;
  }
}

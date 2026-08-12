import { getDoc, type Firestore } from 'firebase/firestore';
import {
  NFeHttpError,
  NFeNetworkError,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { IntFrete, IntegracaoFrete, Pedido } from '@delfrance/schemas';
import type { MercadoLivreClient } from '../mercado-livre/client';
import { pedidoCollection } from '../data/pedidoCollection';
import { dereferenceOuterRef } from '../data/dereferenceOuterRef';
import { notificationForNFeError, type NotificationShape } from '../nfe/errors';
import { ensureNfeAprovada, printDanfeForCheckout, type CheckoutDanfeFormat } from './nfeFlow';
import { emitirOuImprimirEtiqueta } from './etiqueta/registry';
import type { EtiquetaOutcome, EtiquetaProviderUi } from './etiqueta/types';
import { printJob } from '../print-agent/printJob';

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
 * so a reprint behaves identically to the original emit/print.
 */

/** Resolve the frete integração doc → `{id, tipo, data}` (mirrors postSave). */
async function resolveIntFrete(
  db: Firestore,
  frete: Pedido['freteInicial'],
): Promise<{ id: string; tipo: IntegracaoFrete; data: IntFrete } | null> {
  const ref = dereferenceOuterRef(db, frete?.integracaoFreteOuterRef);
  if (ref === null) return null;
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data() as IntFrete;
  return { id: snap.id, tipo: data.tipo, data };
}

export type ReprintEtiquetaResult =
  | EtiquetaOutcome
  | { status: 'no-pedido' }
  | { status: 'no-frete' }
  | { status: 'no-integration' };

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
  formato: 'pdf' | 'zpl2';
  ui: EtiquetaProviderUi;
  printJobFn?: typeof printJob;
}): Promise<ReprintEtiquetaResult> {
  const { db, pedidoId, freightClient, nfeClient, mercadoLivreClient, formato, ui } = args;

  const snap = await getDoc(pedidoCollection.docRef(db, {}, pedidoId));
  if (!snap.exists()) return { status: 'no-pedido' };
  const pedido = snap.data();
  const frete = pedido.freteInicial;
  if (frete === null) return { status: 'no-frete' };

  const intFrete = await resolveIntFrete(db, frete);
  if (intFrete === null) return { status: 'no-integration' };

  return emitirOuImprimirEtiqueta({
    db,
    pedido,
    pedidoId,
    frete,
    intFrete,
    formato,
    deps: { freightClient, nfeClient, mercadoLivreClient, printJob: args.printJobFn ?? printJob },
    ui,
  });
}

export type ReprintDanfeResult =
  | { status: 'printed' | 'downloaded' }
  /** the NF-e is still processing async — reprint again once it lands. */
  | { status: 'pending' }
  | { status: 'no-nfe'; notification: NotificationShape }
  | { status: 'error'; notification: NotificationShape };

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
}): Promise<ReprintDanfeResult> {
  const { db, nfeClient, pedidoId, formato } = args;
  if (nfeClient === null) {
    return {
      status: 'no-nfe',
      notification: { title: 'NF-e', message: 'Cliente NF-e indisponível.', color: 'red' },
    };
  }

  const nfe = await ensureNfeAprovada(db, nfeClient, pedidoId);
  if (!nfe.ok) {
    if (nfe.pending) return { status: 'pending' };
    return { status: 'no-nfe', notification: nfe.notification };
  }

  try {
    const outcome = await printDanfeForCheckout(
      nfeClient,
      pedidoId,
      nfe.nfeId,
      formato,
      args.printJobFn,
    );
    return { status: outcome };
  } catch (err) {
    if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
      return { status: 'error', notification: notificationForNFeError(err) };
    }
    throw err;
  }
}

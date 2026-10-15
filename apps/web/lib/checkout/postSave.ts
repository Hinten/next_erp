import type { Firestore } from 'firebase/firestore';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';
import { NFeHttpError, NFeNetworkError } from '@delfrance/integrations-nfe/http-provider';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { Pedido } from '@delfrance/schemas';
import type { MercadoLivreClient } from '../mercado-livre/client';
import type { ShopeeClient } from '../shopee/client';
import { notificationForNFeError, type NotificationShape } from '../nfe/errors';
import {
  ensureNfeAprovada,
  printDanfeForCheckout,
  type CheckoutDanfeFormat,
  type EnsureNfeResult,
} from './nfeFlow';
import { resolverIntFrete } from './etiqueta/intFrete';
import { emitirOuImprimirEtiqueta } from './etiqueta/registry';
import type { EtiquetaOutcome, EtiquetaProviderUi } from './etiqueta/types';
import { printJob } from '../print-agent/printJob';

/**
 * Post-save orchestration: after the checkout doc is committed, ensure/print the
 * NF-e DANFE and dispatch the shipping label. Each step is best-effort: the DANFE
 * step catches the typed NF-e errors, and the etiqueta providers return an
 * `error` outcome (with a toast) for their expected failures (network / render)
 * rather than rejecting — the checkout is already committed, so nothing here can
 * un-save it (legacy parity). The caller (PR 5's Salvar handler) resets the screen + focuses
 * the finder after this resolves. Every step's client + the UI callbacks are
 * injected, so the sequence is exercised end-to-end by the PR 8 e2e; the risky
 * per-step logic lives in the unit-tested `nfeFlow` / `etiqueta` modules.
 */
export interface PostSaveResult {
  nfe: EnsureNfeResult;
  /** DANFE delivery, or an error notification, or null when the NF-e isn't printable. */
  danfe: 'printed' | 'downloaded' | { notification: NotificationShape } | null;
  /** the etiqueta outcome, or a "no integration" notification, or null. */
  etiqueta: EtiquetaOutcome | { status: 'no-integration' } | null;
}

export async function runCheckoutPostSave(args: {
  db: Firestore;
  nfeClient: NFeHttpClient | null;
  freightClient: FreightHttpClient | null;
  mercadoLivreClient: MercadoLivreClient | null;
  /** Required like the provider dep it feeds — a screen must say which client it threads. */
  shopeeClient: ShopeeClient | null;
  pedido: Pedido;
  pedidoId: string;
  formatoDanfe: CheckoutDanfeFormat;
  formatoEtiqueta: 'pdf' | 'zpl2';
  ui: EtiquetaProviderUi;
  printJobFn?: typeof printJob;
}): Promise<PostSaveResult> {
  const {
    db,
    nfeClient,
    freightClient,
    mercadoLivreClient,
    shopeeClient,
    pedido,
    pedidoId,
    formatoDanfe,
    formatoEtiqueta,
    ui,
  } = args;

  // 1. NF-e — ensure aprovada, then print the DANFE.
  const nfe: EnsureNfeResult = nfeClient
    ? await ensureNfeAprovada(db, nfeClient, pedidoId)
    : {
        ok: false,
        pending: false,
        notification: { title: 'NF-e', message: 'Cliente NF-e indisponível.', color: 'red' },
      };

  let danfe: PostSaveResult['danfe'] = null;
  if (nfe.ok && nfeClient) {
    try {
      danfe = await printDanfeForCheckout(
        nfeClient,
        pedidoId,
        nfe.nfeId,
        formatoDanfe,
        args.printJobFn,
      );
    } catch (err) {
      if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
        danfe = { notification: notificationForNFeError(err) };
      } else {
        throw err;
      }
    }
  }

  // 2. Etiqueta — resolve the frete integration (its `int_frete` doc, or the
  //    block's marketplace tipo alone — `resolverIntFrete`), then dispatch
  //    through the registry.
  const frete = pedido.freteInicial;
  let etiqueta: PostSaveResult['etiqueta'] = null;
  if (frete !== null) {
    const intFrete = await resolverIntFrete(db, frete);
    if (intFrete === null) {
      ui.notify({
        title: 'Frete',
        message: 'Este frete não possui integração com transportadora.',
        color: 'yellow',
      });
      etiqueta = { status: 'no-integration' };
    } else {
      etiqueta = await emitirOuImprimirEtiqueta({
        db,
        pedido,
        pedidoId,
        frete,
        intFrete,
        formato: formatoEtiqueta,
        deps: {
          freightClient,
          nfeClient,
          mercadoLivreClient,
          shopeeClient,
          printJob: args.printJobFn ?? printJob,
        },
        ui,
      });
    }
  }

  return { nfe, danfe, etiqueta };
}

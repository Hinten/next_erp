import { type Firestore, getDocs } from 'firebase/firestore';
import { ESTADO_NFE, INTEGRACAO_FRETE } from '@delfrance/schemas';

import { nfeCollection } from '@/lib/data/nfeCollection';
import {
  type MercadoLivreClient,
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreEtiquetaArtifact,
} from '@/lib/mercado-livre/client';

import type {
  CheckoutEtiquetaProvider,
  EtiquetaOutcome,
  EtiquetaProviderDeps,
  EtiquetaProviderInput,
} from '../types';

/**
 * Mercado Livre etiqueta provider — port of `emitirEtiquetaMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre_flutter/lib/src/utils.dart`).
 * The marketplace generates the label; the app only FETCHES it (through the
 * apps/mercado-livre proxy route, which resolves the account + shipment from
 * the pedido server-side) and sends it to the print agent — PDF and ZPL2 both.
 *
 * The one recoverable reject is ML's `invoice_pending` (the shipment hasn't
 * received the NF-e yet). Legacy self-heal, modernized: (re)send the pedido's
 * latest APROVADA NF-e via `enviar-nfe` (202 = ENQUEUED, not uploaded — the
 * upload runs in an async task), give ML 15s to process it, then retry the
 * fetch exactly ONCE. Never loop.
 */

/** Legacy waited 15s between the NF-e resend and the single label refetch. */
const RETRY_DELAY_MS = 15_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pedido's latest approved NF-e DOC id, or null. Mirrors the query shape of
 * `resolveNfeChave` (`etiquetaActions.ts`) but returns the doc ID (`enviar-nfe`
 * addresses `pedidos/{pedidoId}/nfev4/{nfeId}`) and filters `aprovada` ONLY —
 * the upload dispatch 409s (`NFE_NAO_ELEGIVEL`) on an EPEC-approved doc.
 */
export async function resolveApprovedNfeId(
  db: Firestore,
  pedidoId: string,
): Promise<string | null> {
  const snap = await getDocs(nfeCollection.ref(db, { pedidoId }));
  const aprovadas = snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter((n) => n.data.estado === ESTADO_NFE.aprovada)
    .sort((a, b) => (b.data.ultima_modificacao ?? 0) - (a.data.ultima_modificacao ?? 0));
  return aprovadas[0]?.id ?? null;
}

/** User-facing message for a recognized ML client error, or null → rethrow. */
function mlErrorMessage(err: unknown): string | null {
  // The route's JSON `error` field (Portuguese) IS the HTTP error's message.
  if (err instanceof MercadoLivreClientHttpError) return err.message;
  if (err instanceof MercadoLivreClientNetworkError) {
    return `Falha de comunicação com o Mercado Livre: ${err.message}`;
  }
  return null;
}

function isInvoicePending(err: unknown): boolean {
  return err instanceof MercadoLivreClientHttpError && err.code === 'ML_INVOICE_PENDING';
}

/**
 * A print (agent up) or a download (agent down) both DELIVER the label to the
 * operator — map both to 'printed' (genericLabel precedent).
 */
async function deliver(
  artifact: MercadoLivreEtiquetaArtifact,
  deps: EtiquetaProviderDeps,
): Promise<EtiquetaOutcome> {
  await deps.printJob(artifact.blob, {
    fileName: artifact.filename,
    contentType: artifact.contentType,
    tamanho: 'etq',
  });
  return { status: 'printed' };
}

/**
 * `invoice_pending` self-heal (legacy utils.dart:59-139): resolve the latest
 * aprovada NF-e, (re)send it to the shipment, wait, refetch once.
 */
async function recoverFromInvoicePending(
  input: EtiquetaProviderInput,
  client: MercadoLivreClient,
  resolveNfeId: typeof resolveApprovedNfeId,
): Promise<EtiquetaOutcome> {
  const { db, pedidoId, formato, deps, ui } = input;

  const nfeId = await resolveNfeId(db, pedidoId);
  if (nfeId === null) {
    return {
      status: 'error',
      message:
        'Não foi possível obter a etiqueta do Mercado Livre, pois o pedido não possui ' +
        'nota fiscal eletrônica aprovada.',
    };
  }

  try {
    await client.enviarNfe({ pedidoId, nfeId });
  } catch (err) {
    // A 409 NFE_NAO_ELEGIVEL (or any other route error) already carries the
    // user-facing Portuguese `error` field as its message.
    const msg = mlErrorMessage(err);
    if (msg === null) throw err;
    return { status: 'error', message: msg };
  }

  ui.notify({
    title: 'Mercado Livre',
    message: 'Enviando NF-e ao Mercado Livre — aguarde...',
  });
  await (deps.sleep ?? realSleep)(RETRY_DELAY_MS);

  try {
    return await deliver(await client.etiqueta(pedidoId, formato), deps);
  } catch (err) {
    // Still pending after the resend + wait → stop (NEVER loop); the operator
    // simply retries the action once ML finishes processing the NF-e.
    if (isInvoicePending(err)) {
      return {
        status: 'error',
        message:
          'A NF-e ainda não foi processada pelo Mercado Livre. Tente novamente em instantes.',
      };
    }
    const msg = mlErrorMessage(err);
    if (msg === null) throw err;
    return { status: 'error', message: msg };
  }
}

/**
 * Provider factory with an injectable approved-NF-e resolver — the unit-test
 * seam (the real one reads Firestore). Call sites use the bound
 * `mercadoLivreProvider` below.
 */
export function createMercadoLivreProvider(
  resolveNfeId: typeof resolveApprovedNfeId = resolveApprovedNfeId,
): CheckoutEtiquetaProvider {
  return {
    tipos: [INTEGRACAO_FRETE.mercadoLivre],

    async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
      const { pedidoId, frete, formato, deps } = input;

      if (deps.mercadoLivreClient === null) {
        return {
          status: 'error',
          message: 'Cliente do Mercado Livre indisponível. Faça login novamente e tente de novo.',
        };
      }
      const client = deps.mercadoLivreClient;

      // Legacy guard (utils.dart:27): a pedido imported without its ML shipment
      // id has nothing to fetch — nothing the operator can fix on their own.
      if (frete.externalId == null || frete.externalId === '') {
        return {
          status: 'error',
          message:
            'Não foi possível encontrar o frete no Mercado Livre deste pedido. ' +
            'Entre em contato com o suporte para que o problema possa ser verificado.',
        };
      }

      try {
        return await deliver(await client.etiqueta(pedidoId, formato), deps);
      } catch (err) {
        if (isInvoicePending(err)) {
          return recoverFromInvoicePending(input, client, resolveNfeId);
        }
        const msg = mlErrorMessage(err);
        if (msg === null) throw err;
        return { status: 'error', message: msg };
      }
    },
  };
}

export const mercadoLivreProvider: CheckoutEtiquetaProvider = createMercadoLivreProvider();

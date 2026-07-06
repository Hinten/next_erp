'use client';

/**
 * Etiqueta row-action logic for the `/pedidos` list — port of the legacy
 * `emitirOuImprimirFrete` (`.old/lib/despacho/pages/emitirOuImprimirFrete.dart`),
 * which was a unified BUY-or-reprint action dispatched by carrier `tipo`.
 *
 * v1 supports **Melhor Envio only** (the only ported carrier). `etiquetaRowState`
 * is the pure dispatch decision; `resolveEtiquetaCartInput` lazily resolves the
 * cart primitives from a pedido **doc** (not the form) for the buy.
 */
import { type DocumentReference, type Firestore, getDoc, getDocs } from 'firebase/firestore';
import {
  ESTADO_NFE,
  type Endereco,
  type EstadoFrete,
  type Filial,
  type IntFrete,
  type IntegracaoFrete,
  type Pedido,
  freightCapsFor,
  isFreteJaPostado,
} from '@delfrance/schemas';
import type { CartInsertRequest } from '@delfrance/integrations-freight-br/http-client';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { nfeCollection } from '@/lib/data/nfeCollection';
import { flattenItens } from './flattenItens';
import { type ClienteDestinoLike, buildPedidoCartPayload } from './tabs/frete/melhorEnvioCart';
import type { FreteInicialFormState } from './types';

/** Which etiqueta action the row offers. */
export type EtiquetaAction = 'imprimir' | 'comprar' | 'quote-first' | 'unsupported' | 'none';

export interface EtiquetaRowStateInput {
  /** The integração tipo (null while still resolving / no integração). */
  readonly tipo: IntegracaoFrete | null;
  readonly printLabelId: string | null;
  readonly externalOptionId: string | null;
  readonly estado: EstadoFrete | undefined;
}

export interface EtiquetaRowStateResult {
  readonly action: EtiquetaAction;
  /** True when the frete is already posted → re-emit/reprint needs a confirm. */
  readonly needsPostedConfirm: boolean;
}

/**
 * Pure dispatch: given the resolved carrier tipo + the persisted frete fields,
 * decide which action the row offers. Driven by `FREIGHT_TIPO_CAPS` rather than a
 * hard-coded carrier check — a bought, printable label → reprint; a selected
 * quote on a buyable tipo → buy; a quotable tipo with neither → quote-first;
 * anything else → unsupported. Today only Melhor Envio sets the `can*` flags, so
 * every other tipo still resolves to `'unsupported'` (the marketplace fetch flow
 * is Phase 5/6).
 */
export function etiquetaRowState(input: EtiquetaRowStateInput): EtiquetaRowStateResult {
  const { tipo, printLabelId, externalOptionId, estado } = input;
  const needsPostedConfirm = estado != null && isFreteJaPostado(estado);

  if (tipo == null) return { action: 'none', needsPostedConfirm };
  // `tipo` is read unparsed from Firestore — `freightCapsFor` tolerates an
  // unknown/legacy value (→ unsupported) instead of throwing on a missing row.
  const caps = freightCapsFor(tipo);
  if (printLabelId != null && caps.canPrint) return { action: 'imprimir', needsPostedConfirm };
  if (caps.canBuy && externalOptionId != null) return { action: 'comprar', needsPostedConfirm };
  if (caps.canQuote) return { action: 'quote-first', needsPostedConfirm };
  return { action: 'unsupported', needsPostedConfirm };
}

export type ResolveEtiquetaCartResult =
  | {
      readonly ok: true;
      readonly payload: CartInsertRequest;
      readonly intFreteId: string;
      /**
       * The shipment's sender location (`payload.from` — post reverse-swap, so
       * it matches where `ensureCartAgency` would look) — feeds the buy modal's
       * agency picker query. Empty address parts come through as null.
       */
      readonly remetente: { readonly estado: string | null; readonly cidade: string | null };
    }
  | { readonly ok: false; readonly error: string };

async function readDoc<T>(db: Firestore, ref: unknown): Promise<T | null> {
  const docRef = dereferenceOuterRef(db, ref) as DocumentReference<T> | null;
  if (!docRef) return null;
  const snap = await getDoc(docRef);
  return snap.exists() ? (snap.data() as T) : null;
}

/**
 * The pedido's authorized NF-e access key (modelo 55) for the ME invoice, or
 * null. Reads `pedidos/{id}/nfev4` and picks the latest aprovada / EPEC-aprovada
 * doc carrying a chave. Lazy — called only when a buy is triggered.
 */
export async function resolveNfeChave(db: Firestore, pedidoId: string): Promise<string | null> {
  const snap = await getDocs(nfeCollection.ref(db, { pedidoId }));
  const authorized = snap.docs
    .map((d) => d.data())
    .filter(
      (n) =>
        (n.estado === ESTADO_NFE.aprovada || n.estado === ESTADO_NFE.epecAprovado) &&
        n.chave != null,
    )
    .sort((a, b) => (b.ultima_modificacao ?? 0) - (a.ultima_modificacao ?? 0));
  return authorized[0]?.chave ?? null;
}

/**
 * Resolve the Melhor Envio cart payload from a pedido **doc** (the list row
 * has no form). Lazy — call it only when the buy is actually triggered, so the
 * list never fans out these reads. Returns a discriminated result so the caller
 * surfaces a clear message instead of a thrown error.
 */
export async function resolveEtiquetaCartInput(
  db: Firestore,
  pedido: Pedido,
  pedidoId: string,
): Promise<ResolveEtiquetaCartResult> {
  const frete = pedido.freteInicial;
  if (!frete) return { ok: false, error: 'Pedido sem frete.' };

  const integracaoRef = dereferenceOuterRef(db, frete.integracaoFreteOuterRef);
  if (!integracaoRef) return { ok: false, error: 'Integração de frete não encontrada.' };
  const integracao = await readDoc<IntFrete>(db, frete.integracaoFreteOuterRef);
  if (!integracao) return { ok: false, error: 'Integração de frete não encontrada.' };
  if (!integracao.enderecoDeOrigem) {
    return { ok: false, error: 'Configure o endereço de origem da integração de frete.' };
  }

  const filial = await readDoc<Filial>(db, integracao.filialIntegracaoFreteOuterRef);
  if (!filial) return { ok: false, error: 'Filial da integração de frete não encontrada.' };

  const enderecoDestino = await readDoc<Endereco>(db, frete.enderecoFreteOuterReference);
  if (!enderecoDestino) return { ok: false, error: 'Pedido sem endereço de entrega.' };

  // Independent reads — fetch the cliente fallback + the NF-e chave in parallel.
  const [clienteDestino, invoiceKey] = await Promise.all([
    readDoc<ClienteDestinoLike>(db, pedido.clientePedidoOuterRef),
    resolveNfeChave(db, pedidoId),
  ]);

  const payload = buildPedidoCartPayload({
    // `FreteDoPedido` (wire) is structurally what the mapper reads off
    // `FreteInicialFormState`.
    frete: frete as unknown as FreteInicialFormState,
    enderecoOrigem: integracao.enderecoDeOrigem,
    filial,
    enderecoDestino,
    clienteDestino,
    itens: flattenItens(pedido.itens),
    pedidoNumero: pedido.numero,
    invoiceKey,
  });

  // `from` is passthrough on `CartInsertRequest`; read it back off the built
  // payload (not the integração) so a reverse shipment reports the recipient
  // side — the same address `ensureCartAgency` queries agencies against.
  const from = (payload as { from?: { state_abbr?: string; city?: string } }).from;
  const remetente = {
    estado: from?.state_abbr?.trim() || null,
    cidade: from?.city?.trim() || null,
  };

  return { ok: true, payload, intFreteId: integracaoRef.id, remetente };
}

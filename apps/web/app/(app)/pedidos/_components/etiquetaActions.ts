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
import { type DocumentReference, type Firestore, getDoc } from 'firebase/firestore';
import {
  type Endereco,
  type EstadoFrete,
  type Filial,
  type IntFrete,
  type IntegracaoFrete,
  type Pedido,
  isFreteJaPostado,
} from '@delfrance/schemas';
import type { CartInsertRequest } from '@delfrance/integrations-freight-br/http-client';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
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
 * decide which action the row offers. Mirrors the legacy switch (ME only here):
 * a bought label → reprint; a selected quote → buy; otherwise quote-first.
 */
export function etiquetaRowState(input: EtiquetaRowStateInput): EtiquetaRowStateResult {
  const { tipo, printLabelId, externalOptionId, estado } = input;
  const needsPostedConfirm = estado != null && isFreteJaPostado(estado);

  if (tipo == null) return { action: 'none', needsPostedConfirm };
  if (tipo !== 'melhorEnvios') return { action: 'unsupported', needsPostedConfirm };
  if (printLabelId != null) return { action: 'imprimir', needsPostedConfirm };
  if (externalOptionId != null) return { action: 'comprar', needsPostedConfirm };
  return { action: 'quote-first', needsPostedConfirm };
}

export type ResolveEtiquetaCartResult =
  | { readonly ok: true; readonly payload: CartInsertRequest; readonly intFreteId: string }
  | { readonly ok: false; readonly error: string };

async function readDoc<T>(db: Firestore, ref: unknown): Promise<T | null> {
  const docRef = dereferenceOuterRef(db, ref) as DocumentReference<T> | null;
  if (!docRef) return null;
  const snap = await getDoc(docRef);
  return snap.exists() ? (snap.data() as T) : null;
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
): Promise<ResolveEtiquetaCartResult> {
  const frete = pedido.freteInicial;
  if (!frete) return { ok: false, error: 'Pedido sem frete.' };

  const integracaoRef = dereferenceOuterRef(db, frete.integracaoFreteOuterRef);
  if (!integracaoRef) return { ok: false, error: 'Integração de frete não encontrada.' };
  const integracao = await readDoc<IntFrete>(db, frete.integracaoFreteOuterRef);
  if (!integracao) return { ok: false, error: 'Integração de frete não encontrada.' };
  if (!integracao.enderecoDeOrigem) {
    return { ok: false, error: 'Configure o endereço de origem da integração Melhor Envio.' };
  }

  const filial = await readDoc<Filial>(db, integracao.filialIntegracaoFreteOuterRef);
  if (!filial) return { ok: false, error: 'Filial da integração de frete não encontrada.' };

  const enderecoDestino = await readDoc<Endereco>(db, frete.enderecoFreteOuterReference);
  if (!enderecoDestino) return { ok: false, error: 'Pedido sem endereço de entrega.' };

  const clienteDestino = await readDoc<ClienteDestinoLike>(db, pedido.clientePedidoOuterRef);

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
  });

  return { ok: true, payload, intFreteId: integracaoRef.id };
}

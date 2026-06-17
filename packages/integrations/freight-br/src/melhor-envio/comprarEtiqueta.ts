/**
 * Idempotent buy-label pipeline — port of the legacy `_emissaoEtiqueta`
 * (`.old/lib/integracoes_frete/melhor_envios/comprar_gerar_imprimir_etiqueta.dart`).
 *
 * The legacy stream walked: (fetch existing) → add to cart → checkout →
 * generate → print, skipping any step the order had already passed
 * (`paid_at`/`generated_at` non-null), and treating `canceled_at`/
 * `suspended_at` as terminal. This port keeps that resume logic but fixes the
 * legacy's anti-loss gap: the legacy persisted the new `printLabelId` only at
 * the very end (after print), so a crash mid-flight orphaned a paid label.
 * Here we persist it **right after the cart insert, before checkout** (the
 * NFe persist-before-send rule-1 analogue) — on resume `getOrder` sees
 * `paid_at` and skips re-buying.
 *
 * Platform-neutral: the cart payload (a pedido → ME mapping) and the
 * persistence are injected, so this file has no Firestore / domain deps.
 */
import { MelhorEnvioLabelTerminalError } from './errors';
import type { CartInsertRequest, Order, PrintResponse } from './types';

/** The subset of the ME API the pipeline drives (see `createMelhorEnvioApi`). */
export interface ComprarEtiquetaApi {
  addToCart(req: CartInsertRequest): Promise<{ id: string }>;
  getOrder(id: string): Promise<Order>;
  checkout(orderIds: readonly string[]): Promise<unknown>;
  generate(orderIds: readonly string[]): Promise<unknown>;
  print(orderIds: readonly string[]): Promise<PrintResponse>;
}

export type ComprarEtiquetaStep =
  | 'fetch-existing'
  | 'add-to-cart'
  | 'checkout'
  | 'generate'
  | 'print'
  | 'finalize';

export interface ComprarEtiquetaDeps {
  readonly api: ComprarEtiquetaApi;
  /** The label id already persisted on the pedido frete, if any (resume). */
  readonly printLabelId: string | null;
  /**
   * Build the ME cart payload (pedido + frete → cart item). Called only on a
   * fresh buy, so an expensive lookup is skipped when resuming.
   */
  buildCartPayload(): CartInsertRequest | Promise<CartInsertRequest>;
  /**
   * Persist the freshly created label id BEFORE checkout (anti-loss anchor).
   * Only called on a fresh buy — on resume the id is already persisted.
   */
  persistPrintLabelId(id: string): Promise<void>;
  /** Optional progress hook (the UI streams these as status lines). */
  onProgress?(step: ComprarEtiquetaStep): void;
}

export interface ComprarEtiquetaResult {
  readonly printLabelId: string;
  readonly printUrl: string;
  readonly tracking: string | null;
  readonly order: Order;
}

/**
 * Run the buy pipeline to completion and return the printable label URL +
 * tracking. Throws `MelhorEnvioLabelTerminalError` if the existing label is
 * canceled/suspended, and bubbles ME API errors (validation / reauth / http)
 * for the route layer to map.
 */
export async function comprarEtiqueta(deps: ComprarEtiquetaDeps): Promise<ComprarEtiquetaResult> {
  const { api, buildCartPayload, persistPrintLabelId, onProgress } = deps;
  const progress = (step: ComprarEtiquetaStep): void => onProgress?.(step);

  let labelId = deps.printLabelId;
  let order: Order | null = null;

  if (labelId) {
    progress('fetch-existing');
    order = await api.getOrder(labelId);
    if (order.canceled_at) {
      throw new MelhorEnvioLabelTerminalError(
        'canceled',
        'A etiqueta foi cancelada no Melhor Envio. Gere uma nova.',
      );
    }
    if (order.suspended_at) {
      throw new MelhorEnvioLabelTerminalError(
        'suspended',
        'A etiqueta está suspensa no Melhor Envio.',
      );
    }
  }

  // Fresh buy: insert into the cart, then anchor the id before spending balance.
  if (!labelId || !order) {
    progress('add-to-cart');
    const cart = await api.addToCart(await buildCartPayload());
    labelId = cart.id;
    await persistPrintLabelId(labelId);
  }

  // `order` is null on a fresh buy (always checkout/generate) and the existing
  // order otherwise (skip whatever it already passed).
  if (!order?.paid_at) {
    progress('checkout');
    await api.checkout([labelId]);
  }

  if (!order?.generated_at) {
    progress('generate');
    await api.generate([labelId]);
  }

  progress('print');
  const printed = await api.print([labelId]);

  // Re-fetch so the persisted tracking/estado reflect the now-generated label.
  progress('finalize');
  const finalOrder = await api.getOrder(labelId);

  return {
    printLabelId: labelId,
    printUrl: printed.url,
    tracking: finalOrder.tracking ?? null,
    order: finalOrder,
  };
}

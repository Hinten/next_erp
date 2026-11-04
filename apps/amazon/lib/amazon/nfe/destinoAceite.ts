/**
 * The step-15 SEAM of the NF-e upload (step 14, PR 14-c; step-14 plan §3
 * decision 14): what runs once Amazon ACCEPTED this pedido's NF-e — the hand-off
 * to the pickup scheduling (Easy Ship), which master plan step 15 fills.
 *
 * NULL in step 14, pinned by a test: nothing is enqueued or recorded for a
 * consumer that does not exist yet. The NF-e task's `aceita` path calls
 * `agendar` only when it is non-null, AFTER the stamp clear and the
 * `nfe-validada` resolve, and never with a cancelled sibling (`nfe-substituta`),
 * an ambiguous pedido (`nfe-ambigua`), a partial acceptance or a cancelled sale.
 *
 * ⚠️ Step 15 must gate on Amazon's LIVE state, never on "the freight is not
 * `error`" (the stamp clear is step 14's alone), and needs its own entry for an
 * NF-e uploaded by hand through Seller Central (the importer's
 * `aguardandoAgendamento`), which never passes through here.
 */

/** What the seam receives: ids only (the order is re-read live by its consumer). */
export interface AceiteNfeAmazon {
  readonly contaId: string;
  readonly pedidoId: string;
  readonly nfeId: string;
  /** Amazon's order id (3-7-7). */
  readonly orderId: string;
}

/** The seam's table: one consumer, `null` until step 15. */
export interface DestinoAceiteNfeAmazon {
  readonly agendar: ((aceite: AceiteNfeAmazon) => Promise<void>) | null;
}

/** NULL in step 14 (module header). Step 15 fills it; a test pins it until then. */
export const DESTINO_ACEITE_NFE_AMAZON: DestinoAceiteNfeAmazon = { agendar: null };

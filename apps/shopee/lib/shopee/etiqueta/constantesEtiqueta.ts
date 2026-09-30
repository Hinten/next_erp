/**
 * Every tunable and every ERP-side bound of the Shopee LABEL flow (#1523,
 * step 15). Pure data: no `process.env`, no clock, no I/O.
 *
 * The rule the module exists to hold is step 12's (`estoque/constantesEstoque.ts`):
 * a bound the WIRE states lives in `@delfrance/integrations-shopee` and is
 * imported (the 50-entry batch cap, the document-type names, the READY/FAILED
 * spellings); a bound WE chose lives here.
 *
 * ⚠️ **Probe constants.** Several values below were chosen before the step-15
 * probe ran, and each carries a `// P<n>` comment naming the probe step that
 * flips it (reconcile §8). Each flip is ONE line here — never a second copy of
 * the value elsewhere, which is why no reader restates a number from this file.
 *
 * ⚠️ **Deliberately absent** (Lucas, round 2, 2026-09-30 — Appendix A of the
 * reconcile): the whole 1-hour cancellation-window confirm. There is no window
 * constant, no confirm flag and no auto-arrange channel list here. The legacy
 * app never asked, Shopee only RECOMMENDS the wait, and a constant nothing reads
 * would be dead code under the unused-vars gate. The auto-arrange channel list
 * arrives with step 15b, beside its first reader.
 */

/* ------------------------------- the budgets ------------------------------- */

/**
 * The server's per-CALL budget: no new Shopee action is STARTED after it.
 *
 * Each action is one HTTP call with no fetch timeout, so a call ends at about
 * the budget plus one action (the download included) — well inside App
 * Hosting's 180 s request cap, so `apphosting.yaml` needs no change. The route
 * is resumable by construction (every call re-derives the phase from Shopee),
 * so the budget bounds one call, never the flow.
 */
export const ORCAMENTO_ETIQUETA_MS = 30_000;

/**
 * The in-call cadence between two tracking-number reads (legacy parity).
 * P4: the tracking-number latency is unknown (register 209); the probe settles it.
 */
export const INTERVALO_RASTREIO_MS = 5_000; // P4

/** The in-call cadence between two `get_shipping_document_result` reads. */
export const INTERVALO_DOCUMENTO_MS = 3_000; // P6

/**
 * The pause after a successful `ship_order`, before the next read — the window
 * in which `is_shipment_arranged` may not yet be observable (register 208).
 */
export const ESPERA_POS_PROGRAMAR_MS = 2_000; // P2

/**
 * The `tentarEmMs` floor for a BURST rate limit: `max(retryAfter·1000, this)`.
 * D1 proposed 5 000 and D2 10 000; the gentler value won (reconcile R-m).
 */
export const TENTAR_EM_LIMITE_MS = 10_000;

/** The `tentarEmMs` while another instance holds the token-refresh lease. */
export const TENTAR_EM_CREDENCIAL_MS = 2_000;

/**
 * The `tentarEmMs` for Shopee's own "not now" — an allocation still running, a
 * lock off the ship, a Shopee-side hiccup — and for the runner's own "this
 * call cannot move further, ask again". D1 row 5's value, which is also the
 * burst floor above; a name of its own because the two are different facts
 * and either may move without the other.
 */
export const TENTAR_EM_SHOPEE_MS = 10_000;

/* ------------------------------- the wire ask ------------------------------ */

/**
 * The route's ONE `get_order_detail` asks for exactly these optional fields.
 *
 * `order_status` is NOT here and must not be: it is one of the eleven BASE
 * fields `get_order_detail` returns unasked (the package's
 * `SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS` docblock), and naming a base field
 * risks `error_param`.
 *
 * ⚠️ No `invoice_data` (it carries the NF-e access key, which this flow never
 * needs — the invoice gate is the PACKAGE's `invoice_pending`), no recipient or
 * buyer field, and no `pay_time` (the 1-hour confirm was removed, Appendix A).
 * The runner's test pins that the call sends exactly this list.
 */
export const SHOPEE_ETIQUETA_DETALHE_CAMPOS = ['package_list', 'fulfillment_flag'] as const;

/**
 * The web's `formato` → the Shopee document type the server ASKS for, when
 * that type is `selectable` for the package; else Shopee's `suggest`; else the
 * type is omitted (Shopee's default). The web detects a substitution from the
 * sniffed `Content-Type` only (reconcile R-u).
 */
export const TIPO_DOCUMENTO_DO_FORMATO = {
  pdf: 'NORMAL_AIR_WAYBILL',
  zpl2: 'THERMAL_AIR_WAYBILL',
} as const;

/**
 * The document type the runner RECORDS when it decided to send none (Shopee's
 * own default): neither the asked type nor a `suggest` was offered.
 *
 * ⚠️ A NON-null value on purpose: to the decision, `tipoDocumento: null` means
 * "not read yet", which would re-ask `get_shipping_document_parameter` until
 * the budget ran out. Every reader that must tell "omitted" from a real type —
 * the runner, and the CLI's report — imports this one name (review 1, R5-6).
 */
export const TIPO_OMITIDO = '';

/**
 * Whether `ship_order` carries `package_number` on an UNSPLIT order.
 * `'so-se-dividido'` sends it only when the order has more than one package;
 * every OTHER op always sends it. The `ship_order_(not_)need_pacakge_number`
 * refusals are the backstop in both directions (register 206).
 */
export const SHOPEE_SHIP_ORDER_PACOTE: 'so-se-dividido' | 'sempre' = 'so-se-dividido'; // P3a

/**
 * Whether `get_package_detail.tracking_number` is trusted, so that
 * `get_tracking_number` is skipped while the package row already has one.
 */
export const RASTREIO_DO_PACOTE_VALE = true; // P2 vs P4

/**
 * Whether a document may be created with no tracking number. `false` until
 * BR's `get_channel_list.preprint` says a channel prints before the number.
 */
export const IMPRIMIR_SEM_RASTREIO = false; // BR get_channel_list.preprint

/* ------------------------------- our bounds -------------------------------- */

/** The longest `pacote` the route's body accepts (a package number). */
export const TAMANHO_MAX_PACOTE = 64;

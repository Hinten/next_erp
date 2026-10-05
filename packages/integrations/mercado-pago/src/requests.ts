import { z } from 'zod';

import { roundReais } from '@delfrance/core/money';
import { linkPagamentoIdSchema, tipoPagamentoMpSchema } from '@delfrance/schemas';

/**
 * STRICT schemas for the bodies this ERP SENDS to Mercado Pago (Checkout Pro
 * preferences, #367). `types.ts` holds the tolerant RESPONSE schemas; this file is
 * its opposite on purpose, and the two must never share a shape:
 *
 *  - a RESPONSE is tolerant because Mercado Pago changes fields without notice and
 *    one mistyped optional field must not discard a payment we already hold;
 *  - a REQUEST is strict because tolerance is the wrong direction outbound —
 *    accepting a stringified `unit_price` or an unknown key would mean FORWARDING
 *    it, and Mercado Pago answers a bad preference with an opaque 4xx (or, worse,
 *    accepts a field we never meant to send).
 *
 * `api.ts` runs every body through its schema BEFORE `fetch` (`assertRequest`), so
 * a violation is a {@link MercadoPagoRequestError} that never left the process.
 *
 * ⚠️ **Strictness does real work here.** `z.strictObject` rejects every key this
 * file does not name, which is how the fields we deliberately do NOT send stay
 * unsent even if a future builder edit adds one by accident:
 *
 *  - `notification_url` — overrides the panel webhook (#564). Its deliveries may be
 *    unsigned, which the receiver answers with 401 because the webhook secret is
 *    secret-backed, and it would bake an App Hosting host — which changes at the
 *    cutover — into every open link.
 *  - `back_urls` / `auto_return` — there is no public return page, and Mercado
 *    Pago requires HTTPS.
 *  - `binary_mode` — auto-rejects pending payments, which kills Pix and boleto.
 *  - `purpose` — `wallet_purchase` allows logged-in Mercado Pago users only.
 *  - `statement_descriptor`, `sandbox_init_point`, `marketplace*`, `shipments`.
 *
 * ⚠️ Every numeric field below sits on ONE short line of its own on purpose:
 * `integration-response-numbers-tolerant.test.js` scans this package line by line
 * for a bare numeric schema and carves these out by their exact text (REQUEST — the
 * strict direction). A chain Prettier wraps stops matching that text and turns the
 * carve-out STALE, so keep them short.
 */

/** Mercado Pago's cap on a free-text field (item `id`, `title`, payer name…). */
export const LIMITE_TEXTO_MP = 256;

/** `installments` is a MAXIMUM the payer may choose, 1..36 per Mercado Pago. */
export const PARCELAS_MP_MAXIMAS = 36;

/**
 * `yyyy-MM-dd'T'HH:mm:ss.SSS±HH:MM` — the documented shape, with an EXPLICIT
 * offset. A trailing `Z` is rejected on purpose: the docs and every example use
 * an offset, and acceptance of `Z` is unconfirmed (probe P6).
 */
const ISO_COM_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
const isoComOffset = z.string().regex(ISO_COM_OFFSET, 'offset explícito (sem Z)');

/** `external_reference`: at most 64 of letters, digits, `-`, `_` (a Firestore auto-id fits). */
const REFERENCIA_EXTERNA = /^[A-Za-z0-9_-]{1,64}$/;

/** A Brazilian DDD: two digits, the first never `0`. */
const DDD = /^[1-9]\d$/;
/** The subscriber part of a Brazilian number, WITHOUT the DDD: 8 or 9 digits. */
const NUMERO_TELEFONE = /^\d{8,9}$/;
/** CPF (11 digits) or CNPJ (14 characters — alphanumeric since the 2026 format). */
const CPF = /^[0-9]{11}$/;
const CNPJ = /^[0-9A-Z]{14}$/;
const DOCUMENTO_PAGADOR = /^([0-9]{11}|[0-9A-Z]{14})$/;

const texto = z.string().min(1).max(LIMITE_TEXTO_MP);

/**
 * At most all-but-one of the excludable types, so one of them always stays on.
 * Derived from the enum, so adding a type there never leaves this cap behind.
 */
const tipoExcluido = z.strictObject({ id: tipoPagamentoMpSchema });
const MAX_TIPOS_EXCLUIDOS = tipoPagamentoMpSchema.options.length - 1;

// The two numeric fields. ⚠️ One short line each — see the header.
const reaisPositivos = z.number().positive();
const inteiroDeParcelas = z.number().int().min(1).max(PARCELAS_MP_MAXIMAS);

/**
 * `unit_price` in reais: positive and with AT MOST two decimals. `33.333` is
 * refused rather than rounded — the builder rounds with `roundReais` first, so a
 * third decimal reaching this gate is a caller bug, and Mercado Pago's own answer
 * to it (`invalid_items`) is opaque.
 */
const valorEmReais = reaisPositivos.refine(
  (v) => Number.isFinite(v) && roundReais(v) === v,
  'no máximo 2 casas decimais',
);

/** The single line item of a link: the amount ONE payer is asked for. */
export const mpPreferenceItemRequestSchema = z.strictObject({
  /** The link id (`linkPagamentoIdSchema`), the same value as `metadata.link_id`. */
  id: texto,
  title: texto,
  quantity: z.literal(1),
  currency_id: z.literal('BRL'),
  unit_price: valorEmReais,
});
export type MpPreferenceItemRequest = z.infer<typeof mpPreferenceItemRequestSchema>;

/**
 * Optional prefill of the checkout (only ever built for a link meant for the
 * pedido's own customer). Every part is optional and validated on its own, so the
 * builder can DROP a malformed part instead of failing the whole link.
 *
 * `phone.number` is a STRING although Mercado Pago's create-preference reference
 * types it as a number (another page of the docs quotes it): a string cannot lose
 * a leading zero. Which one the wire accepts is confirmed by probe P8.
 *
 * `identification.type` is case-sensitive and an unrecognized value may be
 * silently replaced by the site's default, so the number must actually be the
 * kind of document the type names: a CPF is 11 digits, a CNPJ 14 characters.
 */
export const mpPreferencePayerRequestSchema = z.strictObject({
  name: texto.optional(),
  surname: texto.optional(),
  email: z.string().email().max(LIMITE_TEXTO_MP).optional(),
  phone: z
    .strictObject({
      area_code: z.string().regex(DDD),
      number: z.string().regex(NUMERO_TELEFONE),
    })
    .optional(),
  identification: z
    .strictObject({
      type: z.enum(['CPF', 'CNPJ']),
      number: z.string().regex(DOCUMENTO_PAGADOR),
    })
    .refine(
      (doc) => (doc.type === 'CPF' ? CPF : CNPJ).test(doc.number),
      'o número deve ser do tipo de documento informado',
    )
    .optional(),
});
export type MpPreferencePayerRequest = z.infer<typeof mpPreferencePayerRequestSchema>;

/**
 * `POST /checkout/preferences`.
 *
 *  - `metadata.link_id` is snake_case ON PURPOSE — Mercado Pago copies `metadata`
 *    onto the payment (snake-casing its keys) and the payment mapper reads it back
 *    from there to attribute the payment to its link.
 *  - `expires` + `expiration_date_to` close the CHECKOUT at the deadline;
 *    `date_of_expiration` is the payment deadline for Pix and boleto, and is sent
 *    with the SAME value so an offline payment issued late in the window cannot
 *    outlive the link.
 *  - `excluded_payment_types` is capped at three of the four excludable types, so
 *    at least one way to pay always remains (`account_money` can never be excluded).
 */
export const mpPreferenceRequestSchema = z.strictObject({
  items: z.tuple([mpPreferenceItemRequestSchema]),
  external_reference: z.string().regex(REFERENCIA_EXTERNA),
  metadata: z.strictObject({ link_id: linkPagamentoIdSchema }),
  expires: z.literal(true),
  expiration_date_to: isoComOffset,
  date_of_expiration: isoComOffset,
  payment_methods: z
    .strictObject({
      excluded_payment_types: z.array(tipoExcluido).max(MAX_TIPOS_EXCLUIDOS).optional(),
      installments: inteiroDeParcelas.optional(),
    })
    .optional(),
  payer: mpPreferencePayerRequestSchema.optional(),
});
export type MpPreferenceRequest = z.infer<typeof mpPreferenceRequestSchema>;

/**
 * `PUT /checkout/preferences/{id}` — the early close of a link (cancel, or the
 * auto-close after its last payment).
 *
 * BOTH dates move: `expiration_date_to` closes the checkout, while a Pix QR or a
 * boleto issued earlier stays payable until `date_of_expiration`, which was set to
 * the end of the link's window. Whether a past `date_of_expiration` is accepted,
 * and whether it invalidates an already-issued Pix, is confirmed only by probe P5.
 *
 * `date_of_expiration` is therefore OPTIONAL here (and only here — the create
 * body still requires it): Mercado Pago may answer a past / near-now payment
 * deadline with a 400, and the caller's fallback (`expirarPreferencia` in
 * `apps/mercado-pago`) then re-sends the patch WITHOUT it, so the checkout still
 * closes. `expiration_date_to` stays required — it is the part that closes it.
 */
export const mpPreferenceExpireRequestSchema = z.strictObject({
  expires: z.literal(true),
  expiration_date_to: isoComOffset,
  date_of_expiration: isoComOffset.optional(),
});
export type MpPreferenceExpireRequest = z.infer<typeof mpPreferenceExpireRequestSchema>;

import { formatIsoNoFuso } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import { localTelefone } from '@delfrance/core/phone';
import type { TipoPagamentoMp } from '@delfrance/schemas';
import {
  LIMITE_TEXTO_MP,
  mpPreferencePayerRequestSchema,
  type MpPreferencePayerRequest,
  type MpPreferenceRequest,
} from '../requests';

/**
 * Pure builder of the `POST /checkout/preferences` body for ONE payment link
 * (#367). No Firestore, no I/O, no clock — the caller decides the deadline and the
 * zone, so the same input is the same body.
 *
 * It returns a PLAIN object. `api.ts` runs it through the strict
 * `mpPreferenceRequestSchema` before `fetch` (`assertRequest`), and that is the
 * ONLY strict gate: validating here too would raise a raw `ZodError`, which is not
 * a `MercadoPagoError` and would reach the client as a bare 500 with no code,
 * instead of the `MercadoPagoRequestError` → `MP_ERROR` it should be. The one
 * exception is the payer, whose parts are checked individually — see
 * {@link buildPayer}.
 *
 * ## What is deliberately NOT in the body
 *
 * `notification_url`, `back_urls`, `auto_return`, `binary_mode`, `purpose`,
 * `statement_descriptor` and `sandbox_init_point` (the reasons are on
 * `requests.ts`), and no `X-Idempotency-Key` header: with the caller's
 * expire-on-failure cleanup, an honoured key could answer a retry with the
 * preference that cleanup already EXPIRED.
 */
export interface PreferenceInput {
  /** The pedido doc id — sent VERBATIM as `external_reference` (the webhook finds the pedido by it). */
  pedidoId: string;
  /** The pedido's human number, for the item title; `null` prints a title without it. */
  numeroPedido: string | null;
  /** The link doc id (`linkPagamentoIdSchema`): the item id AND `metadata.link_id`. */
  linkId: string;
  /** What THIS payer is asked for, in reais. Rounded with `roundReais`. */
  valor: number;
  /** The operator's label for the payer (a first name); shown in the title. */
  nomePagador: string | null;
  /** End of the link's validity, epoch ms. */
  expiraEmMs: number;
  /** IANA zone the deadline is written in (the fiscal zone) — never the process zone. */
  fuso: string;
  tiposExcluidos: ReadonlyArray<TipoPagamentoMp>;
  /** The most installments the payer may choose, or `null` for Mercado Pago's default. */
  parcelasMaximas: number | null;
  /**
   * Checkout prefill, and `null` for NO prefill (the default). Non-null ONLY for a
   * link meant for the pedido's own customer: on a link another person pays, the
   * customer's identity would go into Mercado Pago's fraud scoring for a payment
   * they did not make.
   */
  pagador: {
    nome: string | null;
    email: string | null;
    cpfCnpj: string | null;
    telefone: string | null;
    /** A foreign customer's document and phone are not Brazilian ones: neither is sent. */
    estrangeiro: boolean;
  } | null;
}

export function buildPreferenceRequest(i: PreferenceInput): MpPreferenceRequest {
  // Both dates carry the SAME instant: `expiration_date_to` closes the checkout,
  // and `date_of_expiration` is the Pix/boleto payment deadline. An offline
  // payment must not outlive the link, so they are never set apart.
  const expira = formatIsoNoFuso(i.expiraEmMs, i.fuso);
  const paymentMethods = buildPaymentMethods(i.tiposExcluidos, i.parcelasMaximas);
  const payer = i.pagador === null ? undefined : buildPayer(i.pagador);

  return {
    items: [
      {
        id: i.linkId,
        title: buildTitle(i.numeroPedido, i.nomePagador),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: roundReais(i.valor),
      },
    ],
    external_reference: i.pedidoId,
    metadata: { link_id: i.linkId },
    expires: true,
    expiration_date_to: expira,
    date_of_expiration: expira,
    ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
    ...(payer === undefined ? {} : { payer }),
  };
}

/**
 * `payment_methods` only when the link restricts something, and each of its two
 * keys only when it is used: the default (every method, Mercado Pago's own
 * installment cap) is the ABSENCE of the block, not an empty one.
 *
 * Duplicates are collapsed so a repeated type cannot eat the schema's cap on the
 * number of excluded types.
 */
function buildPaymentMethods(
  tiposExcluidos: ReadonlyArray<TipoPagamentoMp>,
  parcelasMaximas: number | null,
): MpPreferenceRequest['payment_methods'] {
  const tipos = [...new Set(tiposExcluidos)];
  if (tipos.length === 0 && parcelasMaximas === null) return undefined;
  return {
    ...(tipos.length > 0 ? { excluded_payment_types: tipos.map((id) => ({ id })) } : {}),
    ...(parcelasMaximas === null ? {} : { installments: parcelasMaximas }),
  };
}

/**
 * `Pedido #123 — Maria`, `Pedido — Maria`, `Pedido #123`, `Pedido`. The legacy
 * builder interpolated a null number and printed `Pedido #null`.
 */
function buildTitle(numeroPedido: string | null, nomePagador: string | null): string {
  const numero = numeroPedido?.trim();
  const nome = nomePagador?.trim();
  const base = numero ? `Pedido #${numero}` : 'Pedido';
  return (nome ? `${base} — ${nome}` : base).slice(0, LIMITE_TEXTO_MP);
}

/**
 * The checkout prefill, one part at a time. Each part is validated against the
 * SAME request schema the client enforces, and a part that fails is DROPPED rather
 * than failing the link: the customer's stored e-mail or phone is legacy data of
 * unknown quality, and an operator must not be unable to send a payment link
 * because of a typo in a field Mercado Pago only uses as a hint.
 *
 * `undefined` when no part survives, so an empty `payer` is never sent.
 */
function buildPayer(
  p: NonNullable<PreferenceInput['pagador']>,
): MpPreferencePayerRequest | undefined {
  const shape = mpPreferencePayerRequestSchema.shape;
  const payer: MpPreferencePayerRequest = {};

  // First token = name, the rest = surname (`Maria da Silva` → `Maria` / `da Silva`).
  const tokens = (p.nome ?? '').trim().split(/\s+/u);
  const name = shape.name.safeParse(tokens[0]);
  if (name.success && name.data !== undefined) payer.name = name.data;
  const resto = tokens.slice(1).join(' ');
  const surname = shape.surname.safeParse(resto === '' ? undefined : resto);
  if (surname.success && surname.data !== undefined) payer.surname = surname.data;

  const email = shape.email.safeParse(p.email?.trim());
  if (email.success && email.data !== undefined) payer.email = email.data;

  // A foreign customer's document and phone are never sent as if they were a
  // Brazilian CPF/CNPJ or DDD + number.
  if (!p.estrangeiro) {
    const identification = documentoDoPagador(p.cpfCnpj);
    if (identification !== undefined) payer.identification = identification;
    const phone = telefoneDoPagador(p.telefone);
    if (phone !== undefined) payer.phone = phone;
  }

  return Object.keys(payer).length > 0 ? payer : undefined;
}

/** CPF (11 digits) or CNPJ (14 alphanumeric); formatting is stripped, other lengths dropped. */
function documentoDoPagador(bruto: string | null): MpPreferencePayerRequest['identification'] {
  if (bruto === null) return undefined;
  const limpo = bruto.replace(/[^0-9A-Za-z]/gu, '').toUpperCase();
  let type: 'CPF' | 'CNPJ' | null = null;
  if (/^\d{11}$/u.test(limpo)) type = 'CPF';
  else if (limpo.length === 14) type = 'CNPJ';
  if (type === null) return undefined;
  const parsed = mpPreferencePayerRequestSchema.shape.identification.safeParse({
    type,
    number: limpo,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * DDD + number, from either stored shape: the normalized `55…` one
 * (`5511999998888`) and the raw legacy 10/11-digit one (`11999998888`) both come
 * out as `{ area_code: '11', number: '999998888' }`. The legacy app took
 * `substring(0, 2)` of the STORED value, which for the normalized shape is the
 * country code — it sent `area_code: '55'`.
 */
function telefoneDoPagador(bruto: string | null): MpPreferencePayerRequest['phone'] {
  if (bruto === null) return undefined;
  const local = localTelefone(bruto);
  if (local.length !== 10 && local.length !== 11) return undefined;
  const parsed = mpPreferencePayerRequestSchema.shape.phone.safeParse({
    area_code: local.slice(0, 2),
    number: local.slice(2),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Delivery by Amazon v2022-07-01 (`deliveryShipmentInvoiceV2022-07-01.json`):
 * the NF-e upload of a Delivery-by-Amazon order (`programType` `EasyShip`, the
 * BR program the model calls "also known as DBA in Brazil"). Two operations:
 *
 * - `getInvoiceStatus` — `GET /delivery/2022-07-01/invoice/status`, through the
 *   READ client: {@link consultarStatusNotaFiscal}.
 * - `submitInvoice` — `POST /delivery/2022-07-01/invoice`, through the WRITE
 *   client (`escrita.ts`): {@link enviarNotaFiscal}.
 *
 * Written from the model (printed by `node .master_plans/amazon/evidence/amazon-doc.mjs
 * op submitInvoice delivery` / `op getInvoiceStatus delivery`) and its own
 * sandbox examples, plus the shape of the owner's one read-only status capture
 * — never from a live call (D11). Both operations: 1.133 requests per second,
 * burst 25 (the model's table).
 *
 * ## Every query and body is built from NAMED keys
 *
 * Never a spread of the caller's object, so nothing a caller adds can ride along:
 *
 * - the status query is EXACTLY `orderId`, `marketplaceId`, `invoiceType`,
 *   `programType`. Never `shipmentId` or `invoiceId`: the model's precedence is
 *   orderId > shipmentId > invoiceId, and `invoiceId` stays out until a capture
 *   says what it accepts (the model calls it the NF-e access key, while the
 *   one real answer carries an `invoices[].id` that is not one);
 * - the submit query is EXACTLY `orderId`;
 * - the submit body is EXACTLY `invoiceContent`, `contentMD5Value`,
 *   `invoiceType`, `programType`, `marketplaceId`, serialised with
 *   `JSON.stringify` — `invoiceType`, `programType` and `marketplaceId` are this
 *   module's constants, never the caller's (and never the order's `programs[]`,
 *   whose `DELIVERY_BY_AMAZON` is not this API's vocabulary).
 *
 * ## The package checks SHAPE, never content
 *
 * The order id must match Amazon's 3-7-7 digit grammar (`'pedido'`);
 * `contentMD5Value` must be the base64 of a 16-byte digest — 22 characters and
 * `==` — so a hex digest (the model's own example value is one) is refused
 * (`'md5'`); `invoiceContent` must be standard base64 (`'base64'`). Each is an
 * `AmazonConfigError` raised BEFORE the client is called: no credential is read
 * and nothing is sent. Computing the digest and the base64 is the APP's job
 * (from one buffer of the stored XML): this package holds no crypto, so it stays
 * platform-neutral.
 *
 * ## The responses are TOLERANT
 *
 * Every field is `.nullish()`, every status an OPEN string (never `z.enum`), and
 * every object `.passthrough()`. A status outside the documented constants must
 * PARSE: deciding what it means is the app's, which reads the exact PascalCase
 * strings below. ⚠️ This API answers in PascalCase (`Accepted`) while the order's
 * own `tax.taxInvoicing.invoiceStatus` is UPPER_SNAKE (`ACCEPTED`): the two
 * vocabularies are never compared with each other.
 *
 * - `submitInvoice` answers "empty" (the retired LATAM page) or `{}` (the
 *   sandbox): both are accepted for processing, as is `{ errors: [] }`. A 2xx
 *   whose `errors` list is NOT empty is not an error class here — the helper
 *   returns it as `{ tipo: 'erros' }`, the codes only.
 * - `getInvoiceStatus` also carries an `errors` list on a 200; the schema keeps
 *   it, and reading a 200 with errors is the app's.
 * - A non-2xx is the client's (`errors.ts`), with the `errors[].code` labels on
 *   `codigosErro`. A 413 body is a BARE `ErrorList` array, so its `codigosErro`
 *   is `[]`: the status alone classifies it.
 */
import { z } from 'zod';

import { MARKETPLACE_ID_BR, type RespostaSpApi, type SpApiLeituraClient } from './client';
import type { SpApiEscritaClient } from './escrita';
import { AmazonConfigError } from './errors';
import { exigirPedidoAmazon } from './transporte';

/** The model's `operationId`s, each call's label on the observer's event. */
export const OPERACAO_GET_INVOICE_STATUS = 'getInvoiceStatus';
export const OPERACAO_SUBMIT_INVOICE = 'submitInvoice';

/** The two paths. Neither has a path parameter: the order id travels in the query. */
export const CAMINHO_STATUS_NOTA_FISCAL = '/delivery/2022-07-01/invoice/status';
export const CAMINHO_NOTA_FISCAL = '/delivery/2022-07-01/invoice';

/** `InvoiceType`: the model's only value. */
export const TIPO_FATURA_AMAZON = 'Outbound';

/** `ProgramType` of a Delivery-by-Amazon order ("also known as DBA in Brazil"). */
export const PROGRAMA_ENTREGA_AMAZON = 'EasyShip';

/** `invoiceStatus` (`ShipmentInvoiceStatus`), exactly as the API spells it. */
export const STATUS_FATURA_ENTREGA_AMAZON = {
  processing: 'Processing',
  accepted: 'Accepted',
  errored: 'Errored',
  notFound: 'NotFound',
} as const satisfies Record<string, string>;

/**
 * `orderInvoicingStatus`: "the invoicing status of the order, considering the
 * aggregated results of all invoices sent".
 */
export const STATUS_FATURAMENTO_PEDIDO_AMAZON = {
  processing: 'Processing',
  accepted: 'Accepted',
  partiallyAccepted: 'PartiallyAccepted',
  rejected: 'Rejected',
} as const satisfies Record<string, string>;

/** `invoices[].status` (`InvoiceStatus.status`). */
export const STATUS_FATURA_ITEM_AMAZON = {
  processing: 'Processing',
  accepted: 'Accepted',
  rejected: 'Rejected',
  notFound: 'NotFound',
} as const satisfies Record<string, string>;

/** The base64 of a 16-byte digest: 22 characters, then `==`. */
const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;

/** Standard base64: its alphabet, then at most two `=` (the length is checked apart). */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** An `errors[].code` as a result keeps it: printable ASCII, a label. */
const CODIGO_ERRO = /^[\x20-\x7E]{1,64}$/;

/** At most this many distinct codes per result. */
const MAX_CODIGOS_ERRO = 10;

/** One `errors[]` entry: `code` only is declared (`message`/`details` are free text). */
const erroEntregaSchema = z
  .object({
    code: z.string().nullish(),
  })
  .passthrough();

/** One `invoices[]` row. */
const statusFaturaItemSchema = z
  .object({
    id: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

/** `GetInvoiceStatusResponse`, tolerant (module header). */
export const respostaStatusNotaFiscalSchema = z
  .object({
    amazonOrderId: z.string().nullish(),
    amazonShipmentId: z.string().nullish(),
    invoiceStatus: z.string().nullish(),
    orderInvoicingStatus: z.string().nullish(),
    invoices: z.array(statusFaturaItemSchema).nullish(),
    errors: z.array(erroEntregaSchema).nullish(),
  })
  .passthrough();

export type RespostaStatusNotaFiscal = z.infer<typeof respostaStatusNotaFiscalSchema>;

/**
 * `SubmitInvoiceResponse` on a 2xx: an empty body (read as `null`) or an object
 * whose `errors` may be absent, `null` or a list.
 */
export const respostaEnvioNotaFiscalSchema = z.union([
  z.null(),
  z
    .object({
      errors: z.array(erroEntregaSchema).nullish(),
    })
    .passthrough(),
]);

export type RespostaEnvioNotaFiscal = z.infer<typeof respostaEnvioNotaFiscalSchema>;

/** What `submitInvoice`'s 2xx said: taken for processing, or a list of errors (codes only). */
export type ResultadoEnvioNotaFiscal =
  | { readonly tipo: 'aceito-para-processamento' }
  | { readonly tipo: 'erros'; readonly codigos: readonly string[] };

/** What one `submitInvoice` carries. The caller computes both values from ONE buffer of the XML. */
export interface EntradaEnvioNotaFiscal {
  /** The order the invoice belongs to (3-7-7). */
  readonly orderId: string;
  /** The `nfeProc` XML, base64. */
  readonly invoiceContent: string;
  /** The base64 of the MD5 of the SAME bytes. */
  readonly contentMD5Value: string;
}

function base64Valido(valor: unknown): valor is string {
  return (
    typeof valor === 'string' && valor.length > 0 && valor.length % 4 === 0 && BASE64.test(valor)
  );
}

/** The distinct, bounded codes of a 2xx `errors` list. */
function codigosDaLista(erros: readonly { readonly code?: string | null }[]): readonly string[] {
  const codigos: string[] = [];
  for (const { code } of erros) {
    if (typeof code !== 'string' || !CODIGO_ERRO.test(code) || codigos.includes(code)) continue;
    codigos.push(code);
    if (codigos.length >= MAX_CODIGOS_ERRO) break;
  }
  return codigos;
}

/**
 * `getInvoiceStatus` of ONE order, through the read client. The query is the
 * four named keys (module header); every error is the client's, and a refused
 * order id is a rejection like any other (nothing sent).
 */
export async function consultarStatusNotaFiscal(
  leitor: SpApiLeituraClient,
  orderId: string,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<RespostaStatusNotaFiscal>> {
  exigirPedidoAmazon(orderId, OPERACAO_GET_INVOICE_STATUS);
  return leitor.get({
    operacao: OPERACAO_GET_INVOICE_STATUS,
    caminho: CAMINHO_STATUS_NOTA_FISCAL,
    query: {
      orderId,
      marketplaceId: MARKETPLACE_ID_BR,
      invoiceType: TIPO_FATURA_AMAZON,
      programType: PROGRAMA_ENTREGA_AMAZON,
    },
    schema: respostaStatusNotaFiscalSchema,
    sinal,
  });
}

/**
 * `submitInvoice` of ONE order, through the write client. Shapes are checked
 * first (module header), then the query (`orderId` alone) and the body (the five
 * named keys) are built and sent once. A 2xx resolves; anything else is the
 * client's error, and a cut, 5xx or schema-failing answer MAY HAVE LANDED
 * (`escrita.ts`): never repeat it blindly.
 */
export async function enviarNotaFiscal(
  escritor: SpApiEscritaClient,
  entrada: EntradaEnvioNotaFiscal,
  sinal?: AbortSignal,
): Promise<ResultadoEnvioNotaFiscal> {
  const { orderId, invoiceContent, contentMD5Value } = entrada;
  exigirPedidoAmazon(orderId, OPERACAO_SUBMIT_INVOICE);
  if (typeof contentMD5Value !== 'string' || !MD5_BASE64.test(contentMD5Value)) {
    throw new AmazonConfigError('md5', { operacao: OPERACAO_SUBMIT_INVOICE, refCredencial: null });
  }
  if (!base64Valido(invoiceContent)) {
    throw new AmazonConfigError('base64', {
      operacao: OPERACAO_SUBMIT_INVOICE,
      refCredencial: null,
    });
  }

  const corpo = JSON.stringify({
    invoiceContent,
    contentMD5Value,
    invoiceType: TIPO_FATURA_AMAZON,
    programType: PROGRAMA_ENTREGA_AMAZON,
    marketplaceId: MARKETPLACE_ID_BR,
  });

  const r = await escritor.post({
    operacao: OPERACAO_SUBMIT_INVOICE,
    caminho: CAMINHO_NOTA_FISCAL,
    query: { orderId },
    corpo,
    schema: respostaEnvioNotaFiscalSchema,
    sinal,
  });

  const erros = r.dados?.errors ?? [];
  if (erros.length > 0) return { tipo: 'erros', codigos: codigosDaLista(erros) };
  return { tipo: 'aceito-para-processamento' };
}

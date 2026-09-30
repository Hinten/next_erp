/**
 * The label flow (step 15) — the paths, request shapes, bound guards and wire
 * constants of the seven `v2.logistics.*` operations {@link ShopeeClient} runs
 * to arrange a shipment and print its label.
 *
 * The operations themselves are `api.ts`'s (`getShippingParameter`,
 * `shipOrder`, `getTrackingNumber`, `getShippingDocumentParameter`,
 * `createShippingDocument`, `getShippingDocumentResult`,
 * `downloadShippingDocument`); their response schemas are `types.ts`'s; the
 * byte sniff of a downloaded label is `arquivo.ts`'s. This module holds what
 * the three share — kept out of `api.ts` so that file does not grow by another
 * step's worth of request types and guards.
 *
 * ⚠️ **Every guard runs BEFORE the access token is asked for**, and every branch
 * is a `ShopeeConfigError` — a caller bug, never a provider failure.
 *
 * ⚠️ **No guard message carries a VALUE.** An `order_sn` identifies a buyer's
 * order, `sender_real_name` is a person's name and a tracking number is a
 * parcel's; each refusal names the FIELD, the POSITION in a list and a LENGTH,
 * and nothing else. That is why these guards use {@link assertIdLogistico} and
 * never `api.ts`'s older `assertOrderSn`, which echoes what it refused (left
 * alone: not this step's change).
 *
 * ⚠️ **`package_number` is OMITTED when absent, never `""`.** Every one of the
 * seven pages says "You should't fill the field with empty string when there
 * is't a package number". The guard judges it TRIMMED and refuses the
 * whole-value `-` — the absence sentinel `get_package_detail` prints on its
 * rows — and the sender trims too, so the bytes judged are the bytes sent.
 * `order_sn` travels VERBATIM (blank refused, nothing trimmed), the step-14 rule.
 *
 * ⚠️ **A batch list is 1…{@link SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS} entries
 * with no repeated `(order_sn, package_number)` pair**: the answer's rows are
 * reconciled by that pair and never by position, and a repeated pair makes the
 * reconciliation ambiguous.
 */
import { ShopeeConfigError } from './errors';

/* -------------------------------------------------------------------------- */
/*                                 The paths                                  */
/* -------------------------------------------------------------------------- */

/** `GET` — which modes (pickup / dropoff / non-integrated) a package offers, and their options. */
export const SHOPEE_GET_SHIPPING_PARAMETER_PATH = '/api/v2/logistics/get_shipping_parameter';
/**
 * `POST` — ARRANGE the shipment. ⚠️ NOT idempotent: see
 * {@link ShopeeClient.shipOrder}.
 */
export const SHOPEE_SHIP_ORDER_PATH = '/api/v2/logistics/ship_order';
/** `GET` — the tracking number, which a label needs before it can be created. */
export const SHOPEE_GET_TRACKING_NUMBER_PATH = '/api/v2/logistics/get_tracking_number';
/** `POST` — the suggested and selectable document types of 1…50 packages. */
export const SHOPEE_GET_SHIPPING_DOCUMENT_PARAMETER_PATH =
  '/api/v2/logistics/get_shipping_document_parameter';
/** `POST` — start the label task of 1…50 packages. */
export const SHOPEE_CREATE_SHIPPING_DOCUMENT_PATH = '/api/v2/logistics/create_shipping_document';
/** `POST` — the label task's status (`READY` / `FAILED` / `PROCESSING`) of 1…50 packages. */
export const SHOPEE_GET_SHIPPING_DOCUMENT_RESULT_PATH =
  '/api/v2/logistics/get_shipping_document_result';
/** `POST` — the label FILE. It answers BYTES, never a schema (`shopeeCallArquivo`). */
export const SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT_PATH =
  '/api/v2/logistics/download_shipping_document';

/* -------------------------------------------------------------------------- */
/*                             The wire constants                             */
/* -------------------------------------------------------------------------- */

/** "limit [1,50]" — the `order_list` bound of the four document pages. */
export const SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS = 50;

/**
 * The five document types the pages name. ⚠️ Read as FREE strings everywhere:
 * `THERMAL_UNPACKAGED_LABEL` was once missing from the published enum (added
 * 2025-07-07), and a `suggest_shipping_document_type` the app forwards verbatim
 * is never refused here — the request guard asserts non-blank only.
 */
export const SHOPEE_SHIPPING_DOCUMENT_TYPES = [
  'NORMAL_AIR_WAYBILL',
  'THERMAL_AIR_WAYBILL',
  'NORMAL_JOB_AIR_WAYBILL',
  'THERMAL_JOB_AIR_WAYBILL',
  'THERMAL_UNPACKAGED_LABEL',
] as const;

/**
 * `get_shipping_document_result.result_list[].status`. ⚠️ A FREE string on the
 * wire: an unknown status is carried verbatim and read as NOT ready, never as
 * `READY` — and a row with a `fail_error` is never ready whatever its status says.
 */
export const SHOPEE_SHIPPING_DOCUMENT_STATUS = {
  pronto: 'READY',
  falhou: 'FAILED',
  processando: 'PROCESSING',
} as const;

/**
 * `get_shipping_parameter.pickup.address_list[].address_flag`. ⚠️ Only
 * `pickup_address` makes an address a PICKUP address; `default_address` alone
 * does not (announcement 1327).
 */
export const SHOPEE_ADDRESS_FLAG = {
  padrao: 'default_address',
  coleta: 'pickup_address',
  devolucao: 'return_address',
  atual: 'current_address',
} as const;

/** `…time_slot_list[].flags` — a suggestion, never a requirement (2025-03-24). */
export const SHOPEE_TIME_SLOT_FLAG = { recomendado: 'recommended' } as const;

/**
 * How `ship_order` sends a DROPOFF with nothing to fill — probe **P3**.
 *
 * - `'objeto-vazio'` (default): `"dropoff": {}` — guide 292 and the page itself
 *   ("Developer should still include "dropoff" field in the call even if
 *   "dropoff" has empty value"). Never `null`, never absent.
 * - `'nulos-explicitos'`: the legacy Flutter body,
 *   `{"branch_id":null,"sender_real_name":null,"tracking_number":null,"slug":null}`,
 *   with each FILLED field carrying its value instead.
 *
 * ⚠️ Whether Shopee accepts the legacy shape was never measured; flip only on
 * P3's evidence (or the first BR Correios order's).
 */
export const SHOPEE_SHIP_ORDER_DROPOFF_VAZIO: 'objeto-vazio' | 'nulos-explicitos' = 'objeto-vazio'; // P3

/* -------------------------------------------------------------------------- */
/*                             The request shapes                             */
/* -------------------------------------------------------------------------- */

/**
 * One package of one order — wire `{ order_sn, package_number? }`.
 *
 * ⚠️ `packageNumber` omitted ⇒ the key is ABSENT on the wire, never `""`.
 */
export interface ShopeeAlvoDePacote {
  readonly orderSn: string;
  readonly packageNumber?: string;
}

export interface GetShippingParameterParams {
  readonly orderSn: string;
  readonly packageNumber?: string;
}

/**
 * The `ship_order` body — EXACTLY one of `pickup` / `dropoff` /
 * `non_integrated`, unconstructible otherwise (the page's own
 * `ship_order_only_support_one_type`).
 *
 * ⚠️ `packageNumber` is sent when given. The rule "only on a SPLIT order" is the
 * app's (`SHOPEE_SHIP_ORDER_PACOTE`): Shopee refuses it in BOTH directions
 * (`ship_order_need_pacakge_number` / `ship_order_not_need_pacakge_number`), and
 * this package cannot know how many packages the order has.
 *
 * ⚠️ `addressId` / `branchId` are NUMBERS on the wire (int64): they come from a
 * `wireInt()` read of `get_shipping_parameter`, which refuses an unsafe one
 * rather than rounding it. `pickupTimeId` is an OPAQUE string, sent back
 * verbatim; omitted when the address offers no slot ("sellers can arrange
 * shipment without selecting any time slot").
 */
export type ShipOrderParams = { readonly orderSn: string; readonly packageNumber?: string } & (
  | {
      readonly modo: 'pickup';
      readonly pickup: {
        readonly addressId: number;
        readonly pickupTimeId?: string;
        readonly trackingNumber?: string;
      };
    }
  | {
      readonly modo: 'dropoff';
      readonly dropoff: {
        readonly branchId?: number;
        readonly senderRealName?: string;
        readonly trackingNumber?: string;
        readonly slug?: string;
      };
    }
  | {
      readonly modo: 'non_integrated';
      readonly nonIntegrated: { readonly trackingNumber?: string };
    }
);

/**
 * ⚠️ `responseOptionalFields` is ABSENT by default — `tracking_number` is a base
 * field, and naming an optional one risks `error_param` (the step-8 lesson). The
 * page's values are `plp_number`, `first_mile_tracking_number` and
 * `last_mile_tracking_number`; they travel comma-joined.
 */
export interface GetTrackingNumberParams {
  readonly orderSn: string;
  readonly packageNumber?: string;
  readonly responseOptionalFields?: readonly string[];
}

/** `get_shipping_document_result` — the type travels PER ENTRY on this page. */
export interface DocumentoParams {
  readonly documentos: readonly (ShopeeAlvoDePacote & { readonly shippingDocumentType?: string })[];
}

/**
 * `create_shipping_document` — per entry. ⚠️ `trackingNumber` is optional on
 * the wire ("Required except for the channel allow print before arrange
 * shipment"): whether to send it is the app's decision; a blank or `-` one is
 * refused here.
 */
export interface CriarDocumentoParams {
  readonly documentos: readonly (ShopeeAlvoDePacote & {
    readonly trackingNumber?: string;
    readonly shippingDocumentType?: string;
  })[];
}

/**
 * `download_shipping_document` — ONE type for the whole list. ⚠️ "Orders must
 * be from the same courier" is not checkable here; Shopee answers
 * `packages_can_not_download_together`.
 */
export interface BaixarDocumentoParams {
  readonly shippingDocumentType?: string;
  readonly documentos: readonly ShopeeAlvoDePacote[];
}

/* -------------------------------------------------------------------------- */
/*                            The batch projection                            */
/* -------------------------------------------------------------------------- */

/**
 * What the three document pages answer, as the SAME projection for a success
 * and for a `common.batch_api_all_failed` failure that carried its rows.
 *
 * ⚠️ The verdict is PER ROW ({@link falhaDaLinha}); `todasFalharam` only tells
 * the two envelopes apart for a log line.
 *
 * ⚠️ Rows arrive in Shopee's order, each carrying its OWN identity. Reconcile
 * them by `(order_sn, package_number)`, never by position — and fewer rows than
 * were asked for is a valid answer. ⚠️ The pages' own FAILED rows carry no
 * `package_number` at all.
 *
 * ⚠️ `avisos` is the COUNT sentence (`"<n> aviso(s) por pedido/pacote"`), or a
 * string warning as Shopee sent it — never the warning ROWS: those carry an
 * `order_sn`, and this value is meant for log lines.
 *
 * `linhasIlegiveis` counts the `null` sentinels — rows the page schema could
 * not read (an empty `order_sn`, above all).
 */
export interface ShopeeLoteLogistico<Row> {
  readonly requestId: string | null;
  readonly todasFalharam: boolean;
  readonly linhas: readonly Row[];
  readonly linhasIlegiveis: number;
  readonly avisos: string | null;
}

/**
 * A batch row's own verdict: a failure iff `fail_error` is NON-EMPTY.
 *
 * ⚠️ EXACT, never trimmed — `' '` is a failure, the envelope `error === ''`
 * rule. The code comes back VERBATIM (a leading space or a trailing TAB
 * included); canonicalising it is the classifier's job, in the app.
 */
export function falhaDaLinha(row: {
  fail_error: string | null;
  fail_message: string | null;
}): { code: string; mensagem: string | null } | null {
  if (row.fail_error === null || row.fail_error === '') return null;
  return { code: row.fail_error, mensagem: row.fail_message };
}

/* -------------------------------------------------------------------------- */
/*                                The guards                                  */
/* -------------------------------------------------------------------------- */

function ondeEsta(posicao: number | undefined): string {
  return posicao === undefined ? '' : ` (posição ${String(posicao)})`;
}

/**
 * A required TEXT id (`order_sn`, a package number, an opaque slot id): a
 * non-blank string.
 *
 * ⚠️ It echoes NO value — only the field, the position and the length. See the
 * module header.
 */
export function assertIdLogistico(
  nome: string,
  valor: unknown,
  posicao?: number,
): asserts valor is string {
  if (typeof valor !== 'string') {
    throw new ShopeeConfigError(
      `${nome} deve ser um texto${ondeEsta(posicao)} (recebido: ${typeof valor}).`,
    );
  }
  if (valor.trim() === '') {
    throw new ShopeeConfigError(
      `${nome} não pode ser vazio${ondeEsta(posicao)} (recebido: ${String(valor.length)} caracteres em branco).`,
    );
  }
}

/** An OPTIONAL text field: absent is fine, present must be non-blank. */
function assertTextoOpcional(nome: string, valor: unknown, posicao?: number): void {
  if (valor === undefined) return;
  assertIdLogistico(nome, valor, posicao);
}

/**
 * An optional `package_number` — judged TRIMMED, because the sender trims.
 *
 * ⚠️ The whole-value `-` is `get_package_detail`'s ABSENCE sentinel; a caller
 * that read one and fed it back would be naming no package at all.
 */
function assertNumeroDePacote(nome: string, valor: unknown, posicao?: number): void {
  if (valor === undefined) return;
  assertIdLogistico(nome, valor, posicao);
  if (valor.trim() === '-') {
    throw new ShopeeConfigError(
      `${nome} "-" é a SENTINELA de ausência da Shopee, nunca um pacote${ondeEsta(posicao)}.`,
    );
  }
}

/**
 * An optional tracking number: non-blank, and never the `-` absence sentinel —
 * a package row whose number is still `-` has no number to send.
 */
function assertRastreioOpcional(nome: string, valor: unknown, posicao?: number): void {
  if (valor === undefined) return;
  assertIdLogistico(nome, valor, posicao);
  if (valor.trim() === '-') {
    throw new ShopeeConfigError(
      `${nome} "-" é a SENTINELA de ausência da Shopee, nunca um rastreio${ondeEsta(posicao)}.`,
    );
  }
}

/** A numeric id sent back as an int64 — a positive SAFE integer. No value echoed. */
function assertIdNumerico(nome: string, valor: unknown): void {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro positivo seguro (recebido: ${typeof valor}).`,
    );
  }
}

/**
 * A 1…50 list of packages with no repeated `(order_sn, package_number)` pair,
 * each entry judged — and the pair keyed — on what the SENDER sends: `order_sn`
 * verbatim, `package_number` trimmed.
 */
function assertListaDePacotes<T extends ShopeeAlvoDePacote>(
  nome: string,
  lista: readonly T[],
  porEntrada?: (alvo: T, posicao: number) => void,
): void {
  const quantidade = lista.length;
  if (quantidade < 1 || quantidade > SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS) {
    throw new ShopeeConfigError(
      `${nome} deve conter de 1 a ${String(SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS)} pacotes (recebido: ${String(quantidade)}).`,
    );
  }
  const vistos = new Map<string, number>();
  lista.forEach((alvo, posicao) => {
    assertIdLogistico(`${nome}.order_sn`, alvo.orderSn, posicao);
    assertNumeroDePacote(`${nome}.package_number`, alvo.packageNumber, posicao);
    porEntrada?.(alvo, posicao);
    const chave = JSON.stringify([alvo.orderSn, alvo.packageNumber?.trim() ?? null]);
    const anterior = vistos.get(chave);
    if (anterior !== undefined) {
      throw new ShopeeConfigError(
        `${nome} repete o par (order_sn, package_number) nas posições ${String(anterior)} e ${String(posicao)} — a resposta é conciliada por esse par, e um par repetido a torna ambígua.`,
      );
    }
    vistos.set(chave, posicao);
  });
}

/** `get_shipping_parameter`. */
export function assertShippingParameterParams(p: GetShippingParameterParams): void {
  assertIdLogistico('order_sn', p.orderSn);
  assertNumeroDePacote('package_number', p.packageNumber);
}

/**
 * `ship_order`. ⚠️ `sender_real_name` is a PERSON's name: its refusal names the
 * length only, like every other here.
 */
export function assertShipOrderParams(p: ShipOrderParams): void {
  assertIdLogistico('order_sn', p.orderSn);
  assertNumeroDePacote('package_number', p.packageNumber);
  switch (p.modo) {
    case 'pickup':
      assertIdNumerico('pickup.address_id', p.pickup.addressId);
      assertTextoOpcional('pickup.pickup_time_id', p.pickup.pickupTimeId);
      assertRastreioOpcional('pickup.tracking_number', p.pickup.trackingNumber);
      return;
    case 'dropoff':
      if (p.dropoff.branchId !== undefined) {
        assertIdNumerico('dropoff.branch_id', p.dropoff.branchId);
      }
      assertTextoOpcional('dropoff.sender_real_name', p.dropoff.senderRealName);
      assertRastreioOpcional('dropoff.tracking_number', p.dropoff.trackingNumber);
      assertTextoOpcional('dropoff.slug', p.dropoff.slug);
      return;
    case 'non_integrated':
      assertRastreioOpcional('non_integrated.tracking_number', p.nonIntegrated.trackingNumber);
      return;
    default:
      // A JS caller (or a cast) can still reach here; the type cannot.
      throw new ShopeeConfigError(
        'modo de envio desconhecido — use pickup, dropoff ou non_integrated.',
      );
  }
}

/** `get_tracking_number`. */
export function assertTrackingNumberParams(p: GetTrackingNumberParams): void {
  assertIdLogistico('order_sn', p.orderSn);
  assertNumeroDePacote('package_number', p.packageNumber);
  const campos = p.responseOptionalFields;
  if (campos === undefined) return;
  // ⚠️ Refused, never normalised away: an empty list would send an empty
  // `response_optional_fields=` — omit the parameter instead.
  if (campos.length === 0) {
    throw new ShopeeConfigError(
      'response_optional_fields não pode ser uma lista vazia — omita o parâmetro.',
    );
  }
  campos.forEach((campo, posicao) => {
    assertIdLogistico('response_optional_fields', campo, posicao);
    if (campo.includes(',')) {
      throw new ShopeeConfigError(
        `response_optional_fields não pode conter vírgula — ela é o separador da lista (posição ${String(posicao)}).`,
      );
    }
  });
}

/** `get_shipping_document_parameter`. */
export function assertShippingDocumentParameterParams(p: {
  readonly pacotes: readonly ShopeeAlvoDePacote[];
}): void {
  assertListaDePacotes('order_list', p.pacotes);
}

/** `create_shipping_document`. */
export function assertCreateShippingDocumentParams(p: CriarDocumentoParams): void {
  assertListaDePacotes('order_list', p.documentos, (doc, posicao) => {
    assertRastreioOpcional('order_list.tracking_number', doc.trackingNumber, posicao);
    assertTextoOpcional('order_list.shipping_document_type', doc.shippingDocumentType, posicao);
  });
}

/** `get_shipping_document_result`. */
export function assertShippingDocumentResultParams(p: DocumentoParams): void {
  assertListaDePacotes('order_list', p.documentos, (doc, posicao) => {
    assertTextoOpcional('order_list.shipping_document_type', doc.shippingDocumentType, posicao);
  });
}

/** `download_shipping_document`. */
export function assertDownloadShippingDocumentParams(p: BaixarDocumentoParams): void {
  assertTextoOpcional('shipping_document_type', p.shippingDocumentType);
  assertListaDePacotes('order_list', p.documentos);
}

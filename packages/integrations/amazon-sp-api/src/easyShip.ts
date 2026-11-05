/**
 * Easy Ship v2022-03-23 (`easyShip_2022-03-23.json`): the pickup scheduling of
 * a Delivery-by-Amazon order, `createScheduledPackageBulk`
 * (`POST /easyShip/2022-03-23/packages/bulk`), through the WRITE client
 * (`escrita.ts`): {@link agendarPacotesEasyShip}. The model's usage plan is 1
 * request per second, burst 5.
 *
 * Written from the model (printed by `node .master_plans/amazon/evidence/amazon-doc.mjs
 * op createScheduledPackageBulk easyShip`) and its own sandbox examples, never
 * from a live call (D11). The operation is RESTRICTED: the app calls it with a
 * Restricted Data Token (`tokens.ts`) as the access token, never with the LWA
 * one.
 *
 * ## The body is built from NAMED keys, and is always the same shape
 *
 * EXACTLY `marketplaceId`, `orderScheduleDetailsList` and `labelFormat`,
 * serialised with `JSON.stringify`:
 *
 * - ONE order per call, `[{ amazonOrderId }]` and nothing else in it. No
 *   `packageDetails` — not even `null`: the model marks it optional, and without
 *   it Amazon picks the earliest time slot itself. So there is no slot choice and
 *   no rescheduling here;
 * - `labelFormat` is {@link FORMATO_ETIQUETA_EASY_SHIP}, a constant: no
 *   exported function takes a format, so this module can never ask for a PDF;
 * - `marketplaceId` is the BR store's (`client.ts`), never the caller's.
 *
 * The order id must match Amazon's 3-7-7 grammar, or
 * `AmazonConfigError('pedido')` is raised before anything is read or sent.
 *
 * ## The response is TOLERANT
 *
 * An empty 2xx (read as `null`) and `{}` both parse. Otherwise every field is
 * `.nullish()`, every object `.passthrough()`, and every enum an OPEN string:
 * the model's own sandbox answers units (`IN`, `ounces`) and a `packageStatus`
 * (`Scheduled`) outside its declared enums. Only what a caller reads is
 * declared — `scheduledPackages[]`' ids, status, tracking id and handover
 * method, `rejectedOrders[]`' order id and `error.code`, and
 * `printableDocumentsUrl` — never an error's `message` or `details` (free text
 * that echoes request values). Deciding what an answer MEANS (a rejection with
 * `ScheduledPackageAlreadyExists`, a missing URL) is the app's.
 *
 * ⚠️ `printableDocumentsUrl` is a pre-signed, short-lived link to a zip that
 * holds the buyer's label: a bearer link to personal data. It is read once and
 * handed to `documentosEasyShip.ts`; this package never stores it or puts it in
 * an error. It DOES reach the observer event: the 2xx body that carries it is
 * the event's `corpo`, like every SP-API body (only the access token is
 * scrubbed). What keeps it out of every log line is the app's logger, which
 * denies that leaf.
 *
 * ## What it is not
 *
 * No `getScheduledPackage`, `listHandoverSlots`, `updateScheduledPackages` or
 * `createScheduledPackage` helper: the read-back of a schedule is the order
 * itself (`getOrder`), and nothing here chooses or moves a slot.
 *
 * A 2xx failing the schema, a 5xx, a timeout or a dropped connection MAY HAVE
 * LANDED (`escrita.ts`): the caller re-reads the order before deciding anything.
 */
import { z } from 'zod';

import { MARKETPLACE_ID_BR, type RespostaSpApi } from './client';
import type { SpApiEscritaClient } from './escrita';
import { exigirPedidoAmazon } from './transporte';

/** The model's `operationId`, the call's label on the observer's event. */
export const OPERACAO_AGENDAMENTO_EASY_SHIP = 'createScheduledPackageBulk';

/** The bulk path. No path parameter: the order travels in the body. */
export const CAMINHO_AGENDAMENTO_EASY_SHIP = '/easyShip/2022-03-23/packages/bulk';

/** `LabelFormat`: always ZPL, the thermal printer's language. Never a parameter. */
export const FORMATO_ETIQUETA_EASY_SHIP = 'ZPL';

/**
 * The model's `Code` for "The order has already been scheduled" (HTTP 400). The
 * model's `Code` table is referenced by no operation, so it may arrive per order
 * (`rejectedOrders[].error.code`) or top-level (`errors[].code`).
 */
export const CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP = 'ScheduledPackageAlreadyExists';

/**
 * The rejection code for an order whose catalog entry has no package
 * dimensions. Named by legacy code only: the model's `Code` table does not
 * name it, so its spelling is unconfirmed until the migration window (D11).
 */
export const CODIGO_DIMENSOES_AUSENTES_EASY_SHIP = 'MissingPackageDimensions';

/** `ScheduledPackageId`: the order and Amazon's package id. */
const idPacoteAgendadoSchema = z
  .object({
    amazonOrderId: z.string().nullish(),
    packageId: z.string().nullish(),
  })
  .passthrough();

/** One `scheduledPackages[]` row (`Package`), only what is read. */
const pacoteAgendadoSchema = z
  .object({
    scheduledPackageId: idPacoteAgendadoSchema.nullish(),
    packageStatus: z.string().nullish(),
    trackingDetails: z
      .object({
        trackingId: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    packageTimeSlot: z
      .object({
        handoverMethod: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/** One `rejectedOrders[]` row (`RejectedOrder`): the order and its error's `code` only. */
const pedidoRecusadoSchema = z
  .object({
    amazonOrderId: z.string().nullish(),
    error: z
      .object({
        code: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/**
 * `CreateScheduledPackagesResponse` on a 2xx: an empty body (read as `null`), or
 * the tolerant object (module header).
 */
export const respostaAgendamentoEasyShipSchema = z.union([
  z.null(),
  z
    .object({
      scheduledPackages: z.array(pacoteAgendadoSchema).nullish(),
      rejectedOrders: z.array(pedidoRecusadoSchema).nullish(),
      printableDocumentsUrl: z.string().nullish(),
    })
    .passthrough(),
]);

export type RespostaAgendamentoEasyShip = z.infer<typeof respostaAgendamentoEasyShipSchema>;

/** What one bulk call schedules: one order, and nothing else. */
export interface EntradaAgendamentoEasyShip {
  /** The order to schedule (3-7-7). */
  readonly orderId: string;
}

/**
 * `createScheduledPackageBulk` of ONE order, through the write client built
 * with a Restricted Data Token. The order id is checked first, then the body
 * (the three named keys, module header) is built and sent once. A 2xx resolves
 * with the tolerant answer; anything else is the client's error.
 */
export async function agendarPacotesEasyShip(
  escritor: SpApiEscritaClient,
  entrada: EntradaAgendamentoEasyShip,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<RespostaAgendamentoEasyShip>> {
  const { orderId } = entrada;
  exigirPedidoAmazon(orderId, OPERACAO_AGENDAMENTO_EASY_SHIP);

  const corpo = JSON.stringify({
    marketplaceId: MARKETPLACE_ID_BR,
    orderScheduleDetailsList: [{ amazonOrderId: orderId }],
    labelFormat: FORMATO_ETIQUETA_EASY_SHIP,
  });

  return escritor.post({
    operacao: OPERACAO_AGENDAMENTO_EASY_SHIP,
    caminho: CAMINHO_AGENDAMENTO_EASY_SHIP,
    corpo,
    schema: respostaAgendamentoEasyShipSchema,
    sinal,
  });
}

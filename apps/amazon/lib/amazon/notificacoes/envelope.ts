/**
 * What the receiver reads off a delivery (step 3, PR 3-c): the relay's wrapper,
 * the notification type and its CASING, and the ROUTING fields — nothing else
 * (D5: the payload is never mapped; the task re-fetches the order).
 *
 * ## The relay wrapper
 *
 * The AWS relay's input template is `MODELO_ENTRADA_RELAY_AMAZON`
 * (`{"body": <$.body>}`, `packages/schemas/src/relayAmazon.ts`), so a delivery
 * is a one-key object whose `body` is the SQS message body:
 *
 *  - an OBJECT (the documented form) ⇒ `forma: 'relay'`;
 *  - a JSON STRING, parsed once (an undocumented Pipes corner) ⇒
 *    `forma: 'relay-string'`;
 *  - anything else — a bare notification, a wrapper with other keys — is NOT
 *    our template's output ⇒ `sem-envelope-do-relay`, so a template mismatch is
 *    visible in the logs instead of half-working.
 *
 * ## One parser per casing
 *
 * Amazon's notifications do not share a casing: `ORDER_CHANGE` is PascalCase
 * (`NotificationType`, `NotificationMetadata.ApplicationId`) and
 * `FEED_PROCESSING_FINISHED` is camelCase (`notificationType`,
 * `notificationMetadata.applicationId`). {@link lerEnvelopeAmazon} dispatches on
 * WHICH type key is present — both or neither is refused — and each parser
 * reads only its own casing: the Pascal parser refuses a camel envelope and
 * vice versa, so a casing slip can never read the wrong field as absent.
 *
 * Pure and total: no clock, no I/O, no throw. Every value is read as an OWN data
 * property of a plain object (`JSON.parse` output), and every field is checked
 * by its grammar, never trimmed or folded.
 */
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  CAMPO_CORPO_RELAY_AMAZON,
  NOTIFICATION_ID_AMAZON_REGEX,
  PEDIDO_AMAZON_REGEX,
  sellingPartnerIdValido,
} from '@delfrance/schemas';

/* -------------------------------------------------------------------------- */
/*                                   Readers                                  */
/* -------------------------------------------------------------------------- */

type Objeto = Readonly<Record<string, unknown>>;

/** A plain JSON object: not `null`, not an array. */
function ehObjeto(valor: unknown): valor is Objeto {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** An own data property of a plain object, or `undefined` (never a prototype member). */
function proprio(obj: unknown, chave: string): unknown {
  if (!ehObjeto(obj)) return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, chave);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

/** Walk own data properties: `caminho(env, 'A', 'B')` = `env.A.B`, or `undefined`. */
function caminho(obj: unknown, ...chaves: readonly string[]): unknown {
  let atual = obj;
  for (const chave of chaves) atual = proprio(atual, chave);
  return atual;
}

/** 1–256 characters of visible ASCII: an opaque id Amazon made. */
const ID_OPACO = /^[\x21-\x7E]{1,256}$/;
const idOpaco = (v: unknown): v is string => typeof v === 'string' && ID_OPACO.test(v);

/** A notification type value as a log line may carry it (Amazon's are `UPPER_SNAKE`). */
const TIPO_NOTIFICACAO = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * An ISO-8601 instant WITH its offset (`Z` or `±hh:mm`). Required: the shared
 * parser reads an offset-less string as UTC, which would silently shift a
 * local time by the zone's offset.
 */
const INSTANTE_COM_FUSO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** `PublishTime` → ms, or `null`: offset required, a non-negative safe integer. */
export function instanteEmMs(valor: unknown): number | null {
  if (typeof valor !== 'string' || !INSTANTE_COM_FUSO.test(valor)) return null;
  const ms = parseIsoToMillis(valor);
  return ms !== null && Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

/* -------------------------------------------------------------------------- */
/*                               The relay wrapper                            */
/* -------------------------------------------------------------------------- */

/** How the delivery reached us: the documented wrapper, its string form, or no wrapper. */
export type FormaDoRelayAmazon = 'relay' | 'relay-string' | 'sem-envelope';

export type DesembrulhoRelayAmazon =
  | {
      readonly tipo: 'envelope';
      readonly forma: 'relay' | 'relay-string';
      readonly envelope: Objeto;
    }
  | {
      readonly tipo: 'descartada';
      readonly forma: FormaDoRelayAmazon;
      readonly motivo: 'sem-envelope-do-relay' | 'json-invalido';
    };

/**
 * Unwrap the relay's `{ body: … }` (module header). `json` is the already
 * parsed delivery.
 */
export function desembrulharRelay(json: unknown): DesembrulhoRelayAmazon {
  const semEnvelope = {
    tipo: 'descartada',
    forma: 'sem-envelope',
    motivo: 'sem-envelope-do-relay',
  } as const;
  if (!ehObjeto(json)) return semEnvelope;
  const chaves = Object.keys(json);
  if (chaves.length !== 1 || chaves[0] !== CAMPO_CORPO_RELAY_AMAZON) return semEnvelope;
  const corpo = proprio(json, CAMPO_CORPO_RELAY_AMAZON);
  if (ehObjeto(corpo)) return { tipo: 'envelope', forma: 'relay', envelope: corpo };
  if (typeof corpo !== 'string') {
    return { tipo: 'descartada', forma: 'relay', motivo: 'sem-envelope-do-relay' };
  }
  let interno: unknown;
  try {
    interno = JSON.parse(corpo);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { tipo: 'descartada', forma: 'relay-string', motivo: 'json-invalido' };
  }
  return ehObjeto(interno)
    ? { tipo: 'envelope', forma: 'relay-string', envelope: interno }
    : { tipo: 'descartada', forma: 'relay-string', motivo: 'sem-envelope-do-relay' };
}

/* -------------------------------------------------------------------------- */
/*                         The two parsers, one per casing                    */
/* -------------------------------------------------------------------------- */

export const TIPO_ORDER_CHANGE = 'ORDER_CHANGE';
export const TIPO_FEED_PROCESSING_FINISHED = 'FEED_PROCESSING_FINISHED';

/** What one parser read: refused as not its own, a field outside its grammar, or the fields. */
export type LeituraNotificacaoAmazon<C, N extends string> =
  /** Not this parser's type in this parser's casing: nothing was read. */
  | { readonly tipo: 'outra-forma' }
  /**
   * The first routing field outside its grammar, by its WIRE name. The
   * application id is still returned: the receiver checks it FIRST.
   */
  | { readonly tipo: 'campo-invalido'; readonly applicationId: string | null; readonly campo: N }
  | { readonly tipo: 'lida'; readonly applicationId: string | null; readonly campos: C };

/** The application id as read (a string), or `null` when absent or not a string. */
const comoTexto = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The ORDER_CHANGE routing fields, each through its grammar. */
export interface CamposOrderChangeAmazon {
  readonly sellerId: string;
  readonly amazonOrderId: string;
  readonly notificationId: string;
  /** `NotificationMetadata.PublishTime` in ms — never `EventTime`, whose meaning the docs contradict. */
  readonly publishTimeMs: number;
}

export type CampoOrderChangeAmazon =
  | 'SellerId'
  | 'AmazonOrderId'
  | 'NotificationId'
  | 'PublishTime';

/**
 * `ORDER_CHANGE`, PascalCase. Reads `NotificationMetadata.ApplicationId` and
 * the four routing fields — `Payload.OrderChangeNotification.SellerId` and
 * `.AmazonOrderId`, `NotificationMetadata.NotificationId` and `.PublishTime` —
 * and NOTHING else (`Summary.FulfillmentType` included: AFN comes from
 * `getOrder`, step 5).
 */
export function lerOrderChange(
  env: unknown,
): LeituraNotificacaoAmazon<CamposOrderChangeAmazon, CampoOrderChangeAmazon> {
  if (proprio(env, 'NotificationType') !== TIPO_ORDER_CHANGE) return { tipo: 'outra-forma' };
  const applicationId = comoTexto(caminho(env, 'NotificationMetadata', 'ApplicationId'));
  const invalido = (campo: CampoOrderChangeAmazon) =>
    ({ tipo: 'campo-invalido', applicationId, campo }) as const;

  const sellerId = caminho(env, 'Payload', 'OrderChangeNotification', 'SellerId');
  if (!sellingPartnerIdValido(sellerId)) return invalido('SellerId');
  const amazonOrderId = caminho(env, 'Payload', 'OrderChangeNotification', 'AmazonOrderId');
  if (typeof amazonOrderId !== 'string' || !PEDIDO_AMAZON_REGEX.test(amazonOrderId)) {
    return invalido('AmazonOrderId');
  }
  const notificationId = caminho(env, 'NotificationMetadata', 'NotificationId');
  if (typeof notificationId !== 'string' || !NOTIFICATION_ID_AMAZON_REGEX.test(notificationId)) {
    return invalido('NotificationId');
  }
  const publishTimeMs = instanteEmMs(caminho(env, 'NotificationMetadata', 'PublishTime'));
  if (publishTimeMs === null) return invalido('PublishTime');
  return {
    tipo: 'lida',
    applicationId,
    campos: { sellerId, amazonOrderId, notificationId, publishTimeMs },
  };
}

/** The FEED_PROCESSING_FINISHED fields the receiver checks before dropping it (step 12a consumes it). */
export interface CamposFeedAmazon {
  readonly feedId: string;
  readonly feedType: string;
  readonly processingStatus: string;
  readonly accountId: string;
  /** OPTIONAL in Amazon's schema (absent or `null` for a vendor group). */
  readonly sellerId: string | null;
  readonly notificationId: string;
}

export type CampoFeedAmazon =
  | 'feedId'
  | 'feedType'
  | 'processingStatus'
  | 'accountId'
  | 'sellerId'
  | 'notificationId';

/**
 * `FEED_PROCESSING_FINISHED`, camelCase: `notificationMetadata.applicationId`,
 * `payload.feedProcessingFinishedNotification.{feedId, feedType,
 * processingStatus, accountId}` (required), its `sellerId` (optional) and
 * `notificationMetadata.notificationId`. Parsed and checked so its casing is
 * pinned; the receiver then drops it until step 12a (§3 decision 17).
 */
export function lerFeedProcessingFinished(
  env: unknown,
): LeituraNotificacaoAmazon<CamposFeedAmazon, CampoFeedAmazon> {
  if (proprio(env, 'notificationType') !== TIPO_FEED_PROCESSING_FINISHED) {
    return { tipo: 'outra-forma' };
  }
  const applicationId = comoTexto(caminho(env, 'notificationMetadata', 'applicationId'));
  const invalido = (campo: CampoFeedAmazon) =>
    ({ tipo: 'campo-invalido', applicationId, campo }) as const;
  const feed = caminho(env, 'payload', 'feedProcessingFinishedNotification');

  const feedId = proprio(feed, 'feedId');
  if (!idOpaco(feedId)) return invalido('feedId');
  const feedType = proprio(feed, 'feedType');
  if (!idOpaco(feedType)) return invalido('feedType');
  const processingStatus = proprio(feed, 'processingStatus');
  if (!idOpaco(processingStatus)) return invalido('processingStatus');
  const accountId = proprio(feed, 'accountId');
  if (!idOpaco(accountId)) return invalido('accountId');
  const sellerId = proprio(feed, 'sellerId');
  if (sellerId !== undefined && sellerId !== null && !sellingPartnerIdValido(sellerId)) {
    return invalido('sellerId');
  }
  const notificationId = caminho(env, 'notificationMetadata', 'notificationId');
  if (typeof notificationId !== 'string' || !NOTIFICATION_ID_AMAZON_REGEX.test(notificationId)) {
    return invalido('notificationId');
  }
  return {
    tipo: 'lida',
    applicationId,
    campos: {
      feedId,
      feedType,
      processingStatus,
      accountId,
      sellerId: sellerId ?? null,
      notificationId,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Dispatch                                  */
/* -------------------------------------------------------------------------- */

export type CasingAmazon = 'pascal' | 'camel';

export type LeituraEnvelopeAmazon =
  | {
      readonly tipo: 'descartada';
      readonly motivo: 'forma-ambigua' | 'sem-tipo';
      readonly casing: null;
      readonly tipoNotificacao: null;
    }
  | {
      readonly tipo: 'descartada';
      readonly motivo: 'tipo-desconhecido';
      readonly casing: CasingAmazon;
      /** The type value when it is `UPPER_SNAKE` text, else `null` (never arbitrary body text). */
      readonly tipoNotificacao: string | null;
    }
  | {
      readonly tipo: typeof TIPO_ORDER_CHANGE;
      readonly casing: 'pascal';
      readonly leitura: Exclude<
        LeituraNotificacaoAmazon<CamposOrderChangeAmazon, CampoOrderChangeAmazon>,
        { tipo: 'outra-forma' }
      >;
    }
  | {
      readonly tipo: typeof TIPO_FEED_PROCESSING_FINISHED;
      readonly casing: 'camel';
      readonly leitura: Exclude<
        LeituraNotificacaoAmazon<CamposFeedAmazon, CampoFeedAmazon>,
        { tipo: 'outra-forma' }
      >;
    };

const tipoParaLog = (v: unknown): string | null =>
  typeof v === 'string' && TIPO_NOTIFICACAO.test(v) ? v : null;

/**
 * Dispatch on WHICH type key the envelope has (module header):
 * `NotificationType` ⇒ Pascal, `notificationType` ⇒ camel, both ⇒
 * `forma-ambigua`, neither ⇒ `sem-tipo`. A type this receiver does not handle
 * in that casing ⇒ `tipo-desconhecido` — a camelCase `ORDER_CHANGE` included.
 */
export function lerEnvelopeAmazon(env: Objeto): LeituraEnvelopeAmazon {
  const pascal = Object.hasOwn(env, 'NotificationType');
  const camel = Object.hasOwn(env, 'notificationType');
  if (pascal && camel) {
    return { tipo: 'descartada', motivo: 'forma-ambigua', casing: null, tipoNotificacao: null };
  }
  if (!pascal && !camel) {
    return { tipo: 'descartada', motivo: 'sem-tipo', casing: null, tipoNotificacao: null };
  }
  if (pascal) {
    const leitura = lerOrderChange(env);
    if (leitura.tipo !== 'outra-forma') {
      return { tipo: TIPO_ORDER_CHANGE, casing: 'pascal', leitura };
    }
    return {
      tipo: 'descartada',
      motivo: 'tipo-desconhecido',
      casing: 'pascal',
      tipoNotificacao: tipoParaLog(proprio(env, 'NotificationType')),
    };
  }
  const leitura = lerFeedProcessingFinished(env);
  if (leitura.tipo !== 'outra-forma') {
    return { tipo: TIPO_FEED_PROCESSING_FINISHED, casing: 'camel', leitura };
  }
  return {
    tipo: 'descartada',
    motivo: 'tipo-desconhecido',
    casing: 'camel',
    tipoNotificacao: tipoParaLog(proprio(env, 'notificationType')),
  };
}

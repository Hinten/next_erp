/**
 * The three shipment pushes read as POINTERS, and the ONE record both halves of
 * step 7 fold (#1515).
 *
 * PURE: no clock, no Firestore, no wire call, no `console` — and **no unit
 * conversion**. Every timestamp that leaves this module is Shopee's own
 * SECONDS and says so in its field name (`…S`); the single seconds → µs
 * crossing of this path belongs to `freteTx.ts`. A second conversion here would
 * be a second policy that can disagree with the first.
 *
 * ## What a push IS, on this path
 *
 * A pointer. `push 2` (code 4, `order_trackingno_push`), `push 33` (code 30,
 * `package_fulfillment_status_push`) and `push 44` (code 47,
 * `package_info_push`) all say *a package changed* and name it; none of their
 * values is ever written. The handler applies the FETCHED package
 * (`get_package_detail`), which is what makes a replayed push, an out-of-order
 * push and a code 4 — which carries no clock at all — idempotent. The push's
 * own `tracking_no`, `fulfillment_status` and `old`/`new` are declared so the
 * LOG can carry them and so a push-vs-pull divergence becomes observable, never
 * so a patch can read them.
 *
 * ## Where it lives
 *
 * Under `pedidos/`, beside the wire readers it reuses (`orderMapping.ts`), and
 * never under `notificacoes/`: everything it folds is the pedido tree's.
 */
import { z } from 'zod';
import { wireInt } from '@delfrance/core/wire';
import type { ShopeeOrderDetailRow, ShopeePackageDetailRow } from '@delfrance/integrations-shopee';

import { positivoOuNull, segundosShopeeUtilizaveis, textoShopeeUtilizavel } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                          the record both halves fold                        */
/* -------------------------------------------------------------------------- */

/**
 * Which Shopee surface an observation came from.
 *
 * ⚠️ The two are NOT equally rich, and the consumer's fidelity rule is built on
 * that: `get_package_detail` carries the package's own clock, its own deadline
 * and the tracking number; `get_order_detail.package_list[]` carries none of
 * those and is the lossy-push BACKSTOP, riding a payload step 5 already
 * fetches. The token vocabularies differ too — `PackageFulfillmentStatus` (11
 * values) on the pull, `LogisticsStatus` (13) on the order detail — so `fonte`
 * is also how a reader knows which vocabulary it is looking at.
 */
export type FontePacoteShopee = 'get_package_detail' | 'get_order_detail';

/**
 * ONE package, as step 7 observed it — the single record the push path and the
 * code-3 backstop both produce and the fold consumes.
 *
 * ⚠️ **Every unit is in the field name.** `shipByDateS` and `updateTimeS` are
 * Shopee SECONDS, already floored (a `0` — this wire's zero-fill — is an
 * absence, never 1970). Nothing here is µs, and nothing here is ms.
 */
export interface PacoteObservadoShopee {
  /** The package identity. Never `''`, never the `-` sentinel — the producers refuse both. */
  readonly packageNumber: string;
  /**
   * The RAW wire token, verbatim (`LOGISTICS_READY`, …), or `null`.
   *
   * ⚠️ Stored as the source of truth and folded to an `EstadoFrete` on every
   * delivery — never folded here. A table correction must retro-apply with no
   * wire event (#1369), which it cannot do if only the projection survives.
   */
  readonly fulfillmentStatus: string | null;
  /** The carrier's code. `null` on every `get_order_detail` observation — it carries none. */
  readonly trackingNumber: string | null;
  /** The PER-package dispatch deadline, in SECONDS. */
  readonly shipByDateS: number | null;
  /** `logistics_channel_id`, positive-only. NEVER the carrier label. */
  readonly logisticsChannelId: number | null;
  /**
   * The clock this observation is fresh against, in SECONDS — the PACKAGE clock
   * on a pull, the ORDER clock on the code-3 backstop.
   */
  readonly updateTimeS: number | null;
  readonly fonte: FontePacoteShopee;
}

/* -------------------------------------------------------------------------- */
/*                       the three push `data` schemas                         */
/* -------------------------------------------------------------------------- */

/**
 * The `data` of the three shipment pushes, ONE schema per code.
 *
 * ⚠️ **Three schemas, not one with aliases, and the casing is why.** `push 2`
 * and `push 33` spell the order key `ordersn`; `push 44` spells it `order_sn`.
 * Worse, `push 17` (code 15, step 15's) contradicts ITSELF — its parameter
 * table says `order_sn` while its own JSON sample sends `ordersn` — so a push
 * page's table is not authoritative even over its own sample. Each schema
 * therefore declares its DOCUMENTED spelling and reads the other as tolerance,
 * documented-first, and a test per code pins which one wins when both arrive
 * and disagree.
 *
 * ⚠️ **Only the identity is strict.** `package_number` is `.min(1)`; every
 * other field is `.nullable().catch(null)` and can never fail a push. That is
 * the OPPOSITE of `shopeeEscrowListRowSchema`'s per-element rule and for the
 * same reason: there a per-FIELD catch would manufacture a null IDENTITY, here
 * none of the tolerated fields is an identity. They are diagnostics.
 *
 * ⚠️ **No value on these bodies is ever written.** See the module header.
 */
const valoresPacoteSchema = z
  .object({
    logistics_channel_id: wireInt().nullable().catch(null),
    /** SECONDS. */
    ship_by_date: wireInt().nullable().catch(null),
    /** An ID-only OTP (step 17's); declared so it is visibly NOT depended on. */
    return_code: z.string().nullable().catch(null),
  })
  .passthrough();

/**
 * `push 2` — code 4, `order_trackingno_push`.
 *
 * ⚠️ This page carries **no `update_time`**, which is why the handler pulls: a
 * push with no clock cannot be ordered against anything, and the fetched
 * package brings its own.
 */
export const dataPush4Schema = z
  .object({
    /** DOCUMENTED on this page. */
    ordersn: z.string().min(1).nullable().catch(null),
    /** Tolerated — `push 17` proves a page can contradict its own table. */
    order_sn: z.string().min(1).nullable().catch(null),
    package_number: z.string().min(1),
    tracking_no: z.string().nullable().catch(null),
    /** Documented "Coming offline" — declared so it is visibly NOT depended on. */
    forder_id: z.string().nullable().catch(null),
  })
  .passthrough();

/** `push 33` — code 30, `package_fulfillment_status_push` ("New Push 2025-05-28"). */
export const dataPush30Schema = z
  .object({
    /** DOCUMENTED on this page. */
    ordersn: z.string().min(1).nullable().catch(null),
    order_sn: z.string().min(1).nullable().catch(null),
    package_number: z.string().min(1),
    fulfillment_status: z.string().nullable().catch(null),
    /** SECONDS — "a change in value of package fulfillment status". */
    update_time: wireInt().nullable().catch(null),
  })
  .passthrough();

/**
 * `push 44` — code 47, `package_info_push` ("New Push 2025-12-18").
 *
 * ⚠️ **`order_sn`, with the underscore**, is the documented spelling HERE.
 *
 * ⚠️ `old` and `new` are SPARSE and echo an unchanged field with the same
 * value, and the page's own two samples disagree on the DIRECTION a
 * `ship_by_date` moves. Neither is a gate: no value on this body has a path
 * into a patch, and `changed_fields` rides the diagnostic so a log can say what
 * Shopee CLAIMED moved.
 */
export const dataPush47Schema = z
  .object({
    /** DOCUMENTED on this page. */
    order_sn: z.string().min(1).nullable().catch(null),
    ordersn: z.string().min(1).nullable().catch(null),
    package_number: z.string().min(1),
    changed_fields: z.array(z.string()).nullable().catch(null),
    old: valoresPacoteSchema.nullable().catch(null),
    new: valoresPacoteSchema.nullable().catch(null),
    /** SECONDS — "a change in value of ship_by_date or logistics_channel_id". */
    update_time: wireInt().nullable().catch(null),
  })
  .passthrough();

/* -------------------------------------------------------------------------- */
/*                        the reader the frete arm calls                       */
/* -------------------------------------------------------------------------- */

/** The three push codes step 7 owns. */
export type CodigoPushFrete = 4 | 30 | 47;

/** Which spelling of the order key a push actually used. */
export type GrafiaDoPedidoShopee = 'ordersn' | 'order_sn';

/**
 * Everything a shipment push CLAIMS, for the log line and for nothing else.
 *
 * ⚠️ Not one field of this reaches a Firestore patch. Two pushes that disagree
 * about their own values but point at the same package produce byte-identical
 * writes, because the write comes from the pull.
 */
export interface DiagnosticoPushFrete {
  readonly code: CodigoPushFrete;
  /** The spelling this push used for the order key. */
  readonly grafiaDoPedido: GrafiaDoPedidoShopee;
  /** code 4 — the push's OWN tracking number. LOGGED, never written. */
  readonly trackingNoDoPush: string | null;
  /** code 30 — the push's OWN token. LOGGED, never written (register item 28). */
  readonly statusDoPush: string | null;
  /** code 47 — Shopee's own claim about what moved. A DIAGNOSTIC, never a gate. */
  readonly camposMudados: readonly string[] | null;
  /** code 47, SECONDS, floored like every other stamp on this wire. */
  readonly shipByDateAntigaS: number | null;
  readonly shipByDateNovaS: number | null;
  readonly canalAntigo: number | null;
  readonly canalNovo: number | null;
  /**
   * The push's own clock, SECONDS.
   *
   * ⚠️ **Always `null` on code 4** — `push 2` documents none, and inventing one
   * would hand the log a clock nobody can source.
   */
  readonly relogioDoPushS: number | null;
}

/**
 * What the frete arm needs off a push, or why it cannot act.
 *
 * ⚠️ `motivo` carries field PATHS and fixed prose only — never a value and
 * never a body (#1015). A parked row is read by an operator.
 */
export type AlvoDoPushDeFrete =
  | {
      readonly ok: true;
      readonly code: CodigoPushFrete;
      readonly orderSn: string;
      readonly packageNumber: string;
      readonly diagnostico: DiagnosticoPushFrete;
    }
  | { readonly ok: false; readonly motivo: string };

/**
 * How many Zod issue PATHS a `motivo` may name.
 *
 * A malformed body can raise one issue per declared field; six is enough to
 * diagnose and short enough that the parked row stays readable.
 */
const MAX_CAMINHOS_NO_MOTIVO = 6;

function falhaDeSchema(code: CodigoPushFrete, erro: z.ZodError): AlvoDoPushDeFrete {
  const caminhos = erro.issues
    .slice(0, MAX_CAMINHOS_NO_MOTIVO)
    .map((issue) => (issue.path.length === 0 ? '(raiz)' : issue.path.join('.')));
  return {
    ok: false,
    motivo: `data inválido no push ${String(code)}: ${caminhos.join(', ')}`,
  };
}

interface IdentidadeDoPushDeFrete {
  readonly orderSn: string;
  readonly packageNumber: string;
  readonly grafiaDoPedido: GrafiaDoPedidoShopee;
}

/**
 * The order key and the package number, documented spelling FIRST.
 *
 * ⚠️ A `-` in either identity is an ABSENCE, not a key (`textoShopeeUtilizavel`)
 * — Shopee prints that sentinel on `package_number` on the tracking pages, and
 * a handler that took it would fetch "no package" and key a diary row on a dash.
 */
function identidadeDoPush(
  documentado: string | null,
  tolerado: string | null,
  grafiaDocumentada: GrafiaDoPedidoShopee,
  grafiaTolerada: GrafiaDoPedidoShopee,
  packageNumberBruto: string,
): IdentidadeDoPushDeFrete | { readonly motivo: string } {
  const doDocumentado = textoShopeeUtilizavel(documentado);
  const doTolerado = textoShopeeUtilizavel(tolerado);
  const orderSn = doDocumentado ?? doTolerado;
  if (orderSn === null) return { motivo: 'sem ordersn/order_sn' };

  const packageNumber = textoShopeeUtilizavel(packageNumberBruto);
  if (packageNumber === null) return { motivo: 'sem package_number' };

  return {
    orderSn,
    packageNumber,
    grafiaDoPedido: doDocumentado === null ? grafiaTolerada : grafiaDocumentada,
  };
}

function ehFalha(
  r: IdentidadeDoPushDeFrete | { readonly motivo: string },
): r is { readonly motivo: string } {
  return 'motivo' in r;
}

/**
 * One shipment push → the package it points at, or a readable refusal.
 *
 * Codes 4, 30 and 47 only: `DISPATCH` routes exactly those three here, so a
 * fourth is unreachable today and a visible terminal row the day that stops.
 */
export function alvoDoPushDeFrete(
  code: number,
  data: Record<string, unknown> | null,
): AlvoDoPushDeFrete {
  const corpo: unknown = data ?? {};

  if (code === 4) {
    const lido = dataPush4Schema.safeParse(corpo);
    if (!lido.success) return falhaDeSchema(4, lido.error);
    const d = lido.data;
    const ident = identidadeDoPush(d.ordersn, d.order_sn, 'ordersn', 'order_sn', d.package_number);
    if (ehFalha(ident)) return { ok: false, motivo: ident.motivo };
    return {
      ok: true,
      code: 4,
      orderSn: ident.orderSn,
      packageNumber: ident.packageNumber,
      diagnostico: {
        code: 4,
        grafiaDoPedido: ident.grafiaDoPedido,
        trackingNoDoPush: textoShopeeUtilizavel(d.tracking_no),
        statusDoPush: null,
        camposMudados: null,
        shipByDateAntigaS: null,
        shipByDateNovaS: null,
        canalAntigo: null,
        canalNovo: null,
        // ⚠️ `push 2` carries NO `update_time`. A body that ships one anyway is
        // an undocumented field, and reading it would put a clock we cannot
        // source beside clocks we can.
        relogioDoPushS: null,
      },
    };
  }

  if (code === 30) {
    const lido = dataPush30Schema.safeParse(corpo);
    if (!lido.success) return falhaDeSchema(30, lido.error);
    const d = lido.data;
    const ident = identidadeDoPush(d.ordersn, d.order_sn, 'ordersn', 'order_sn', d.package_number);
    if (ehFalha(ident)) return { ok: false, motivo: ident.motivo };
    return {
      ok: true,
      code: 30,
      orderSn: ident.orderSn,
      packageNumber: ident.packageNumber,
      diagnostico: {
        code: 30,
        grafiaDoPedido: ident.grafiaDoPedido,
        trackingNoDoPush: null,
        statusDoPush: textoShopeeUtilizavel(d.fulfillment_status),
        camposMudados: null,
        shipByDateAntigaS: null,
        shipByDateNovaS: null,
        canalAntigo: null,
        canalNovo: null,
        relogioDoPushS: segundosShopeeUtilizaveis(d.update_time),
      },
    };
  }

  if (code === 47) {
    const lido = dataPush47Schema.safeParse(corpo);
    if (!lido.success) return falhaDeSchema(47, lido.error);
    const d = lido.data;
    const ident = identidadeDoPush(d.order_sn, d.ordersn, 'order_sn', 'ordersn', d.package_number);
    if (ehFalha(ident)) return { ok: false, motivo: ident.motivo };
    return {
      ok: true,
      code: 47,
      orderSn: ident.orderSn,
      packageNumber: ident.packageNumber,
      diagnostico: {
        code: 47,
        grafiaDoPedido: ident.grafiaDoPedido,
        trackingNoDoPush: null,
        statusDoPush: null,
        camposMudados: d.changed_fields,
        // The same 2020 floor the rest of this wire gets: a zero-fill printed
        // in a log line as a deadline is the 1970 bug wearing a diagnostic hat.
        shipByDateAntigaS: segundosShopeeUtilizaveis(d.old?.ship_by_date),
        shipByDateNovaS: segundosShopeeUtilizaveis(d.new?.ship_by_date),
        canalAntigo: positivoOuNull(d.old?.logistics_channel_id),
        canalNovo: positivoOuNull(d.new?.logistics_channel_id),
        relogioDoPushS: segundosShopeeUtilizaveis(d.update_time),
      },
    };
  }

  return { ok: false, motivo: 'push_code inesperado no braço de frete' };
}

/* -------------------------------------------------------------------------- */
/*                    producer A — from the package pull                       */
/* -------------------------------------------------------------------------- */

/**
 * One `get_package_detail` row → one {@link PacoteObservadoShopee}.
 *
 * `null` when the row carries no usable `package_number`: a row whose identity
 * is `''` or the `-` sentinel is not a package, and returning it would key a
 * diary entry on an absence.
 *
 * ⚠️ Units, all of them named: `update_time` and `ship_by_date` are SECONDS and
 * stay seconds. The 2020 floor (`segundosShopeeUtilizaveis`) is applied to
 * BOTH, HERE, at the wire boundary, once — `orderFreteMapping.ts` floors the
 * same field on the same wire in the same place, and a floor applied in two
 * modules is two policies that can disagree.
 *
 * ⚠️ `logistics_channel_id` goes through `positivoOuNull`, not `?? null`:
 * Shopee zero-fills absent numerics, and `String(0)` as a channel id is a
 * channel that does not exist.
 */
export function observadoDoPacoteDetalhe(
  row: ShopeePackageDetailRow,
): PacoteObservadoShopee | null {
  const packageNumber = textoShopeeUtilizavel(row.package_number);
  if (packageNumber === null) return null;
  return {
    packageNumber,
    fulfillmentStatus: textoShopeeUtilizavel(row.fulfillment_status),
    trackingNumber: textoShopeeUtilizavel(row.tracking_number),
    shipByDateS: segundosShopeeUtilizaveis(row.ship_by_date),
    logisticsChannelId: positivoOuNull(row.logistics_channel_id),
    updateTimeS: segundosShopeeUtilizaveis(row.update_time),
    fonte: 'get_package_detail',
  };
}

/* -------------------------------------------------------------------------- */
/*                  producer B — the code-3 backstop, from the order           */
/* -------------------------------------------------------------------------- */

export interface ObservadosDoPedidoShopee {
  readonly observados: readonly PacoteObservadoShopee[];
  /** Rows whose `package_number` was absent or the `-` sentinel. A COUNT, for the log. */
  readonly ignorados: number;
}

/**
 * Every package of an ORDER detail → the same record, off the payload step 5
 * already fetches. **No new Shopee call** — that is the whole point of the
 * backstop, and the pushes are lossy by design (`timeout=3`, `guarantee=0`,
 * three retries and then gone), with the sandbox unable to emit codes 30/47 at
 * all.
 *
 * ⚠️ **`trackingNumber` is ALWAYS null here**, because `shopeePackageSchema`
 * carries none. The consumer's merge is fill-or-keep, so a null never clears a
 * number a push-driven pull already stored.
 *
 * ⚠️ **`shipByDateS` is the ORDER-level deadline on a ONE-package order and
 * `null` on every other** (plan resolution R2). `get_order_detail` has no
 * per-package `ship_by_date`; stamping the order's onto each of N packages
 * would overwrite the per-package deadlines only a pull can learn. An order
 * with exactly one package has exactly one deadline, so there the backstop is
 * the only path by which a deadline Shopee moved WITHOUT a code 47 reaching us
 * still lands. ⚠️ "One package" means the whole `package_list` describes one
 * package AND it is readable — a list of two whose second row is illegible is
 * an order with two packages, and its order-level deadline belongs to neither.
 *
 * ⚠️ `fulfillmentStatus` here is a `LogisticsStatus` token (13 values), not a
 * `PackageFulfillmentStatus` one (11) — the same states under two names plus
 * two legacy values. It rides RAW; `fonte` is how the consumer knows which
 * vocabulary it is reading.
 *
 * ⚠️ `relogioDoPedidoS` is the ORDER clock in **SECONDS**, which the CALLER
 * reads as `segundosShopeeUtilizaveis(linha.update_time)` — the value BEFORE
 * step 5 converts it. Dividing an already-converted µs watermark by 1e6 instead
 * is the cross-unit trap rule 7 names, and the magnitude is pinned directly.
 */
export function observadosDoDetalheDoPedido(
  linha: ShopeeOrderDetailRow,
  args: { readonly relogioDoPedidoS: number | null },
): ObservadosDoPedidoShopee {
  const pacotes = linha.package_list ?? [];
  const numeros = pacotes.map((pacote) => textoShopeeUtilizavel(pacote.package_number));
  const ignorados = numeros.filter((numero) => numero === null).length;

  // R2: only an order that is ONE readable package inherits the order deadline.
  const umPacoteSo = pacotes.length === 1 && ignorados === 0;
  const prazoDaOrdemS = umPacoteSo ? segundosShopeeUtilizaveis(linha.ship_by_date) : null;

  const observados: PacoteObservadoShopee[] = [];
  pacotes.forEach((pacote, posicao) => {
    const packageNumber = numeros[posicao];
    if (packageNumber == null) return;
    observados.push({
      packageNumber,
      fulfillmentStatus: textoShopeeUtilizavel(pacote.logistics_status),
      trackingNumber: null,
      shipByDateS: prazoDaOrdemS,
      logisticsChannelId: positivoOuNull(pacote.logistics_channel_id),
      updateTimeS: args.relogioDoPedidoS,
      fonte: 'get_order_detail',
    });
  });

  return { observados, ignorados };
}

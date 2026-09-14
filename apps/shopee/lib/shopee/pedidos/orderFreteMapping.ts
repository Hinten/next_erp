/**
 * One Shopee order's shipping figures → the pedido's `freteInicial` seed
 * (#1513, step 5, plan W7).
 *
 * PURE: no Firestore, no wire call, no clock — the reference instant for the
 * dispatch-deadline fallback is Shopee's own `pay_time`, and the watermark is
 * handed in.
 *
 * ## ⚠️ Shopee ZERO-FILLS absent numerics, and that is the whole design
 *
 * The Singapore sandbox order (`__wire__/get_order_detail.qty2-sg.json`) came
 * back with `actual_shipping_fee: 0` while the buyer had paid 1.99, plus
 * `edt_from: 0`, `edt_to: 0`, `pickup_done_time: 0` and both chargeable weights
 * at `0`. So on this wire a `0` is "absent", and a `??` — which only sees
 * `null`/`undefined` — is a BUG: the legacy importer's `actual ?? estimated`
 * wrote `valorCobrado: 0` onto every unshipped order. Every numeric read here
 * therefore goes through {@link positivoOuNull}, and a fabricated zero never
 * reaches a stored money field (#957).
 *
 * ## ⚠️ `estado` is seeded and never read from `logistics_status`
 *
 * `freteInicial.estado` is in `sincronizarEstoquePedido`'s `CAMPOS_OBSERVADOS`
 * and feeds `ESTADOS_FRETE_REMOVE_ESTOQUE` — it moves PHYSICAL stock,
 * irreversibly. Step 7 owns that transition; step 5 seeds
 * `ESTADO_FRETE.iniciado` and reads no `logistics_status` at all.
 *
 * ## ⚠️ FOB, never CIF
 *
 * `MODALIDADE_FRETE.cif` (`'0'`) is the only modalidade that charges the
 * freight INTO the nota (`det.prod.vFrete`, `ICMSTot.vFrete`, the `vNF` sum, the
 * single-payment `vPag` override and the `<cobr>` duplicatas all key on it).
 * Shopee contracts and charges the freight; the store does not. CIF here is
 * #1090's exact failure — ICMS paid on freight a third party charged.
 */
import { roundReais } from '@delfrance/core/money';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  getPrazoDespachoNoFuso,
  seedFreteInicial,
  type FreteDoPedido,
  type HorarioDeCorte,
  type Volume,
} from '@delfrance/schemas';
import type { ShopeeEscrowDetail, ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';

import { microsDeSegundosShopee, positivoOuNull, segundosShopeeUtilizaveis } from './orderMapping';

/**
 * The 14:00 BRT cut-off, as this repo's own `horarioDeCorte` schedule.
 *
 * Mon–Fri, cut-off 14:00, `prazoDePostagem: 0`, no posting time — which
 * reproduces the legacy Flutter rule ("orders paid before 14:00 GMT-3 Mon–Fri
 * dispatch the same day; otherwise the next business day; Friday after 14:00 ⇒
 * Monday") through the SHARED algorithm rather than through a second copy of it.
 *
 * ⚠️ It is a FALLBACK, never an override (Lucas, 2026-09-09: some orders arrive
 * with no `ship_by_date` or with an epoch-zero one — "data de 1969"). Shopee's
 * own deadline is the authority and the one Shopee penalises against; the legacy
 * applied this rule UNCONDITIONALLY, over `ship_by_date`, with a fixed −3 h
 * offset. See {@link prazoDespachoShopee}.
 *
 * ⚠️ **A constant, and only until step 7.** When a Shopee `int_frete` document
 * exists, its operator-configured `horarioDeCorte` replaces this list (the
 * Mercado Livre `intFreteSync.ts` shape). Not built here — this step writes no
 * `int_frete` and reads none.
 */
export const HORARIO_DE_CORTE_PADRAO_SHOPEE: readonly HorarioDeCorte[] = [1, 2, 3, 4, 5].map(
  (diaDaSemana) => ({
    diaDaSemana: diaDaSemana as HorarioDeCorte['diaDaSemana'],
    horaDeCorte: 14,
    minutosDeCorte: 0,
    prazoDePostagem: 0,
    horaPostagem: null,
    minutosPostagem: null,
  }),
);

/**
 * The zone the cut-off is evaluated in — EXPLICIT, never the process's.
 *
 * `apps/nfe` runs `TZ=America/Sao_Paulo` while every other backend is UTC and
 * the test runner has a third zone, so an ambient read answers a different DAY
 * depending on which service ran it. That is what `delfrance/no-ambient-timezone`
 * exists to say, and passing the zone is its documented escape.
 */
export const FUSO_PRAZO_DESPACHO_SHOPEE = 'America/Sao_Paulo';

/**
 * The zero-fill reader every numeric here goes through.
 *
 * ⚠️ RE-EXPORTED, not re-declared. It is defined in `orderMapping.ts` beside the
 * other wire readers, and lives under both names on purpose: the plan names it
 * as this module's reader, and the alternative — a second copy — is the shape
 * the root `CLAUDE.md` names ("the copies drift toward plausible"). One fold,
 * two import paths.
 */
export { positivoOuNull };

/**
 * Grams → kilograms, or `null`.
 *
 * ⚠️ The number reaches the NF-e `<vol><pesoB>`, so the conversion is not
 * cosmetic: storing `1200` where `1.2` belongs declares a 1.2-tonne parcel. The
 * legacy wrote `order_chargeable_weight_gram` unconverted into this KG field.
 */
export function pesoKgDeGramas(gramas: number | null | undefined): number | null {
  const g = positivoOuNull(gramas);
  return g == null ? null : g / 1000;
}

/**
 * The chargeable weight of ONE package, in grams, tolerating both spellings.
 *
 * `parcel_chargeable_weight_gram` is what the sample sends and
 * `parcel_chargeable_weight` is what the table documents; both are declared on
 * the wire schema and never folded. The ORDER-level weight is the last resort
 * and only with exactly ONE package: spreading an order weight across N parcels,
 * or repeating it on each, both state a false fiscal weight.
 */
function pesoBrutoDoPacoteEmGramas(
  pacote: NonNullable<ShopeeOrderDetailRow['package_list']>[number],
  pesoDaOrdemGramas: number | null,
): number | null {
  return (
    positivoOuNull(pacote.parcel_chargeable_weight_gram) ??
    positivoOuNull(pacote.parcel_chargeable_weight) ??
    pesoDaOrdemGramas
  );
}

/** What {@link volumesDeShopee} observed, for the instrumentation log. */
export interface PesoBrutoObservado {
  readonly numero: string | null;
  readonly gramas: number | null;
  readonly quilos: number | null;
}

/**
 * One `Volume` per package.
 *
 * ⚠️ `pesoLiquido: null`. A CHARGEABLE weight is `max(actual, volumetric)` —
 * neither gross nor net — and `pesoLiquido` becomes the NF-e `<vol><pesoL>`, so
 * a wrong number here reaches a signed fiscal document.
 *
 * ⚠️ `dimensoes: null`. `dimensoesSchema` requires all three and Shopee sends
 * none. The legacy invented 10×10×10 and it reached the nota. **Never invent.**
 */
export function volumesDeShopee(detalhe: ShopeeOrderDetailRow): {
  volumes: Volume[] | null;
  pesosObservados: readonly PesoBrutoObservado[];
} {
  const pacotes = detalhe.package_list ?? [];
  if (pacotes.length === 0) return { volumes: null, pesosObservados: [] };

  const pesoDaOrdem =
    pacotes.length === 1 ? positivoOuNull(detalhe.order_chargeable_weight_gram) : null;

  const pesosObservados: PesoBrutoObservado[] = [];
  const volumes = pacotes.map((pacote) => {
    const gramas = pesoBrutoDoPacoteEmGramas(pacote, pesoDaOrdem);
    const quilos = pesoKgDeGramas(gramas);
    pesosObservados.push({ numero: pacote.package_number, gramas, quilos });
    return {
      quantidade: 1,
      especie: 'pacote',
      marca: null,
      numero: pacote.package_number,
      pesoBruto: quilos,
      pesoLiquido: null,
      dimensoes: null,
      lacres: null,
    } satisfies Volume;
  });

  return { volumes, pesosObservados };
}

/**
 * The dispatch deadline, in µs.
 *
 * 1. `ship_by_date` when it clears the 2020-01-01 floor — **Shopee's own
 *    deadline, and the one Shopee penalises against**;
 * 2. else the 14:00 cut-off applied to `pay_time` (same floor), through the
 *    shared `getPrazoDespachoNoFuso` with an EXPLICIT zone;
 * 3. else `null` — an unpaid order has no deadline to compute.
 *
 * ⚠️ Never `min()` of the two, and never an override. The legacy computed (2)
 * unconditionally and overwrote (1) with it.
 *
 * ⚠️ `getPrazoDespachoNoFuso` returns MILLISECONDS; `freteInicial.prazoDespacho`
 * is µs. The conversion is `millisToMicros`, never `coerceToMicros` — see
 * `microsDeSegundosShopee`'s docblock for why magnitude-classified coercion is
 * the trap here.
 */
export function prazoDespachoShopee(detalhe: ShopeeOrderDetailRow): number | null {
  const shipBy = segundosShopeeUtilizaveis(detalhe.ship_by_date);
  if (shipBy != null) return microsDeSegundosShopee(shipBy);

  const pagoEm = segundosShopeeUtilizaveis(detalhe.pay_time);
  if (pagoEm == null) return null;

  const prazoMs = getPrazoDespachoNoFuso(
    HORARIO_DE_CORTE_PADRAO_SHOPEE,
    pagoEm * 1000,
    FUSO_PRAZO_DESPACHO_SHOPEE,
  );
  return prazoMs == null ? null : millisToMicros(prazoMs);
}

export interface MapearFreteShopeeArgs {
  readonly detalhe: ShopeeOrderDetailRow;
  /** `null` when the escrow call failed or the order is unpaid. */
  readonly escrow: ShopeeEscrowDetail | null;
  /** The ONE order-clock watermark for this document, in µs. */
  readonly watermarkUs: number;
}

export interface FreteMapeadoShopee {
  readonly frete: FreteDoPedido;
  /** Raw grams beside the converted kilos — logged for the first deliveries. */
  readonly pesosObservados: readonly PesoBrutoObservado[];
}

/**
 * The `freteInicial` block for one Shopee order.
 *
 * ⚠️ `externalId` / `externalOptionId` are written only when the order has
 * EXACTLY ONE package. `consolidaPacote: 'nao'` means one order can produce N
 * parcels and there is one id slot: writing parcel 1's number as "the" external
 * id is a claim the block cannot support and step 7 would have to un-learn.
 * Every package's number survives in `volume.numero`. (The legacy threw
 * `UnimplementedError` here; degrading one field is the cheaper answer.)
 *
 * ⚠️ `valorCobrado` is what the BUYER was charged (the escrow names it
 * `buyer_paid_shipping_fee`), `custoCalculado` is what the shipment COSTS. They
 * are different numbers with different sources and must not be folded.
 */
export function mapearFreteInicialShopee(args: MapearFreteShopeeArgs): FreteMapeadoShopee {
  const { detalhe, escrow, watermarkUs } = args;
  const pacotes = detalhe.package_list ?? [];
  const umPacoteSo = pacotes.length === 1;
  const pacote = umPacoteSo ? pacotes[0] : undefined;

  const { volumes, pesosObservados } = volumesDeShopee(detalhe);

  const estimado = positivoOuNull(detalhe.estimated_shipping_fee);
  const pagoPeloComprador = positivoOuNull(escrow?.order_income?.buyer_paid_shipping_fee);
  const real = positivoOuNull(detalhe.actual_shipping_fee);

  const valorCobrado = pagoPeloComprador ?? estimado;
  const custoCalculado = real ?? estimado;

  const frete: FreteDoPedido = {
    ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
    externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
    externalId: pacote?.package_number ?? null,
    externalOptionId:
      pacote != null && pacote.logistics_channel_id != null
        ? String(pacote.logistics_channel_id)
        : null,
    // ⚠️ Seeded, never derived from `logistics_status` — see the module header.
    estado: ESTADO_FRETE.iniciado,
    valorCobrado: valorCobrado == null ? null : roundReais(valorCobrado),
    custoCalculado: custoCalculado == null ? null : roundReais(custoCalculado),
    // Step 7 owns tracking; a code invented here would look like a shipment.
    codRastreio: null,
    prazoDespacho: prazoDespachoShopee(detalhe),
    // ⚠️ `edt_to`, NEVER `edt_from`: a delivery FORECAST shown to an operator
    // has to be the pessimistic end of the window.
    dataPrevisaoEntrega: (() => {
      const ate = segundosShopeeUtilizaveis(detalhe.edt_to);
      return ate == null ? null : microsDeSegundosShopee(ate);
    })(),
    volumes,
    // ONE watermark for the whole document: these figures arrive inside the same
    // `get_order_detail` as the order clock, so a second guard could only ever
    // disagree with the first. Step 7 owns adding a shipment clock if it needs one.
    ultimaModificacao: watermarkUs,
  };

  return { frete, pesosObservados };
}

/**
 * The fields a re-import may REFRESH on an existing `freteInicial`.
 *
 * Enumerated deliberately: everything not named here belongs to somebody else —
 * `estado` to step 7 (it moves physical stock), `codRastreio`/`printLabelId` to
 * the label flow, `modalidade`/`transportadora`/`veiculo` to the operator.
 */
export const CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE = [
  'externalId',
  'externalOptionId',
  'valorCobrado',
  'custoCalculado',
  'volumes',
  'prazoDespacho',
  'dataPrevisaoEntrega',
  'ultimaModificacao',
] as const satisfies ReadonlyArray<keyof FreteDoPedido>;

/**
 * Merge a freshly mapped block onto the stored one.
 *
 * `{ ...existente }` first, then ONLY the eight fields above, each as
 * `mapeado ?? existente ?? null` — an absent figure never overwrites a stored
 * one (#957), and no key the list does not name is touched.
 *
 * ⚠️ The CALLER skips this entirely while `hasUserInteraction === true`. That is
 * not because the Frete tab is editable for a Shopee order (it is not —
 * `FREIGHT_TIPO_CAPS.shopee.marketplaceOwned` is `true`), but because
 * `valorCobrado` feeds `derivePedidoFreteTotals`: it has to freeze together with
 * the item money it must stay consistent with.
 */
export function mesclarFreteInicialShopee(
  existente: FreteDoPedido | null,
  mapeado: FreteDoPedido,
): FreteDoPedido {
  if (existente == null) return mapeado;
  // Written out rather than looped over the list above, so each assignment is
  // type-checked against its own field. `orderFreteMapping.test.ts` asserts that
  // the keys this CAN change are exactly `CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE`, so
  // adding one here without listing it (or vice versa) fails there.
  return {
    ...existente,
    externalId: mapeado.externalId ?? existente.externalId ?? null,
    externalOptionId: mapeado.externalOptionId ?? existente.externalOptionId ?? null,
    valorCobrado: mapeado.valorCobrado ?? existente.valorCobrado ?? null,
    custoCalculado: mapeado.custoCalculado ?? existente.custoCalculado ?? null,
    volumes: mapeado.volumes ?? existente.volumes ?? null,
    prazoDespacho: mapeado.prazoDespacho ?? existente.prazoDespacho ?? null,
    dataPrevisaoEntrega: mapeado.dataPrevisaoEntrega ?? existente.dataPrevisaoEntrega ?? null,
    ultimaModificacao: mapeado.ultimaModificacao ?? existente.ultimaModificacao ?? null,
  };
}

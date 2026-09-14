/**
 * The DRY-RUN half of `rastrear:pedido` (#1515, step 7, plan §3.0-P P4) — what a
 * shipment delivery WOULD change, without changing anything.
 *
 * ⚠️ **There is no writer in this module's body, and that is structural rather
 * than a promise in a comment.** It holds no scheduler either, so the dry run
 * cannot reach the synthetic code 3 the live handler enqueues; it reads the
 * pedido, asks Shopee, and calls the SAME pure `preverFreteShopee` the
 * transaction calls. `liquidacaoSweep.ts`'s `simularLiquidacaoShopee` is the
 * step-6 precedent, and the reason is the same one:
 *
 * ## Sharing the DECISION is not enough — the ROW SET has to match too
 *
 * A live delivery acts on ONE package, the one its push named. A rehearsal that
 * asked only for that package would never show the drift this tool exists to
 * surface: a package Shopee knows about and the stored `freteInicial.volumes[]`
 * does not. So the set is resolved in three TAGGED rungs and the difference is
 * reported —
 *
 *  - `flag` — the operator passed `--package`; nothing else is consulted;
 *  - `volume` — a `numero` on the stored `freteInicial.volumes[]` (step 5 writes
 *    one volume per package);
 *  - `order_detail` — a `package_number` on `get_order_detail.package_list[]`,
 *    which is where a package created AFTER the import (a split) first shows up.
 *
 * ## Units
 *
 * ⚠️ This module holds **no clock read and no converter of its own**. `nowUs`
 * arrives in µs from the caller (the script performs the one
 * `millisToMicros(Date.now())` of this path, item 2's pattern), and the order
 * clock crosses from Shopee SECONDS into µs by CALLING µs site 3
 * (`microsDeSegundosShopee`) — the way `pagamentoMapping.ts` does, never with a
 * converter written here and never through `coerceToMicros`, which classifies by
 * MAGNITUDE and would read `1.7e9` seconds as milliseconds ⇒ 1970.
 *
 * ## Two predictions, because there are two real paths
 *
 * Each resolved package gets the prediction a code-4/30/47 delivery would
 * produce (one observation, the push path). The ORDER rows additionally get the
 * prediction the **code-3 backstop** would produce from
 * `get_order_detail.package_list[]` — the N-package fold, off a payload step 5
 * already fetches. Printing both is how register item 28 (do push and pull ever
 * disagree about the same package?) gets answered by eye on the first live
 * order. There is deliberately no third, invented prediction.
 *
 * ⚠️ **ONE honest difference remains on the backstop half, and it is named
 * rather than hidden**: the real code-3 import hands the fold
 * `prazoDaOrdemUs = <the mapped freteInicial.prazoDespacho>`, which it already
 * computed (`prazoDespachoShopee`, µs site 4, including the 14:00 fallback);
 * this rehearsal passes `null`. Reproducing it would mean running the whole
 * freight mapper here — a second caller of a µs site, for a value the fold
 * consults ONLY when no package carries a deadline of its own, which a
 * one-package order carries whenever its `ship_by_date` clears the 2020 floor
 * (plan resolution R2).
 *
 * ⚠️ So the difference is not always ZERO, and the one case where it bites is
 * named here rather than discovered later: an order whose `ship_by_date` is
 * ABSENT or zero-filled has `shipByDateS: null` on every row, and the live
 * code-3 import then folds the mapper's 14:00-on-`pay_time` fallback. On such an
 * order — and only when that fallback differs from the STORED deadline, which a
 * re-import no longer refreshes — the BACKSTOP block can omit a
 * `freteInicial.prazoDespacho` a live import would write. The PUSH half is exact
 * either way: production passes `prazoDaOrdemUs: null` there too. The CLOCK,
 * which is consulted on every row, IS reproduced exactly.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES,
  type ShopeeClient,
  type ShopeeOrderDetailRow,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';

import {
  observadoDoPacoteDetalhe,
  observadosDoDetalheDoPedido,
  type PacoteObservadoShopee,
} from './fretePushShopee';
import { preverFreteShopee, type PrevisaoFreteShopee } from './freteTx';
import { makePedidoIdShopee } from './orderIds';
import {
  microsDeSegundosShopee,
  segundosShopeeUtilizaveis,
  textoShopeeUtilizavel,
} from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/** Which rung produced a package number. The tag rides every printed row. */
export type OrigemPacoteRastreio = 'flag' | 'volume' | 'order_detail';

/** One package the rehearsal resolved, before anything was asked about it. */
export interface AlvoPacoteRastreio {
  readonly packageNumber: string;
  readonly origem: OrigemPacoteRastreio;
}

/** What the three rungs answered, and what the two sides disagree about. */
export interface ResolucaoPacotesRastreio {
  readonly pedidoId: string;
  readonly existePedido: boolean;
  readonly temFreteInicial: boolean;
  /** `freteInicial.volumes[].numero`, in stored order, blanks and `-` dropped. */
  readonly volumesArmazenados: readonly string[];
  /**
   * `get_order_detail.package_list[].package_number`, or `null` when the order
   * detail was NOT fetched (`--package` short-circuits the other two rungs).
   */
  readonly pacotesDaOrdem: readonly string[] | null;
  /** Shopee knows it, the stored volumes do not — the drift worth seeing. */
  readonly soNaShopee: readonly string[];
  /** Stored, and Shopee's order detail does not list it. */
  readonly soNoPedido: readonly string[];
  readonly alvos: readonly AlvoPacoteRastreio[];
  /** The order row, kept for the backstop half. `null` when not fetched/found. */
  readonly ordem: ShopeeOrderDetailRow | null;
  /** The pedido document, RAW. `null` when the pedido does not exist. */
  readonly rawPedido: Record<string, unknown> | null;
}

/** What one resolved package would do to the stored block. */
export interface LinhaSimuladaRastreio {
  readonly packageNumber: string;
  readonly origem: OrigemPacoteRastreio;
  /** The RAW `get_package_detail` row, or `null` when none came back for it. */
  readonly linha: ShopeePackageDetailRow | null;
  readonly observado: PacoteObservadoShopee | null;
  /** `null` when there was no observation to decide from — `motivo` says why. */
  readonly previsao: PrevisaoFreteShopee | null;
  /**
   * Why there is no prediction. ⚠️ Fixed prose and field PATHS only, never a
   * value and never a body (#1015) — a rehearsal transcript gets pasted into an
   * issue.
   */
  readonly motivo: string | null;
}

/** What the code-3 BACKSTOP would fold from the same order, at zero wire cost. */
export interface BackstopSimuladoRastreio {
  /** The ORDER clock in wire SECONDS — never a µs watermark divided by 1e6. */
  readonly relogioDoPedidoS: number | null;
  readonly observados: readonly PacoteObservadoShopee[];
  /** Rows whose `package_number` was absent or the `-` sentinel. A COUNT. */
  readonly ignorados: number;
  readonly previsao: PrevisaoFreteShopee;
}

export interface SimulacaoRastreioShopee extends ResolucaoPacotesRastreio {
  readonly linhas: readonly LinhaSimuladaRastreio[];
  /** `null` elements of `get_package_detail.package_list` — a COUNT. */
  readonly ilegiveis: number;
  /** `true` when more packages were resolved than one batched call may carry. */
  readonly truncadoNoLimite: boolean;
  /** `null` when the order detail was not fetched or its row never came back. */
  readonly backstop: BackstopSimuladoRastreio | null;
}

export interface SimularRastreioShopeeArgs {
  readonly integracaoId: string;
  readonly orderSn: string;
  /** `--package`; `null` walks the other two rungs. */
  readonly packageNumber: string | null;
  /**
   * The run's ONE clock read, ALREADY in MICROSECONDS.
   *
   * ⚠️ It is a parameter and not a clock read on purpose: this module converts
   * nothing and reads no clock, so the same inputs always answer the same
   * prediction (the property every test in this file leans on).
   */
  readonly nowUs: number;
}

/* -------------------------------------------------------------------------- */
/*                               the stored side                               */
/* -------------------------------------------------------------------------- */

function objetoDe(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The stored volumes' package numbers, read TOLERANTLY.
 *
 * ⚠️ Raw, never through the schema: the corpus this walks includes legacy
 * pedidos, and a rehearsal that threw on a block it cannot parse would refuse to
 * show exactly the pedido an operator is asking about. `textoShopeeUtilizavel`
 * is the shared reader, so a stored `-` (the sentinel the legacy label push
 * could write) is an absence here and everywhere else.
 */
function numerosDosVolumes(rawPedido: Record<string, unknown> | null): string[] {
  const frete = objetoDe(rawPedido?.freteInicial);
  const volumes = frete === null ? null : frete.volumes;
  if (!Array.isArray(volumes)) return [];
  const numeros: string[] = [];
  for (const volume of volumes) {
    const numero = textoShopeeUtilizavel(objetoDe(volume)?.numero);
    if (numero !== null && !numeros.includes(numero)) numeros.push(numero);
  }
  return numeros;
}

/* -------------------------------------------------------------------------- */
/*                              the three rungs                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the package set, tagging each entry with the rung that produced it.
 *
 * Shared by BOTH modes deliberately: `--live` drives the real handler once per
 * entry of this same set, so a rehearsal and the run it rehearses cannot differ
 * about WHICH packages are in play — only about whether they write.
 *
 * ⚠️ `get_order_detail` is fetched only when `--package` was not given. That is
 * the whole meaning of the flag: one named package, one call.
 */
export async function resolverPacotesDeRastreio(
  db: Firestore,
  client: ShopeeClient,
  args: {
    readonly integracaoId: string;
    readonly orderSn: string;
    readonly packageNumber: string | null;
  },
): Promise<ResolucaoPacotesRastreio> {
  const { integracaoId, orderSn, packageNumber } = args;
  const pedidoId = makePedidoIdShopee(integracaoId, orderSn);

  const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const rawPedido = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  const volumesArmazenados = numerosDosVolumes(rawPedido);
  const base = {
    pedidoId,
    existePedido: rawPedido !== null,
    temFreteInicial: objetoDe(rawPedido?.freteInicial) !== null,
    volumesArmazenados,
  };

  if (packageNumber !== null) {
    return {
      ...base,
      pacotesDaOrdem: null,
      soNaShopee: [],
      soNoPedido: [],
      alvos: [{ packageNumber, origem: 'flag' }],
      ordem: null,
      rawPedido,
    };
  }

  const detalhe = await client.getOrderDetail({
    orderSnList: [orderSn],
    requestOrderStatusPending: true,
  });
  // ⚠️ By `order_sn`, never by position — the page may answer with fewer rows
  // than were asked for (`importarPedido.ts` reconciles the same way).
  const ordem = detalhe.order_list.find((r) => r.order_sn === orderSn) ?? null;

  const pacotesDaOrdem: string[] = [];
  for (const pacote of ordem?.package_list ?? []) {
    const numero = textoShopeeUtilizavel(pacote.package_number);
    if (numero !== null && !pacotesDaOrdem.includes(numero)) pacotesDaOrdem.push(numero);
  }

  const alvos: AlvoPacoteRastreio[] = volumesArmazenados.map((n) => ({
    packageNumber: n,
    origem: 'volume' as const,
  }));
  for (const numero of pacotesDaOrdem) {
    if (!volumesArmazenados.includes(numero))
      alvos.push({ packageNumber: numero, origem: 'order_detail' });
  }

  return {
    ...base,
    pacotesDaOrdem,
    soNaShopee: pacotesDaOrdem.filter((n) => !volumesArmazenados.includes(n)),
    soNoPedido: volumesArmazenados.filter((n) => !pacotesDaOrdem.includes(n)),
    alvos,
    ordem,
    rawPedido,
  };
}

/* -------------------------------------------------------------------------- */
/*                               the simulation                                */
/* -------------------------------------------------------------------------- */

/**
 * What a shipment delivery WOULD change, without changing anything.
 *
 * It reads: the pedido document, `get_order_detail` (only when `--package` was
 * not given) and ONE batched `get_package_detail` for the whole resolved set.
 * It writes nothing and enqueues nothing — there is no writer and no scheduler
 * in this body.
 */
export async function simularRastreioShopee(
  db: Firestore,
  client: ShopeeClient,
  args: SimularRastreioShopeeArgs,
): Promise<SimulacaoRastreioShopee> {
  const { integracaoId, orderSn, packageNumber, nowUs } = args;

  const resolucao = await resolverPacotesDeRastreio(db, client, {
    integracaoId,
    orderSn,
    packageNumber,
  });
  const { rawPedido, alvos, ordem } = resolucao;

  const prever = (observados: readonly PacoteObservadoShopee[], relogioDaOrdemUs: number | null) =>
    preverFreteShopee(rawPedido, {
      orderSn,
      observados,
      relogioDaOrdemUs,
      // The push path folds no order-level deadline: the package carries its own.
      // ⚠️ The BACKSTOP half passes the same `null` while production passes the
      // mapped deadline — the one honest difference, bounded in the header.
      prazoDaOrdemUs: null,
      nowUs,
    });

  /* ------------------------- the pull, once, batched ------------------------ */

  const truncadoNoLimite = alvos.length > SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES;
  // The op REFUSES a list longer than 50 before it fetches, so the slice is what
  // keeps a pathological order printing a report instead of a ShopeeConfigError.
  const pedidosDePacote = alvos.slice(0, SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES);

  let linhasDaResposta: readonly (ShopeePackageDetailRow | null)[] = [];
  if (pedidosDePacote.length > 0) {
    const detalhe = await client.getPackageDetail({
      packageNumbers: pedidosDePacote.map((a) => a.packageNumber),
    });
    linhasDaResposta = detalhe.package_list;
  }
  const ilegiveis = linhasDaResposta.filter((r) => r === null).length;

  const linhas: LinhaSimuladaRastreio[] = [];
  for (const alvo of pedidosDePacote) {
    // ⚠️ By `package_number`, NEVER by position.
    const linha =
      linhasDaResposta.find((r) => r !== null && r.package_number === alvo.packageNumber) ?? null;
    if (linha === null) {
      linhas.push({
        ...alvo,
        linha: null,
        observado: null,
        previsao: null,
        motivo: `ausente-na-resposta (linhas ilegíveis: ${String(ilegiveis)})`,
      });
      continue;
    }
    const observado = observadoDoPacoteDetalhe(linha);
    if (observado === null) {
      linhas.push({
        ...alvo,
        linha,
        observado: null,
        previsao: null,
        motivo: 'package_number não utilizável na resposta',
      });
      continue;
    }
    // Exactly the argument `rastrearPedidoShopee` hands the transaction: ONE
    // observation, no order clock, no order deadline.
    linhas.push({ ...alvo, linha, observado, previsao: prever([observado], null), motivo: null });
  }

  /* --------------------------- the code-3 backstop -------------------------- */

  let backstop: BackstopSimuladoRastreio | null = null;
  if (ordem !== null) {
    const relogioDoPedidoS = segundosShopeeUtilizaveis(ordem.update_time);
    const { observados, ignorados } = observadosDoDetalheDoPedido(ordem, { relogioDoPedidoS });
    backstop = {
      relogioDoPedidoS,
      observados,
      ignorados,
      // ⚠️ The WATERMARK LADDER, byte for byte what `importarPedido.ts` hands the
      // backstop: the order clock in µs, or `nowUs` when Shopee zero-filled it.
      // A `null` here instead would leave a zero-filled order's packages with no
      // clock at all, and the freshness gate would then have nothing to compare.
      previsao: prever(
        observados,
        relogioDoPedidoS === null ? nowUs : microsDeSegundosShopee(relogioDoPedidoS),
      ),
    };
  }

  return { ...resolucao, linhas, ilegiveis, truncadoNoLimite, backstop };
}

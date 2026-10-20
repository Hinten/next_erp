/**
 * A Loja Integrada order's shipment → the pedido's `freteInicial` (master plan
 * step 5, PR 5-b): the freight modalidade, the ROUTING of the order's shipping
 * method through the conta's freight `mapa` (step 20), the block a create
 * writes, and the two-group merge an update applies.
 *
 * PURE: no Firestore, no clock. The importer does the reads — the conta's Loja
 * Integrada `int_frete` (`buscarIntFreteDaConta`), the `mapa` registration
 * (`registrarFormaEnvioNoMapaLi`, whose answer carries the `mapa` it decided
 * from) and one read of the mapped target by id — and hands each result here.
 *
 * ## The modalidade: CIF whenever the order carries freight
 *
 * An LI payment includes the freight, so an order with freight imports as CIF
 * (`'0'`): the only modalidade under which the NF-e total equals the payments.
 * Without freight it is the conta's `modalidadeFreteImportacao`, else `'0'`. A
 * conta configured otherwise is overridden, and the answer says so
 * (`sobrescrita`) for the importer's one WARNING.
 *
 * "The order's freight" is ONE value ({@link valorFreteDoPedidoLi}): the order's
 * `valor_envio` — the leaf the order total adds up — else the first shipment's
 * `valor`. The modalidade AND the block's `valorCobrado` (the NF-e's `vFrete`)
 * both read it, so they can never disagree. A shipment `valor` that contradicts
 * `valor_envio` is reported (`valorDivergente`, the `li-totais-divergentes`
 * incidente), never imported silently.
 *
 * ## The routing — the one place this import names step 20's key folds
 *
 * The key is the FULL `'<id>---<code>'` (`chaveFormaEnvioLi`): one id carries
 * several services, so the same id under another code is another, UNMAPPED
 * method. The row is found by that key (`entradaDoMapaPorChaveLi`) and is
 * MAPPED only when its `integracaoUid` names a target (`idDoAlvoDoMapaLi`) —
 * never by its target tipo. Then, from the target read:
 *
 * | Target | `integracaoFreteOuterRef` | Aviso `lojaIntegradaFreteNaoSuportado` |
 * |---|---|---|
 * | exists, active, tipo `melhorEnvios` (with a service id), `motoboy`, `retiradaNaLoja` | the target (`melhorEnvios`: `externalOptionId` = the row's service id) | resolve |
 * | missing / inactive / a Melhor Envio row with no service / any other tipo | the conta's LI doc | raise (`alvo-ausente`, `alvo-inativo`, `alvo-sem-servico`, `tipo-nao-suportado`) |
 * | exists, active, tipo `fob` or `outros` (deliberate: the label step routes it) | the conta's LI doc | resolve (an INFO log, no aviso) |
 * | unmapped, or a `mapa` that is not a list | the conta's LI doc | resolve |
 * | a method with no usable key | the conta's LI doc | — (no row) |
 * | no Loja Integrada `int_frete` for the conta | `null` | resolve |
 *
 * The aviso is keyed by `sha256Hex(chave)` ({@link entidadeAvisoFreteLi}): the
 * aviso key fold turns `.`, `/`, `:` and whitespace into `_`, which would put
 * two distinct methods on one row, while the digest keeps them apart.
 *
 * ## The block
 *
 * `envios[0]` drives it; more than one shipment is reported (`multiEnvio`, a
 * non-blocking incidente) and never expected. `externalId` is the shipment id,
 * `externalOptionData` the raw `forma_envio`, `externalOptionIntegracao` stays
 * `null` (the label step decides it), `valorCobrado` the order's freight
 * (above, rounded),
 * `timestamp` and `dataPrevisaoEntrega` (+ `prazo` days) from the shipment's
 * creation stamp, `codRastreio` the tracking code (`''` is none), and
 * `enderecoFreteOuterReference` the fiscal endereço — whose absence withholds
 * a carrier route, never a pickup's (below).
 *
 * `prazoDespacho` is set only on the `pago` rung: a dispatch deadline counts
 * from the approval. It is the conta's `horarioDeCorte` applied to the approval
 * date in `FUSO_FISCAL` by the SHARED rule (`getPrazoDespachoNoFuso`), which
 * reads the stored rows tolerantly itself (text integers read, unreadable rows
 * dropped) — this module never validates them in front of it, so the schedule
 * answers here exactly as on every other surface. The one step-5 choice on top:
 * a row whose `horaDeCorte` is absent or `null` is an UNSET weekday and is left
 * out (the shared rule would read it as a midnight cut-off). With no row left,
 * or a schedule that answers nothing, the noon rule applies.
 *
 * Freight estado on CREATE: `aguardandoPostagem` only with a tracking code AND
 * the pedido at `pago`; `despachoAutorizado` at `pago` without one; otherwise
 * `iniciado`.
 *
 * ## No endereço, no route (owner decision, 2026-10-19)
 *
 * An order without an endereço gets its freight amount but no carrier route,
 * so no label is bought to an unknown address. With `enderecoFiscalOuterRef`
 * `null` the block keeps `valorCobrado`, the modalidade and every other field,
 * while the four fields a label is quoted or bought from —
 * `integracaoFreteOuterRef`, `externalOptionId`, `externalOptionIntegracao`
 * and `externalOptionData` — are `null`; with no `int_frete` ref the label
 * action resolves no carrier tipo at all. `externalId` stays: it names Loja
 * Integrada's shipment, and no label flow reads it without a route. The
 * routing itself, the `mapa` registration and the aviso still run: they are
 * about the conta's configuration, not this pedido's destination. The
 * importer hands `null` as well when an endereço the pedido stores — the
 * fiscal one, or this block's delivery `enderecoFreteOuterReference`, where a
 * label ships — does not pair with the pedido's cliente (stored under another
 * cliente, or an owner or a cliente it cannot read — `importarPedido.ts`,
 * step 7): no label may be bought to it.
 *
 * ⚠️ A PICKUP is exempt (owner decision, 2026-10-19): a route to an active
 * `retiradaNaLoja` target (`RoteamentoFreteLi.dispensaEndereco`, read from the
 * target DOCUMENT's tipo) ships nothing to an address, so it is kept without
 * an endereço — `enderecoFreteOuterReference` then stays `null`. And which
 * orders reach this rule at all changed the same day: a PAID order with no
 * usable delivery address is REFUSED before any write and retried
 * (`pedidoPagoSemEndereco.ts`), so "no endereço" here is an unpaid order, a
 * paid one whose pedido already stores an endereço, or one whose buyer has no
 * document (no cliente, so no endereço is stored).
 *
 * The update needs nothing of its own: an absent incoming value never
 * overwrites a stored one, so a route already stored (an operator's, or an
 * earlier import's) is never cleared; and the route fields are fill-once, so
 * the first import that finds the endereço fills an empty route (the raw
 * `externalOptionData` refreshes in the frozen group, and an EMPTY one refills
 * even on a frozen pedido — below).
 *
 * ## The update: two groups, the Shopee freeze split
 *
 *  - OUTSIDE the freeze, always: fill-once `codRastreio`, `prazoDespacho`,
 *    `integracaoFreteOuterRef`, `externalOptionId` and
 *    `enderecoFreteOuterReference` (each only while stored empty), and the
 *    promotion `iniciado → despachoAutorizado` when the pedido is `pago`. One
 *    operator save must never blind tracking or the paid promotion.
 *    ⚠️ `externalOptionId` means something different per target tipo (a Melhor
 *    Envio service id, a motoboy option), so it is filled only beside ITS ref:
 *    in the same merge that fills `integracaoFreteOuterRef`, or when the stored
 *    ref already names the routed target (`toOuterRefOrNull` on both sides: a
 *    bare `int_frete/<id>` ≡ its `documents/` form; a longer id is another
 *    target). A ref stored first (the conta's own LI doc, an operator's choice)
 *    never gets another target's option beside it.
 *  - FROZEN while the pedido carries `hasUserInteraction`: `valorCobrado`,
 *    `externalOptionData`, `dataPrevisaoEntrega`, and seeding an absent block,
 *    so an operator's money edit survives the next Loja Integrada change. An
 *    absent incoming value never overwrites a stored one.
 *    ⚠️ One exception (owner decision, 2026-10-19): an EMPTY stored
 *    `externalOptionData` (`vazioArmazenadoLi`: `null`, absent or `''`) is
 *    refilled even under the freeze. No operator writes an empty method — it is
 *    what an import without a route left — and keeping it frozen would leave a
 *    pedido routed to the conta's own Loja Integrada doc without the key its
 *    label is routed by, forever after any operator save. A NON-empty stored
 *    method (another one, or an empty map) stays frozen; so do an empty
 *    `valorCobrado` and `dataPrevisaoEntrega`.
 *
 * Nothing else is touched on update: the freight estado past `iniciado`
 * belongs to the label flow, and a tracking write-back that bumps the order's
 * stamp re-imports as no freight change at all.
 */
import { roundReais } from '@delfrance/core/money';
import { sha256Hex } from '@delfrance/data/admin';
import type { PedidoLi } from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  FUSO_FISCAL,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  chaveFormaEnvioLi,
  entradaDoMapaPorChaveLi,
  getPrazoDespachoNoFuso,
  idDoAlvoDoMapaLi,
  seedFreteInicial,
  toOuterRef,
  toOuterRefOrNull,
  type EstadoPedido,
  type FreteDoPedido,
  type HorarioDeCorte,
  type IntegracaoFrete,
  type ModalidadeFrete,
  type MotivoFreteNaoSuportadoLi,
  type OuterRef,
} from '@delfrance/schemas';

import type { RegistroDoMapaLi } from '../frete/mapaFrete';
import { dataLiParaMicros, microsDeMillisLi, millisDeMicrosLi } from './dataLi';
import { vazioArmazenadoLi } from './vazioArmazenado';

/* -------------------------------------------------------------------------- */
/*                               the modalidade                                */
/* -------------------------------------------------------------------------- */

export interface ModalidadeLi {
  readonly modalidade: ModalidadeFrete;
  /** The conta's own setting was overridden (freight on a non-CIF conta): one WARNING. */
  readonly sobrescrita: boolean;
}

/** The freight modalidade (module header). */
export function modalidadeFreteLi(
  valorFrete: number,
  modalidadeConta: ModalidadeFrete | null,
): ModalidadeLi {
  if (valorFrete > 0) {
    return {
      modalidade: MODALIDADE_FRETE.cif,
      sobrescrita: modalidadeConta !== null && modalidadeConta !== MODALIDADE_FRETE.cif,
    };
  }
  return { modalidade: modalidadeConta ?? MODALIDADE_FRETE.cif, sobrescrita: false };
}

/**
 * The order's freight (module header): `valor_envio`, else the first shipment's
 * `valor`, rounded to centavos — or `null` when neither leaf carries one. The
 * modalidade and the block's `valorCobrado` both read THIS value.
 */
export function valorFreteDoPedidoLi(pedido: PedidoLi): number | null {
  const valor = pedido.valor_envio ?? pedido.envios[0]?.valor ?? null;
  return valor === null ? null : roundReais(valor);
}

/**
 * The shipment's `valor` contradicts the order's `valor_envio` — both present
 * and a centavo or more apart — on an order with ONE shipment (several
 * shipments are their own incidente, and their values sum). Equal: the same
 * centavo. Distinct: one centavo apart; `0` vs any positive value. An absent
 * leaf contradicts nothing.
 */
export function valorFreteDivergenteLi(pedido: PedidoLi): boolean {
  if (pedido.envios.length !== 1) return false;
  const doPedido = pedido.valor_envio;
  const doEnvio = pedido.envios[0]?.valor;
  if (doPedido == null || doEnvio == null) return false;
  return roundReais(doPedido) !== roundReais(doEnvio);
}

/* -------------------------------------------------------------------------- */
/*                                 the routing                                 */
/* -------------------------------------------------------------------------- */

/** The freight tipos an order is ROUTED to at import. */
export const TIPOS_ALVO_IMPORTACAO_LI = [
  INTEGRACAO_FRETE.melhorEnvios,
  INTEGRACAO_FRETE.motoboy,
  INTEGRACAO_FRETE.retiradaNaLoja,
] as const satisfies readonly IntegracaoFrete[];

/** The tipos a row is DELIBERATELY mapped to: the label step routes them; no aviso. */
const TIPOS_DELIBERADOS: ReadonlySet<string> = new Set<string>([
  INTEGRACAO_FRETE.fob,
  INTEGRACAO_FRETE.outros,
]);

const TIPOS_ROTEADOS: ReadonlySet<string> = new Set<string>(TIPOS_ALVO_IMPORTACAO_LI);

/** What the conta's `mapa` says about the order's shipping method, before any target read. */
export type DecisaoMapaLi =
  /** No Loja Integrada `int_frete` for the conta. */
  | { readonly tipo: 'sem-int-frete'; readonly chave: string | null }
  /** The method has no usable key. */
  | { readonly tipo: 'sem-chave' }
  /** The stored `mapa` is not a list. */
  | { readonly tipo: 'mapa-invalido'; readonly chave: string }
  /** No row under the key, or a row naming no target. */
  | { readonly tipo: 'nao-mapeado'; readonly chave: string }
  | {
      readonly tipo: 'mapeado';
      readonly chave: string;
      /** The target `int_frete` doc id: the importer reads it by id. */
      readonly alvoId: string;
      /** The row's display name (the aviso's `formaEnvio`). */
      readonly nomeOriginal: string | null;
      /** The row's Melhor Envio service id (`targetData.id`), or `null`. */
      readonly idServico: string | null;
    };

/** A Melhor Envio service id: a positive safe integer, or its canonical decimal. */
function idDoServico(targetData: unknown): string | null {
  if (typeof targetData !== 'object' || targetData === null) return null;
  const id = (targetData as Record<string, unknown>).id;
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  if (typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))) {
    return id;
  }
  return null;
}

export interface EntradaDecisaoMapaLi {
  /** The conta's Loja Integrada `int_frete` doc id, or `null` when the lookup found none. */
  readonly intFreteLiId: string | null;
  /** The registration's answer, or `null` when none ran (no doc). */
  readonly registro: RegistroDoMapaLi | null;
  /** The order's `envios[0].forma_envio`, as the wire carried it. */
  readonly formaEnvio: unknown;
}

/** Decide from the `mapa` the registration read (module header). */
export function decidirMapaLi(entrada: EntradaDecisaoMapaLi): DecisaoMapaLi {
  const chave = chaveFormaEnvioLi(entrada.formaEnvio);
  const registro = entrada.registro;
  if (entrada.intFreteLiId === null || registro === null) return { tipo: 'sem-int-frete', chave };
  if (registro.resultado === 'sem-int-frete') return { tipo: 'sem-int-frete', chave };
  if (chave === null) return { tipo: 'sem-chave' };
  if (registro.resultado === 'mapa-invalido') return { tipo: 'mapa-invalido', chave };
  const linha = entradaDoMapaPorChaveLi(registro.mapa, chave);
  const alvoId = linha === null ? null : idDoAlvoDoMapaLi(linha.integracaoUid);
  if (linha === null || alvoId === null) return { tipo: 'nao-mapeado', chave };
  return {
    tipo: 'mapeado',
    chave,
    alvoId,
    nomeOriginal: typeof linha.nomeOriginal === 'string' ? linha.nomeOriginal : null,
    idServico: idDoServico(linha.targetData),
  };
}

/** The mapped target as the importer read it by id. */
export interface AlvoLidoLi {
  readonly existe: boolean;
  /** The raw document, when it exists. */
  readonly dados: Readonly<Record<string, unknown>> | null;
}

/** What the routing does with the `lojaIntegradaFreteNaoSuportado` aviso. */
export type AvisoFreteLi =
  | {
      readonly tipo: 'levantar';
      readonly chave: string;
      readonly motivo: MotivoFreteNaoSuportadoLi;
      readonly formaEnvio: string | null;
    }
  | { readonly tipo: 'resolver'; readonly chave: string };

export interface RoteamentoFreteLi {
  readonly integracaoFreteOuterRef: OuterRef | null;
  readonly externalOptionId: string | null;
  /** The routing's effect on the aviso, or `null` (a method with no key has no row). */
  readonly aviso: AvisoFreteLi | null;
  /** Mapped to `fob` or `outros`: routed to the conta's doc on purpose (an INFO log). */
  readonly deliberado: boolean;
  /**
   * Routed to an active `retiradaNaLoja` target — decided from the target
   * DOCUMENT's tipo, never from the row's `targetTipoIntegracao`: a pickup
   * ships nothing to an address, so its route needs no endereço (module
   * header, "No endereço, no route"), and a paid order on it is never refused
   * for lacking one (`pedidoPagoSemEndereco.ts`).
   */
  readonly dispensaEndereco: boolean;
}

export interface EntradaRoteamentoLi {
  readonly intFreteLiId: string | null;
  readonly decisao: DecisaoMapaLi;
  /** The target read, for a `mapeado` decision; `null` otherwise. */
  readonly alvo: AlvoLidoLi | null;
}

/** `documents/int_frete/<id>`. */
function refIntFrete(id: string): OuterRef {
  return toOuterRef(`int_frete/${id}`);
}

/** Route the order (module header's table). */
export function rotearFreteLi(entrada: EntradaRoteamentoLi): RoteamentoFreteLi {
  const { intFreteLiId, decisao, alvo } = entrada;
  const doc = intFreteLiId === null ? null : refIntFrete(intFreteLiId);
  const naConta = (aviso: AvisoFreteLi | null, deliberado = false): RoteamentoFreteLi => ({
    integracaoFreteOuterRef: doc,
    externalOptionId: null,
    aviso,
    deliberado,
    dispensaEndereco: false,
  });

  switch (decisao.tipo) {
    case 'sem-int-frete':
      return {
        integracaoFreteOuterRef: null,
        externalOptionId: null,
        aviso: decisao.chave === null ? null : { tipo: 'resolver', chave: decisao.chave },
        deliberado: false,
        dispensaEndereco: false,
      };
    case 'sem-chave':
      return naConta(null);
    case 'mapa-invalido':
    case 'nao-mapeado':
      return naConta({ tipo: 'resolver', chave: decisao.chave });
    case 'mapeado':
      break;
  }

  const levantar = (motivo: MotivoFreteNaoSuportadoLi): RoteamentoFreteLi =>
    naConta({ tipo: 'levantar', chave: decisao.chave, motivo, formaEnvio: decisao.nomeOriginal });
  const dados = alvo?.existe === true ? alvo.dados : null;
  if (dados === null) return levantar(MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente);
  if (dados.ativo === false) return levantar(MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo);
  const tipo = typeof dados.tipo === 'string' ? dados.tipo : null;
  if (tipo !== null && TIPOS_DELIBERADOS.has(tipo)) {
    return naConta({ tipo: 'resolver', chave: decisao.chave }, true);
  }
  if (tipo === null || !TIPOS_ROTEADOS.has(tipo)) {
    return levantar(MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado);
  }
  if (tipo === INTEGRACAO_FRETE.melhorEnvios && decisao.idServico === null) {
    return levantar(MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico);
  }
  return {
    integracaoFreteOuterRef: refIntFrete(decisao.alvoId),
    externalOptionId: tipo === INTEGRACAO_FRETE.melhorEnvios ? decisao.idServico : null,
    aviso: { tipo: 'resolver', chave: decisao.chave },
    deliberado: false,
    dispensaEndereco: tipo === INTEGRACAO_FRETE.retiradaNaLoja,
  };
}

/**
 * The `lojaIntegradaFreteNaoSuportado` aviso's entity for a key: its sha256,
 * fixed-length and injective in practice, where the aviso key fold would merge
 * `1---PAC.X` with `1---PAC_X`.
 */
export function entidadeAvisoFreteLi(chave: string): string {
  return sha256Hex(chave);
}

/* -------------------------------------------------------------------------- */
/*                             the dispatch deadline                           */
/* -------------------------------------------------------------------------- */

/**
 * The noon rule: Monday to Friday, cut-off 12:00, same-day dispatch — so before
 * noon on a weekday ⇒ that day, otherwise the next business day, Friday
 * afternoon and the weekend ⇒ Monday.
 */
export const HORARIO_DE_CORTE_PADRAO_LI: readonly HorarioDeCorte[] = [1, 2, 3, 4, 5].map(
  (diaDaSemana) => ({
    diaDaSemana: diaDaSemana as HorarioDeCorte['diaDaSemana'],
    horaDeCorte: 12,
    minutosDeCorte: 0,
    prazoDePostagem: 0,
    horaPostagem: null,
    minutosPostagem: null,
  }),
);

/**
 * The conta's STORED schedule minus the rows that carry no cut-off hour (an
 * unset weekday, never "cut off at midnight"), RAW — or `null` when no row is
 * left. Nothing else is filtered or validated here: the shared rule reads the
 * rest tolerantly itself (a text `'16'` is 16, a row it cannot read is
 * dropped), so this import and every other surface read one schedule one way.
 */
export function horarioDeCorteUtilizavelLi(bruto: unknown): readonly unknown[] | null {
  if (!Array.isArray(bruto)) return null;
  const linhas = (bruto as readonly unknown[]).filter(
    (linha) =>
      typeof linha === 'object' &&
      linha !== null &&
      !Array.isArray(linha) &&
      (linha as Record<string, unknown>).horaDeCorte != null,
  );
  return linhas.length > 0 ? linhas : null;
}

/**
 * The dispatch deadline for an order approved at `dataAprovacaoUs`, in µs, or
 * `null` without an approval date. The conta's schedule first, the noon rule
 * when it has no usable row or answers nothing.
 */
export function prazoDespachoLiUs(
  horarioDeCorteConta: unknown,
  dataAprovacaoUs: number | null,
): number | null {
  if (dataAprovacaoUs === null) return null;
  const aprovadoMs = millisDeMicrosLi(dataAprovacaoUs);
  const horarios = horarioDeCorteUtilizavelLi(horarioDeCorteConta);
  // Raw rows, as every other caller hands them: the shared rule reads them tolerantly.
  const daConta =
    horarios === null
      ? null
      : getPrazoDespachoNoFuso(
          horarios as unknown as readonly HorarioDeCorte[],
          aprovadoMs,
          FUSO_FISCAL,
        );
  const ms = daConta ?? getPrazoDespachoNoFuso(HORARIO_DE_CORTE_PADRAO_LI, aprovadoMs, FUSO_FISCAL);
  return ms === null ? null : microsDeMillisLi(ms);
}

/* -------------------------------------------------------------------------- */
/*                                  the block                                  */
/* -------------------------------------------------------------------------- */

/** `freteDoPedidoSchema.codRastreio`'s cap: a longer code would refuse the write. */
const MAX_COD_RASTREIO = 200;

const DIA_US = 86_400 * 1_000_000;

export interface EntradaFreteLi {
  readonly pedido: PedidoLi;
  readonly modalidadeConta: ModalidadeFrete | null;
  readonly roteamento: RoteamentoFreteLi;
  /** The conta's Loja Integrada `int_frete` `horarioDeCorte`, raw. */
  readonly horarioDeCorteConta: unknown;
  /** The approval date from the history (µs), or `null` when none or not derivable. */
  readonly dataAprovacaoUs: number | null;
  /**
   * The endereço the pedido will carry after this write, or `null` — which
   * withholds the carrier route unless it is a pickup (module header, "No
   * endereço, no route"). A pedido whose stored fiscal or delivery endereço
   * the importer cannot pair with its cliente arrives as `null` too.
   */
  readonly enderecoFiscalOuterRef: string | null;
}

export interface FreteMapeadoLi {
  /** The block as a create writes it, at `iniciado` and without a deadline (see {@link freteDeCriacaoLi}). */
  readonly base: FreteDoPedido;
  /** The deadline the block takes once the pedido is `pago`. */
  readonly prazoDespachoSePagoUs: number | null;
  readonly modalidadeSobrescrita: boolean;
  /** More than one shipment: the `li-multi-envio` incidente. */
  readonly multiEnvio: boolean;
  /** The shipment's `valor` contradicts `valor_envio`: the `li-totais-divergentes` incidente. */
  readonly valorDivergente: boolean;
}

/** The tracking code, or `null`: `''` is none, and one past the schema's cap is unusable. */
export function codRastreioLi(objeto: string | null | undefined): string | null {
  return typeof objeto === 'string' && objeto.length > 0 && objeto.length <= MAX_COD_RASTREIO
    ? objeto
    : null;
}

/** The order's freight block (module header), or `null` for an order with no shipment. */
export function mapearFreteLi(entrada: EntradaFreteLi): FreteMapeadoLi | null {
  const { pedido, roteamento } = entrada;
  const envio = pedido.envios[0];
  if (envio === undefined) return null;
  const valorFrete = valorFreteDoPedidoLi(pedido);
  const { modalidade, sobrescrita } = modalidadeFreteLi(valorFrete ?? 0, entrada.modalidadeConta);
  const criadoUs = dataLiParaMicros(envio.data_criacao);
  const forma = envio.forma_envio;
  // No endereço ⇒ no carrier route — a pickup needs none (module header, "No endereço, no route").
  const comRota = entrada.enderecoFiscalOuterRef !== null || roteamento.dispensaEndereco;
  const base: FreteDoPedido = {
    ...seedFreteInicial(modalidade, true),
    externalId: envio.id == null ? null : String(envio.id),
    externalOptionId: comRota ? roteamento.externalOptionId : null,
    externalOptionIntegracao: null,
    externalOptionData: comRota && forma != null ? { ...forma } : null,
    integracaoFreteOuterRef: comRota ? roteamento.integracaoFreteOuterRef : null,
    estado: ESTADO_FRETE.iniciado,
    valorCobrado: valorFrete,
    codRastreio: codRastreioLi(envio.objeto),
    prazoDespacho: null,
    dataPrevisaoEntrega:
      criadoUs === null || envio.prazo == null ? null : criadoUs + envio.prazo * DIA_US,
    timestamp: criadoUs,
    enderecoFreteOuterReference: entrada.enderecoFiscalOuterRef,
    clienteRecebedorOuterReference: null,
  };
  return {
    base,
    prazoDespachoSePagoUs: prazoDespachoLiUs(entrada.horarioDeCorteConta, entrada.dataAprovacaoUs),
    modalidadeSobrescrita: sobrescrita,
    multiEnvio: pedido.envios.length > 1,
    valorDivergente: valorFreteDivergenteLi(pedido),
  };
}

/** The block a CREATE writes, for the estado the pedido is created at. */
export function freteDeCriacaoLi(
  mapeado: FreteMapeadoLi,
  estadoPedido: EstadoPedido | null,
): FreteDoPedido {
  const pago = estadoPedido === ESTADO_PEDIDO.pago;
  const estado = !pago
    ? ESTADO_FRETE.iniciado
    : mapeado.base.codRastreio !== null
      ? ESTADO_FRETE.aguardandoPostagem
      : ESTADO_FRETE.despachoAutorizado;
  return {
    ...mapeado.base,
    estado,
    prazoDespacho: pago ? mapeado.prazoDespachoSePagoUs : null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the merge                                  */
/* -------------------------------------------------------------------------- */

/**
 * Strict structural equality of two JSON values: the same key SET (order
 * ignored), the same primitives by `===` (no coercion: `0` is not `'0'`, `null`
 * is not absent), arrays in order. For `externalOptionData`, which Firestore may
 * hand back with its keys reordered — so an unchanged method is not a write.
 */
export function mesmoValorJsonLi(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => mesmoValorJsonLi(v, (b as readonly unknown[])[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const chaves = Object.keys(ra);
  if (chaves.length !== Object.keys(rb).length) return false;
  return chaves.every(
    (k) => Object.prototype.hasOwnProperty.call(rb, k) && mesmoValorJsonLi(ra[k], rb[k]),
  );
}

/** The fields an update fills only while stored empty — outside the freeze. */
export const CAMPOS_FRETE_PREENCHER_UMA_VEZ_LI = [
  'codRastreio',
  'prazoDespacho',
  'integracaoFreteOuterRef',
  'externalOptionId',
  'enderecoFreteOuterReference',
] as const satisfies ReadonlyArray<keyof FreteDoPedido>;

/** The fields an update refreshes only while the pedido is not frozen. */
export const CAMPOS_FRETE_CONGELAVEIS_LI = [
  'valorCobrado',
  'externalOptionData',
  'dataPrevisaoEntrega',
] as const satisfies ReadonlyArray<keyof FreteDoPedido>;

export interface ContextoMesclaFreteLi {
  /** The pedido's `hasUserInteraction === true`. */
  readonly congelado: boolean;
  /** The estado the pedido holds after this write. */
  readonly estadoPedido: EstadoPedido | null;
}

export interface FreteMescladoLi {
  readonly bloco: Readonly<Record<string, unknown>>;
  /** The field names this merge changed (`*` for a seeded block). */
  readonly campos: readonly string[];
}

/**
 * Merge the mapped block onto the STORED one (raw) — or seed it — for an
 * update (module header). `null` when nothing changes.
 */
export function mesclarFreteLi(
  armazenado: unknown,
  mapeado: FreteMapeadoLi,
  contexto: ContextoMesclaFreteLi,
): FreteMescladoLi | null {
  const ehObjeto =
    typeof armazenado === 'object' && armazenado !== null && !Array.isArray(armazenado);
  if (!ehObjeto) {
    if (contexto.congelado) return null;
    return { bloco: freteDeCriacaoLi(mapeado, contexto.estadoPedido), campos: ['*'] };
  }

  const atual = armazenado as Readonly<Record<string, unknown>>;
  const bloco: Record<string, unknown> = { ...atual };
  const campos: string[] = [];
  const pago = contexto.estadoPedido === ESTADO_PEDIDO.pago;

  const novos: Readonly<Record<(typeof CAMPOS_FRETE_PREENCHER_UMA_VEZ_LI)[number], unknown>> = {
    codRastreio: mapeado.base.codRastreio,
    prazoDespacho: pago ? mapeado.prazoDespachoSePagoUs : null,
    integracaoFreteOuterRef: mapeado.base.integracaoFreteOuterRef,
    externalOptionId: mapeado.base.externalOptionId,
    enderecoFreteOuterReference: mapeado.base.enderecoFreteOuterReference,
  };
  // The option belongs to ITS target: filled only beside the ref it names.
  const refRoteada = mapeado.base.integracaoFreteOuterRef;
  const opcaoDoAlvo =
    refRoteada !== null &&
    (vazioArmazenadoLi(atual.integracaoFreteOuterRef) ||
      toOuterRefOrNull(atual.integracaoFreteOuterRef) === refRoteada);
  for (const campo of CAMPOS_FRETE_PREENCHER_UMA_VEZ_LI) {
    const valor = novos[campo];
    if (campo === 'externalOptionId' && !opcaoDoAlvo) continue;
    if (valor !== null && valor !== undefined && vazioArmazenadoLi(atual[campo])) {
      bloco[campo] = valor;
      campos.push(campo);
    }
  }
  if (pago && atual.estado === ESTADO_FRETE.iniciado) {
    bloco.estado = ESTADO_FRETE.despachoAutorizado;
    campos.push('estado');
  }

  for (const campo of CAMPOS_FRETE_CONGELAVEIS_LI) {
    const valor = mapeado.base[campo];
    if (valor === null || valor === undefined) continue;
    // Frozen: only an EMPTY raw method refills — an import left it so, never an operator.
    const refazVazio = campo === 'externalOptionData' && vazioArmazenadoLi(atual[campo]);
    if (contexto.congelado && !refazVazio) continue;
    if (!mesmoValorJsonLi(atual[campo], valor)) {
      bloco[campo] = valor;
      campos.push(campo);
    }
  }

  return campos.length === 0 ? null : { bloco, campos };
}

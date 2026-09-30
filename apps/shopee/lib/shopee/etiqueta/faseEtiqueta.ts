/**
 * The PURE phase decision of the Shopee label flow (#1523, step 15): from what
 * Shopee answered, per package, to the ONE next action the runner takes.
 *
 * No clock, no I/O, no Firestore, no `process.env`. The runner builds the
 * observations from Shopee's answers only (`get_order_detail` with
 * `SHOPEE_ETIQUETA_DETALHE_CAMPOS`, `get_package_detail`, and whatever the last
 * action returned), calls {@link decidirProximaAcao}, executes the action,
 * folds the answer into the observations and asks again — until the budget or
 * a terminal answer. Every call re-derives from Shopee, which is what makes the
 * route resumable: re-clicking the button IS the resume path.
 *
 * ## The package phase ({@link fasePacote})
 *
 * The fulfilment token is read with step 7's rule — an EXACT lookup, both alias
 * spellings as their own keys (`LOGISTICS_NOT_START`/`_NOT_STARTED`,
 * `LOGISTICS_REQUEST_CANCELED`/`_CANCELLED`), no trim, no case fold, no prefix.
 * {@link FASE_DO_TOKEN} is typed on step 7's own token table
 * (`ESTADO_FRETE_DE_TOKEN_SHOPEE`), so a token step 7 learns is a COMPILE error
 * here until this table decides its phase — the two readers cannot drift apart
 * by comment. Anything else, `LOGISTICS_PENDING_ARRANGE` (a return token)
 * included, is `desconhecido`, and nothing acts on it.
 *
 * ⚠️ **The invoice is checked FIRST among the pre-arrange phases** — and only
 * there (review 1, R4-5). An invoice-pending package reads
 * `LOGISTICS_NOT_START`, so a table consulted before the invoice would answer
 * `nao-pronto` and the operator would never be told the NF-e is what blocks
 * (S21). But announcement 1521 returns the pending reason "only when the order
 * or package is in a shipment-ready status": on a package already ARRANGED
 * (`REQUEST_CREATED`, `PICKUP_RETRY`, `READY` + arranged) or excluded from the
 * print by rule 2 (`janela-fechada`, `inelegivel`) a `pending` is stale, and
 * reading it would turn a printable — or an excluded — package into rule 4's
 * whole-order `nfe-pendente` plus an NF-e re-drive. An UNKNOWN token keeps the
 * gate: nothing says it is not a shipment-ready state, and the invoice is the
 * one fact Shopee did state.
 *
 * ⚠️ **`is_shipment_arranged: null` counts as NOT arranged** (⇒ `programar`,
 * S22, chosen — review 1, R2-5). Safe for the label because a duplicate
 * `ship_order` is absorbed as `package_already_shipped` by the classifier, and
 * a package that is not arranged is never printed. The price is paid by the
 * reprint: a `frete.read` caller asking for such a package gets the 403 of the
 * arrange, since the answer is `programar` and not a document step.
 *
 * ⚠️ **`pending_terms` is read through step 7's string reader** (review 1,
 * R4-2): Shopee zero-fills a string array with `["-"]` on this very page, and a
 * `"-"` or a blank entry holds nothing. Read raw, one zero-fill would hold
 * EVERY ready package as `retido`.
 *
 * ⚠️ **`LOGISTICS_PICKUP_RETRY` is arranged**, never re-arranged: the pickup
 * retry is Shopee's (`update_shipping_order`), and the package is still inside
 * the print window. `is_shipment_arranged` is only documented on
 * `LOGISTICS_READY`, so it is not consulted there.
 *
 * ## The 1-hour window is NOT here
 *
 * Lucas ruled on 2026-09-30 (reconcile Appendix A): legacy parity, never ask.
 * There is no `pay_time` in the order observation and no question action.
 */
import type { ESTADO_FRETE_DE_TOKEN_SHOPEE } from '../pedidos/freteShopeeMapping';
import { textoShopeeUtilizavel } from '../pedidos/orderMapping';
import { SHOPEE_ORDER_STATUS } from '../pedidos/orderStatusMaps';
import { IMPRIMIR_SEM_RASTREIO, SHOPEE_SHIP_ORDER_PACOTE } from './constantesEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './motivosEtiqueta';

/* -------------------------------- the types -------------------------------- */

/**
 * Where a call that answers 202 stopped — the `fase` of the pending body.
 *
 * `consultando` is the NEUTRAL phase of a read (review 2, F5): the order and
 * package reads open EVERY call, a reprint's and a document poll's included,
 * so a read that drops or runs out of budget must not report `programando` —
 * the web toasts a phase change, and "Organizando o envio" after "a Shopee está
 * gerando a etiqueta" reads to an operator as a second arrange.
 */
export type FaseEtiqueta =
  | 'consultando'
  | 'programando'
  | 'aguardando-rastreio'
  | 'gerando-documento'
  | 'baixando'
  | 'renovando-credencial'
  | 'limite-de-requisicoes';

/** What the route's `get_order_detail` said about the ORDER. */
export interface ObservacaoOrdemEtiqueta {
  /** `order_status`, verbatim (a base field — never asked for). */
  readonly status: string | null;
  /** `fulfillment_flag` trimmed + lower-cased `=== 'fulfilled_by_shopee'`. */
  readonly fbs: boolean;
  /** `package_list[].package_number`, in Shopee's order. */
  readonly pacotes: readonly string[];
}

/** What Shopee said about ONE package, accumulated across the call. */
export interface ObservacaoPacoteEtiqueta {
  readonly numero: string;
  /** `logistics_channel_id` — the download grouping key. */
  readonly canalId: number | null;
  /** `fulfillment_status`, the raw `LOGISTICS_*` token. */
  readonly fulfillment: string | null;
  /** `is_shipment_arranged`, or `true` once OUR `ship_order` succeeded. */
  readonly arranjado: boolean | null;
  /**
   * `pending_terms`, as Shopee sent it. A USABLE entry on a READY package
   * means Shopee holds it; {@link fasePacote} drops the zero-fill itself.
   */
  readonly termosPendentes: readonly string[];
  /**
   * `invoice_pending.status` trimmed + lower-cased `=== 'pending'`. Read only
   * on the pre-arrange phases (see {@link fasePacote}).
   */
  readonly nfePendente: boolean;
  /** The tracking number, normalised (`"-"`/`""` ⇒ `null`). */
  readonly rastreio: string | null;
  /** The document type chosen from `get_shipping_document_parameter`. */
  readonly tipoDocumento: string | null;
  /** The label document's state, as far as this call knows it. */
  readonly documento: 'desconhecido' | 'inexistente' | 'processando' | 'pronto' | 'falhou';
  /** This call already re-created a FAILED document once. */
  readonly recriadoNestaChamada: boolean;
}

/** One package's phase (the D2 §2 table). */
export type FasePacote =
  | 'nfe-pendente'
  | 'nao-pronto'
  | 'retido'
  | 'programar'
  | 'arranjado'
  | 'janela-fechada'
  | 'inelegivel'
  | 'desconhecido';

/** The ONE next thing the runner does. */
export type AcaoEtiqueta =
  | { tipo: 'recusa'; motivo: MotivoEtiquetaShopee }
  | { tipo: 'nfe-pendente' }
  | { tipo: 'programar'; pacote: string; comPacote: boolean }
  | { tipo: 'buscar-rastreio'; pacotes: readonly string[] }
  | { tipo: 'ler-parametros-documento'; pacotes: readonly string[] }
  | { tipo: 'ler-resultado'; pacotes: readonly string[] }
  | { tipo: 'criar-documento'; pacotes: readonly string[] }
  | { tipo: 'aguardar-documento' }
  | { tipo: 'baixar'; pacotes: readonly string[]; tipoDocumento: string | null }
  | { tipo: 'por-pacote'; pacotes: readonly string[] };

/* ----------------------------- the package phase ---------------------------- */

type TokenLogistico = keyof typeof ESTADO_FRETE_DE_TOKEN_SHOPEE;

/**
 * Every token step 7 knows → its phase. `LOGISTICS_READY` reads `programar`
 * here and {@link fasePacote} refines it (arranged / held / to arrange).
 *
 * ⚠️ `satisfies Record<TokenLogistico, …>`: a token missing here, or one
 * step 7 does not know, is a compile error — never a silent `desconhecido`.
 */
const FASE_DO_TOKEN = {
  LOGISTICS_NOT_START: 'nao-pronto',
  LOGISTICS_NOT_STARTED: 'nao-pronto',
  LOGISTICS_READY: 'programar',
  LOGISTICS_REQUEST_CREATED: 'arranjado',
  LOGISTICS_PICKUP_RETRY: 'arranjado',
  LOGISTICS_PICKUP_DONE: 'janela-fechada',
  LOGISTICS_DELIVERY_DONE: 'janela-fechada',
  LOGISTICS_DELIVERY_FAILED: 'janela-fechada',
  LOGISTICS_LOST: 'janela-fechada',
  LOGISTICS_INVALID: 'inelegivel',
  LOGISTICS_REQUEST_CANCELED: 'inelegivel',
  LOGISTICS_REQUEST_CANCELLED: 'inelegivel',
  LOGISTICS_PICKUP_FAILED: 'inelegivel',
  LOGISTICS_COD_REJECTED: 'inelegivel',
} as const satisfies Record<TokenLogistico, FasePacote>;

/**
 * The phases on which `invoice_pending` still decides (R4-5): the pre-arrange
 * ones — `nao-pronto` and a READY package nobody arranged, BEFORE its
 * `pending_terms` are read — plus an unknown token. Every other phase ignores
 * the flag (see the module docblock).
 */
const FASES_DO_PORTAO_DA_NFE: ReadonlySet<FasePacote> = new Set<FasePacote>([
  'nao-pronto',
  'programar',
  'desconhecido',
]);

/**
 * A `pending_terms` entry that says something: step 7's string reader, so
 * `"-"`, `""` and blanks hold nothing (R4-2). Any other string holds — a term
 * we do not know is still Shopee holding the package.
 */
function temTermoPendente(termos: readonly string[]): boolean {
  return termos.some((t) => textoShopeeUtilizavel(t) !== null);
}

/**
 * ONE package's phase. The token first — READY refined by `arranjado`; then
 * the invoice, on the pre-arrange phases only; then, on a READY package nobody
 * arranged, its usable `pending_terms`.
 *
 * ⚠️ READY with `arranjado: null` answers `programar` (S22): a duplicate ship is
 * absorbed as `package_already_shipped`, and a `frete.read` caller gets the
 * arrange's 403 on it rather than a reprint (R2-5).
 */
export function fasePacote(p: ObservacaoPacoteEtiqueta): FasePacote {
  const token = p.fulfillment;
  // `Object.hasOwn`, so `'constructor'` and friends answer `desconhecido`.
  const doToken: FasePacote =
    token === null || !Object.hasOwn(FASE_DO_TOKEN, token)
      ? 'desconhecido'
      : FASE_DO_TOKEN[token as TokenLogistico];
  const fase: FasePacote = doToken === 'programar' && p.arranjado === true ? 'arranjado' : doToken;
  if (p.nfePendente && FASES_DO_PORTAO_DA_NFE.has(fase)) return 'nfe-pendente';
  if (fase !== 'programar') return fase;
  return temTermoPendente(p.termosPendentes) ? 'retido' : 'programar';
}

/* ------------------------------ download groups ----------------------------- */

/**
 * The packages that may be downloaded together — same `logistics_channel_id`
 * ("same courier") — in Shopee's order: groups appear where their first
 * package appears, and packages keep their order inside a group.
 *
 * ⚠️ A `canalId: null` package is a group of its OWN: nothing proves it shares
 * a courier with anything, and a separate download is the direction that
 * cannot fail (`packages_can_not_download_together` is only the backstop).
 */
export function gruposDeDownload(
  pacotes: readonly ObservacaoPacoteEtiqueta[],
): readonly (readonly string[])[] {
  const grupos: string[][] = [];
  const porCanal = new Map<number, string[]>();
  for (const p of pacotes) {
    if (p.canalId === null) {
      grupos.push([p.numero]);
      continue;
    }
    const grupo = porCanal.get(p.canalId);
    if (grupo) {
      grupo.push(p.numero);
    } else {
      const novo = [p.numero];
      porCanal.set(p.canalId, novo);
      grupos.push(novo);
    }
  }
  return grupos;
}

/* ------------------------------- the decision ------------------------------- */

function recusa(motivo: MotivoEtiquetaShopee): AcaoEtiqueta {
  return { tipo: 'recusa', motivo };
}

function numeros(ps: readonly ObservacaoPacoteEtiqueta[]): readonly string[] {
  return ps.map((p) => p.numero);
}

interface LinhaDeTrabalho {
  readonly numero: string;
  readonly obs: ObservacaoPacoteEtiqueta | null;
  readonly fase: FasePacote;
}

function observada(
  l: LinhaDeTrabalho,
): l is LinhaDeTrabalho & { readonly obs: ObservacaoPacoteEtiqueta } {
  return l.obs !== null;
}

/**
 * The ONE next action — D2 §2 rules 1–12 (minus the removed 1-hour rule),
 * first match wins:
 *
 *  1. the order: FBS ⇒ `pedido-fbs`; `CANCELLED` ⇒ `pedido-cancelado`; no
 *     package ⇒ `sem-pacotes`; a `corpo.pacote` the order does not list ⇒
 *     `pacote-inexistente`.
 *  2. the working set: `corpo.pacote` alone, or every package of the order;
 *     minus `janela-fechada` and `inelegivel` (a package past the window is
 *     excluded from a whole-order print — and its stale `invoice_pending`
 *     never reaches rule 4, R4-5). Empty ⇒ `janela-fechada` when any
 *     package was past the window, else `pacote-inelegivel`.
 *  3. any `desconhecido` — an unknown token, or a listed package Shopee gave
 *     no detail row for ⇒ `status-desconhecido`. Never act on the unknown.
 *  4. any `nfe-pendente` ⇒ `nfe-pendente` (the invoice is the ORDER's).
 *  5. any `nao-pronto` ⇒ `pacote-nao-pronto`; any `retido` ⇒
 *     `retido-pela-shopee`.
 *  6. the first `programar` package: `IN_CANCEL` ⇒ `pedido-em-cancelamento`
 *     (an already-arranged package still prints — R-v); else `programar`,
 *     with `package_number` only on a split order (or when the probe flips
 *     `SHOPEE_SHIP_ORDER_PACOTE` to `'sempre'`).
 *  7. arranged with no usable tracking number ⇒ `buscar-rastreio` — while
 *     `IMPRIMIR_SEM_RASTREIO` is off, a document is never created without one.
 *  8. no document type yet ⇒ `ler-parametros-documento`.
 *  9. document state unknown ⇒ `ler-resultado`.
 * 10. a document that FAILED again after this call re-created it ⇒
 *     `documento-falhou`; else absent or failed once ⇒ `criar-documento`.
 * 11. any still processing ⇒ `aguardar-documento`.
 * 12. all ready: ONE download group sharing ONE document type ⇒ `baixar`;
 *     otherwise ⇒ `por-pacote` (the web re-calls once per package).
 *
 * Rule 10 refuses BEFORE creating: once one package's document has failed
 * twice, this click cannot print the whole working set, so creating a
 * sibling's document first would spend a Shopee call on an answer already
 * known.
 *
 * Rule 12's type check refines D2's "one group": the download takes ONE
 * `shipping_document_type`, so a group whose packages were given different
 * types cannot be merged into one file and is downloaded per package.
 *
 * Three parameters, no clock: the frozen seam's fourth (`nowMs`) lost its only
 * reader with the 1-hour rule and was dropped (review 1, R5-7).
 */
export function decidirProximaAcao(
  o: ObservacaoOrdemEtiqueta,
  ps: readonly ObservacaoPacoteEtiqueta[],
  corpo: { readonly pacote: string | null },
): AcaoEtiqueta {
  // ---- 1. the order ----
  if (o.fbs) return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoFbs);
  if (o.status === SHOPEE_ORDER_STATUS.cancelled) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado);
  }
  const pacotesDaOrdem = [...new Set(o.pacotes)];
  if (pacotesDaOrdem.length === 0) return recusa(MOTIVO_ETIQUETA_SHOPEE.semPacotes);
  if (corpo.pacote !== null && !pacotesDaOrdem.includes(corpo.pacote)) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteInexistente);
  }

  // ---- 2. the working set ----
  const porNumero = new Map(ps.map((p) => [p.numero, p] as const));
  const alvo = corpo.pacote !== null ? [corpo.pacote] : pacotesDaOrdem;
  const linhas: LinhaDeTrabalho[] = alvo.map((numero) => {
    const obs = porNumero.get(numero) ?? null;
    return { numero, obs, fase: obs === null ? 'desconhecido' : fasePacote(obs) };
  });
  const trabalho = linhas.filter((l) => l.fase !== 'janela-fechada' && l.fase !== 'inelegivel');
  if (trabalho.length === 0) {
    return recusa(
      linhas.some((l) => l.fase === 'janela-fechada')
        ? MOTIVO_ETIQUETA_SHOPEE.janelaFechada
        : MOTIVO_ETIQUETA_SHOPEE.pacoteInelegivel,
    );
  }

  // ---- 3–5. the gates ----
  if (trabalho.some((l) => l.fase === 'desconhecido')) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido);
  }
  if (trabalho.some((l) => l.fase === 'nfe-pendente')) return { tipo: 'nfe-pendente' };
  if (trabalho.some((l) => l.fase === 'nao-pronto')) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.pacoteNaoPronto);
  }
  if (trabalho.some((l) => l.fase === 'retido')) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee);
  }

  // ---- 6. arrange, one package per decision ----
  const aProgramar = trabalho.find((l) => l.fase === 'programar');
  if (aProgramar) {
    if (o.status === SHOPEE_ORDER_STATUS.inCancel) {
      return recusa(MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento);
    }
    return {
      tipo: 'programar',
      pacote: aProgramar.numero,
      comPacote: pacotesDaOrdem.length > 1 || SHOPEE_SHIP_ORDER_PACOTE === 'sempre',
    };
  }

  // Every package of the working set is `arranjado` from here on — and
  // observed, since an unobserved one stopped at rule 3.
  const arranjados = trabalho.filter(observada).map((l) => l.obs);

  // ---- 7. the tracking number ----
  if (!IMPRIMIR_SEM_RASTREIO) {
    // The step-7 normaliser, again: a `"-"` that leaked past the builder must
    // never reach `create_shipping_document` as a tracking number.
    const semRastreio = arranjados.filter((p) => textoShopeeUtilizavel(p.rastreio) === null);
    if (semRastreio.length > 0) return { tipo: 'buscar-rastreio', pacotes: numeros(semRastreio) };
  }

  // ---- 8–11. the document ----
  const semTipo = arranjados.filter((p) => p.tipoDocumento === null);
  if (semTipo.length > 0) return { tipo: 'ler-parametros-documento', pacotes: numeros(semTipo) };

  const semResultado = arranjados.filter((p) => p.documento === 'desconhecido');
  if (semResultado.length > 0) return { tipo: 'ler-resultado', pacotes: numeros(semResultado) };

  if (arranjados.some((p) => p.documento === 'falhou' && p.recriadoNestaChamada)) {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.documentoFalhou);
  }
  const aCriar = arranjados.filter(
    (p) => p.documento === 'inexistente' || (p.documento === 'falhou' && !p.recriadoNestaChamada),
  );
  if (aCriar.length > 0) return { tipo: 'criar-documento', pacotes: numeros(aCriar) };

  if (arranjados.some((p) => p.documento === 'processando')) return { tipo: 'aguardar-documento' };

  // ---- 12. every document is ready ----
  const grupos = gruposDeDownload(arranjados);
  const tipos = new Set(arranjados.map((p) => p.tipoDocumento));
  if (grupos.length === 1 && tipos.size === 1) {
    return {
      tipo: 'baixar',
      pacotes: numeros(arranjados),
      tipoDocumento: arranjados[0]?.tipoDocumento ?? null,
    };
  }
  return { tipo: 'por-pacote', pacotes: numeros(arranjados) };
}

/* -------------------------------- the progress ------------------------------- */

/**
 * The counts every 202 carries — and what makes the web's give-up message
 * DETERMINISTIC (R-b): `organizados === total && total > 0` means "already
 * arranged, it will not be arranged again".
 *
 * Counted over exactly the packages it is given, so the caller chooses the
 * population. `organizados` counts `arranjado` AND `janela-fechada` — a package
 * the courier already collected was arranged too; `comRastreio` and `prontos`
 * count only among the organised ones.
 */
export function progressoDe(ps: readonly ObservacaoPacoteEtiqueta[]): {
  total: number;
  organizados: number;
  comRastreio: number;
  prontos: number;
} {
  let organizados = 0;
  let comRastreio = 0;
  let prontos = 0;
  for (const p of ps) {
    const fase = fasePacote(p);
    if (fase !== 'arranjado' && fase !== 'janela-fechada') continue;
    organizados += 1;
    if (textoShopeeUtilizavel(p.rastreio) !== null) comRastreio += 1;
    if (p.documento === 'pronto') prontos += 1;
  }
  return { total: ps.length, organizados, comRastreio, prontos };
}

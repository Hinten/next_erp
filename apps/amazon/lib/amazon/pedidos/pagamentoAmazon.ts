/**
 * The order's PAYMENT → its pagamento (master plan step 6, PR 6): the forma
 * table, the card block, the `valor` rule, the status ladder and the write over
 * a stored snapshot. The pedido decision (`pedidoMapeamento.ts`) calls
 * {@link montarEscritaPagamentoAmazon} on every attempt, and PR 5-d's batch
 * commits what it answers in the SAME batch as the pedido, under the
 * pagamento's own precondition (`escritaPagamento.ts`).
 *
 * PURE: no Firestore, no clock (`nowUs` is a parameter), no environment, no
 * logger. Decided from each attempt's own snapshot (root `CLAUDE.md` rule 7).
 *
 * ## The forma: an EXACT match
 *
 * `CreditCard` ⇒ 3, `Pix` ⇒ 17, `Boleto` ⇒ 15 (that literal is unverified until
 * capture C1). Anything else — another case, a trailing space, `Other`,
 * `Invoice`, `GC`, `Rewards` — ⇒ 99 with `descricaoPagamento` (the NF-e's
 * `xPag`, required beside a tPag 99) naming it; blank, absent, or no execution
 * at all ⇒ 99 "não informada". Either 99 files `forma-pagamento-desconhecida`.
 * On an update only a KNOWN forma overwrites: a 99 never replaces a stored one,
 * so a migrated 99 is upgraded on re-import and never the reverse.
 *
 * ## The card block
 *
 * Built by the shared `cartaoMarketplace` (`@delfrance/schemas`): a block on
 * every 3/4/17, the brand on cards only (never on Pix), the institution's CNPJ
 * validated to 14 characters (refused ⇒ `null` + a count line, never the
 * value). This module adds only the per-SUBFIELD fill-once overlay: a stored
 * non-null subfield is never overwritten (an operator's edit wins), a stored
 * null one is filled. A stored block the card schema would rewrite is left
 * alone. The overlay holds within ONE instrument: when a known forma replaces a
 * DIFFERENT stored one, the stored block (another instrument's brand, CNPJ and
 * authorization) is replaced whole, or dropped for a forma without a block; and
 * a 3/4/17 that keeps its forma under a 99 leg still gets the builder's block.
 *
 * ## `valor` = what the NF-e states (plan §3 decision 43; the FOB answer of 2026-10-21)
 *
 * The NF-e's total (`vNF`) is the lines minus the discount, PLUS the freight
 * only when the pedido's freight modalidade is CIF (`'0'`): the NF-e builder
 * puts `vFrete` in the note for that modalidade alone. So:
 *
 *  - `total da nota` = `derivePedidoFreteTotals` over the pedido's lines and
 *    `descontoTotal`, with the freight member only under CIF;
 *  - `restante` = Σ of the payment executions, minus — under ANY other
 *    modalidade (FOB `'1'` is the conta default) — the freight the buyer paid
 *    Amazon (its SHIPPING net of the shipping discount, read through
 *    `dinheiroAmazon.ts`);
 *  - `restante` equal to the total, in centavos ⇒ `valor` = `restante`, nothing
 *    filed;
 *  - short, or an execution unreadable ⇒ `valor` = the total + `pagamento-divergente`
 *    (a short `valor` would make the Pagamentos tab's reconcile relabel a `pago`
 *    pedido, and the NF-e needs Σ vPag = vNF);
 *  - above ⇒ `valor` = `restante` (never negative) + `pagamento-divergente`;
 *  - a CREATE whose total cannot be read (a stored line the schema refuses) ⇒
 *    no pagamento + `pagamento-divergente`, never an approved pedido without
 *    a signal.
 *
 * Σ vPag therefore equals vNF for every order whose payment matches its lines,
 * under either modalidade, with no NF-e-side rule. `proceeds.grandTotal` is
 * never read (the model's SELLER proceeds; on capture C1 equal to Σ executions).
 *
 * ⚠️ The check proves the TOTAL against the payment, never the split behind
 * it: under FOB it holds for ANY split of a discount between goods and
 * shipping (the freight moves on both sides), and a tax Amazon shows apart can
 * leave the discount and the freight off by amounts that cancel each other out
 * in that comparison. Those two shapes are reported
 * by their own incidentes (`desconto-nao-detalhado`, `imposto-destacado`;
 * `dinheiroAmazon.ts`, PR 5-f), never by `pagamento-divergente`.
 *
 * ## The status: a ladder paired with the pedido estado
 *
 * Two rungs of equal rank, `aprovado` and `estornado`; any other stored status
 * (an operator's `em_disputa`, `recusado`, `devolvido`, …, or an unreadable one)
 * is never walked. The target comes from the pedido's own decision
 * ({@link alvoStatusPagamentoAmazon}), so `statusToEstadoPedido(status)` names
 * the pedido estado on every rung. `estornado` → `aprovado` only on a STRICTLY
 * newer order clock (`ressuscitado`, which clears `dataCancelamento`); the
 * pedido decision never writes `pago` beside a pagamento that stays `estornado`
 * (`pedidoMapeamento.ts`). A pagamento is created only at `aprovado` — never on
 * a PENDING order, never on a reversal.
 *
 * ## A possible reversal never leaves an approved pedido without a pagamento in silence (PR 5-f)
 *
 * A read Amazon approved (`UNSHIPPED`, `PARTIALLY_SHIPPED`, `SHIPPED`) that
 * leaves the pedido `pago` but is a possible reversal (`rev`: a reversal
 * package, an executed line cancellation after shipment, a zeroed `SHIPPED`)
 * keeps what is stored and creates nothing, because its money is the human's
 * to settle. When NO pagamento is stored, that read files `pagamento-divergente`
 * — on every such read, the incidente being created once — so the pedido never
 * sits `pago` with no money record and no signal. The likeliest path is a
 * PENDING-first import (no pagamento), a buyer's line cancellation that blocks
 * the order, an operator's fix of the lines, and a first read after the fix that
 * is already `SHIPPED` while Amazon still shows the cancellation on that line:
 * the execution never leaves the line, so no later read would ever create one.
 * A stored pagamento is kept exactly as before.
 *
 * The OTHER way to `pago` without a pagamento is a D17 block, which writes no
 * pagamento and, since PR 5-f, keeps `pago` while the goods are out or the
 * freight removes stock (a create included). That one files nothing here: the
 * crítico `divergencia-itens` aviso is its signal while it stands, and the
 * first read after the block ends (the lines agreeing, or edited by an
 * operator) creates the pagamento, so an incidente would outlive its cause.
 */
import { coerceToMicros } from '@delfrance/core/datetime';
import { centavosDeReais, roundReais } from '@delfrance/core/money';
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  MODALIDADE_FRETE,
  STATUS_PAGAMENTO,
  cartaoMarketplace,
  cartaoSchema,
  derivePedidoFreteTotals,
  formaPagamentoSchema,
  type Cartao,
  type EstadoPedido,
  type FormaPagamento,
  type ItemDoPedido,
  type StatusPagamento,
} from '@delfrance/schemas';

import {
  EVENTO_PEDIDO_AMAZON,
  INCIDENTE_PEDIDO_AMAZON,
  codigosOrdenados,
  type EventoPedidoAmazon,
  type IncidentePedidoAmazon,
} from './codigosPedidoAmazon';
import { mesmosCentavos, reaisDeMoneyAmazon, somaReais } from './dinheiroAmazon';
import type { PagamentoArmazenadoAmazon } from './estadoPedidoAmazon';

/* -------------------------------------------------------------------------- */
/*                                  the forma                                 */
/* -------------------------------------------------------------------------- */

/** Amazon's `paymentMethod` values this table knows (exact tokens). */
export const METODO_PAGAMENTO_AMAZON = {
  cartaoCredito: 'CreditCard',
  pix: 'Pix',
  boleto: 'Boleto',
} as const satisfies Record<string, string>;

/** The exact-token table (a `Map`: no prototype key can ever match). */
const FORMA_DO_METODO: ReadonlyMap<string, FormaPagamento> = new Map<string, FormaPagamento>([
  [METODO_PAGAMENTO_AMAZON.cartaoCredito, FORMA_PAGAMENTO.cartao_credito],
  [METODO_PAGAMENTO_AMAZON.pix, FORMA_PAGAMENTO.pix],
  [METODO_PAGAMENTO_AMAZON.boleto, FORMA_PAGAMENTO.boleto_bancario],
]);

/** `xPag` when Amazon names no method at all. */
export const DESCRICAO_FORMA_NAO_INFORMADA_AMAZON = 'Amazon: forma de pagamento não informada';

/** `xPag`'s maximum length (XSD 2–60). */
const LIMITE_DESCRICAO_PAGAMENTO = 60;

export interface FormaAmazon {
  readonly forma: FormaPagamento;
  /** `false` ⇒ 99 (`outros`), with {@link FormaAmazon.descricao}. */
  readonly conhecida: boolean;
  /** `descricaoPagamento` — only beside a 99, else `null`. */
  readonly descricao: string | null;
}

/** `paymentMethod` → the forma (module header). Exact bytes; never trimmed or folded. */
export function formaDePagamentoAmazon(metodo: unknown): FormaAmazon {
  const forma = typeof metodo === 'string' ? FORMA_DO_METODO.get(metodo) : undefined;
  if (forma !== undefined) return { forma, conhecida: true, descricao: null };
  const texto = typeof metodo === 'string' && metodo.trim() !== '' ? metodo : null;
  return {
    forma: FORMA_PAGAMENTO.outros,
    conhecida: false,
    descricao:
      texto === null
        ? DESCRICAO_FORMA_NAO_INFORMADA_AMAZON
        : `Amazon: ${texto}`.slice(0, LIMITE_DESCRICAO_PAGAMENTO),
  };
}

/* -------------------------------------------------------------------------- */
/*                               the executions                               */
/* -------------------------------------------------------------------------- */

/** One `payment.paymentExecutions[]` entry, read once. */
export interface ExecucaoPagamentoAmazon {
  /** `paymentMethod`, raw. */
  readonly metodo: unknown;
  /** `paymentAmount` in reais, or `null` (absent, unreadable, not BRL). */
  readonly valor: number | null;
  /** `acquirerId`, raw (the shared builder validates it). */
  readonly adquirente: unknown;
  /** `cardBrand`, raw (the shared builder folds it). */
  readonly marca: unknown;
  /** `authorizationCode`, raw. */
  readonly autorizacao: unknown;
  /**
   * The tie key: EVERY leg field the pagamento reads — `paymentMethod`,
   * `authorizationCode`, the raw amount and its currency, `cardBrand`,
   * `acquirerId` — NUL-joined, raw. Never the array index, so the same legs in
   * another order pick the same leg; two legs with equal keys are equal in
   * everything written, so which of them wins cannot matter.
   */
  readonly chave: string;
}

function textoDaChave(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

/** The order's executions, in Amazon's order (an absent block reads as none). */
export function execucoesPagamentoAmazon(
  order: Pick<PedidoWireAmazon, 'payment'>,
): ExecucaoPagamentoAmazon[] {
  return (order.payment?.paymentExecutions ?? []).map((e) => ({
    metodo: e.paymentMethod,
    valor: reaisDeMoneyAmazon(e.paymentAmount),
    adquirente: e.acquirerId,
    marca: e.cardBrand,
    autorizacao: e.authorizationCode,
    chave: [
      e.paymentMethod,
      e.authorizationCode,
      e.paymentAmount?.amount,
      e.paymentAmount?.currencyCode,
      e.cardBrand,
      e.acquirerId,
    ]
      .map(textoDaChave)
      .join('\u0000'),
  }));
}

/** Σ of the executions in reais: `null` when ANY is unreadable; no execution ⇒ 0. */
export function somaPagamentoAmazon(execucoes: readonly ExecucaoPagamentoAmazon[]): number | null {
  return somaReais(execucoes.map((e) => e.valor));
}

/** Whether `a` is the larger leg (an unreadable amount is the smallest; ties by the key). */
function vemAntes(a: ExecucaoPagamentoAmazon, b: ExecucaoPagamentoAmazon): boolean {
  const va = a.valor === null ? -1 : centavosDeReais(a.valor);
  const vb = b.valor === null ? -1 : centavosDeReais(b.valor);
  if (va !== vb) return va > vb;
  return a.chave < b.chave;
}

/**
 * The leg whose forma and card the pagamento carries (plan §3 decision 28): the
 * LARGEST amount, ties broken by {@link ExecucaoPagamentoAmazon.chave} — never
 * the array index. `null` when there is none.
 */
export function execucaoPrincipalAmazon(
  execucoes: readonly ExecucaoPagamentoAmazon[],
): ExecucaoPagamentoAmazon | null {
  let melhor: ExecucaoPagamentoAmazon | null = null;
  for (const e of execucoes) if (melhor === null || vemAntes(e, melhor)) melhor = e;
  return melhor;
}

/** `authorizationCode` trimmed, 1–128 characters, else `null`. */
export function codigoAutorizacaoAmazon(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const texto = raw.trim();
  return texto.length >= 1 && texto.length <= 128 ? texto : null;
}

/* -------------------------------------------------------------------------- */
/*                                  the valor                                 */
/* -------------------------------------------------------------------------- */

/** The pedido's money as it will stand once this attempt lands. */
export interface TotaisDoPedidoAmazon {
  readonly itens: readonly ItemDoPedido[];
  readonly descontoTotal: number;
  /** `freteInicial.valorCobrado`, or `null`. */
  readonly valorFrete: number | null;
  /** `freteInicial.modalidade`, raw (`null`: no block or no value). */
  readonly modalidade: unknown;
}

/**
 * What the NF-e states as its total (module header): the lines minus the
 * discount, plus the freight only under CIF — the shared derive with the freight
 * member gated exactly as the NF-e builder gates `vFrete`.
 */
export function totalDaNotaAmazon(totais: TotaisDoPedidoAmazon): number {
  const cif = totais.modalidade === MODALIDADE_FRETE.cif;
  return derivePedidoFreteTotals({
    itens: totais.itens,
    descontoTotal: totais.descontoTotal,
    freteInicial: { valorCobrado: cif ? totais.valorFrete : null },
  }).valorCobrado;
}

export interface EntradaValorPagamentoAmazon {
  /** Σ executions ({@link somaPagamentoAmazon}). */
  readonly soma: number | null;
  /** The freight the buyer paid Amazon (SHIPPING − its discount), or `null`. */
  readonly freteDoComprador: number | null;
  readonly totais: TotaisDoPedidoAmazon;
}

export interface ValorPagamentoAmazon {
  /** What the pagamento states (never below the note's total, never negative). */
  readonly valor: number;
  /** The executions do not match the note's total (`pagamento-divergente`). */
  readonly divergente: boolean;
}

/** The `valor` rule (module header). */
export function valorPagamentoAmazon(entrada: EntradaValorPagamentoAmazon): ValorPagamentoAmazon {
  const total = totalDaNotaAmazon(entrada.totais);
  const piso = Math.max(0, total);
  if (entrada.soma === null) return { valor: piso, divergente: true };
  const cif = entrada.totais.modalidade === MODALIDADE_FRETE.cif;
  // Under any modalidade but CIF the note carries no freight, so neither may the payment.
  const restante = cif ? entrada.soma : roundReais(entrada.soma - (entrada.freteDoComprador ?? 0));
  if (mesmosCentavos(restante, total)) return { valor: Math.max(0, restante), divergente: false };
  if (centavosDeReais(restante) < centavosDeReais(total)) return { valor: piso, divergente: true };
  // Above a NEGATIVE total (a discount larger than the lines) the remainder may
  // still be negative: the pagamento schema refuses a negative `valor`.
  return { valor: Math.max(0, restante), divergente: true };
}

/* -------------------------------------------------------------------------- */
/*                                 the status                                 */
/* -------------------------------------------------------------------------- */

/** The two rungs this importer moves (equal rank). */
const ESCADA_STATUS_AMAZON: ReadonlySet<StatusPagamento> = new Set<StatusPagamento>([
  STATUS_PAGAMENTO.aprovado,
  STATUS_PAGAMENTO.estornado,
]);

/** What the pedido decision says the pagamento should be. */
export type AlvoStatusPagamentoAmazon =
  | {
      readonly tipo: 'status';
      readonly status: typeof STATUS_PAGAMENTO.aprovado | typeof STATUS_PAGAMENTO.estornado;
    }
  /** Keep what is stored (and create nothing). */
  | { readonly tipo: 'manter' }
  /**
   * (PR 5-f) Keep what is stored and create nothing, like `manter` — for an
   * order Amazon approved that leaves the pedido `pago` but reads as a possible
   * reversal: with NO pagamento stored, the human is told (`pagamento-divergente`).
   */
  | { readonly tipo: 'manter-reversao' };

const MANTER_STATUS: AlvoStatusPagamentoAmazon = { tipo: 'manter' };
const MANTER_REVERSAO: AlvoStatusPagamentoAmazon = { tipo: 'manter-reversao' };

/**
 * The status target, PAIRED with the pedido estado this attempt leaves:
 *
 * - a cancellation — Amazon's CANCELLED, or a printed pedido a buyer's request
 *   moved through the same predicate — ⇒ `estornado` exactly when the pedido
 *   ends `estornadoIntegralmente` (the predicate chose it because a payment
 *   existed); `cancelado`, or the predicate keeping the estado (goods out, an
 *   operator's estado), keeps the pagamento;
 * - an order Amazon approved (UNSHIPPED, PARTIALLY_SHIPPED, SHIPPED) and not
 *   reversed ⇒ `aprovado` exactly when the pedido ends `pago`: never beside our
 *   own `error`, a terminal estado the import did not reopen, or an estado the
 *   operator owns (the reconcile would relabel some of them);
 * - the same order READ AS REVERSED, the pedido still ending `pago` ⇒
 *   `manter-reversao`: keep, and a missing pagamento is reported, never created
 *   (module header, PR 5-f);
 * - anything else (PENDING, an unknown status, a reversal ending elsewhere) ⇒ keep.
 */
export function alvoStatusPagamentoAmazon(e: {
  readonly cancelamento: boolean;
  readonly aprovadoNaAmazon: boolean;
  readonly revertido: boolean;
  readonly estadoFinal: EstadoPedido | null;
}): AlvoStatusPagamentoAmazon {
  if (e.cancelamento) {
    return e.estadoFinal === ESTADO_PEDIDO.estornadoIntegralmente
      ? { tipo: 'status', status: STATUS_PAGAMENTO.estornado }
      : MANTER_STATUS;
  }
  if (e.aprovadoNaAmazon && e.estadoFinal === ESTADO_PEDIDO.pago) {
    return e.revertido ? MANTER_REVERSAO : { tipo: 'status', status: STATUS_PAGAMENTO.aprovado };
  }
  return MANTER_STATUS;
}

/** Why a status was NOT written. */
export type MotivoStatusPagamentoAmazon =
  | 'manter'
  | 'sem-mudanca'
  /** No pagamento stored, and the target is not one a pagamento is created at. */
  | 'ausente'
  /** The stored status is the operator's (or unreadable): never walked. */
  | 'fora-da-escada'
  /** `estornado` → `aprovado` without a strictly newer clock. */
  | 'terminal';

export type VereditoStatusPagamentoAmazon =
  | { readonly escrever: true; readonly status: StatusPagamento; readonly ressuscitado: boolean }
  | { readonly escrever: false; readonly motivo: MotivoStatusPagamentoAmazon };

/**
 * May the stored status be moved to the target? In order: `manter` (either
 * kind) ⇒ nothing; the same status ⇒ nothing; none stored ⇒ created at
 * `aprovado` only; off the ladder ⇒ never walked; `estornado` → `aprovado` only
 * when the order clock is STRICTLY newer (`ressuscitado`); `aprovado` →
 * `estornado` ⇒ written.
 */
export function statusPagamentoAmazonAplicavel(
  armazenado: PagamentoArmazenadoAmazon,
  alvo: AlvoStatusPagamentoAmazon,
  opcoes: { readonly maisNovo: boolean },
): VereditoStatusPagamentoAmazon {
  if (alvo.tipo !== 'status') return { escrever: false, motivo: 'manter' };
  if (armazenado === alvo.status) return { escrever: false, motivo: 'sem-mudanca' };
  if (armazenado === 'ausente') {
    return alvo.status === STATUS_PAGAMENTO.aprovado
      ? { escrever: true, status: alvo.status, ressuscitado: false }
      : { escrever: false, motivo: 'ausente' };
  }
  if (armazenado === 'ilegivel' || !ESCADA_STATUS_AMAZON.has(armazenado)) {
    return { escrever: false, motivo: 'fora-da-escada' };
  }
  if (armazenado === STATUS_PAGAMENTO.estornado) {
    return opcoes.maisNovo
      ? { escrever: true, status: alvo.status, ressuscitado: true }
      : { escrever: false, motivo: 'terminal' };
  }
  return { escrever: true, status: alvo.status, ressuscitado: false };
}

/* -------------------------------------------------------------------------- */
/*                                  the write                                 */
/* -------------------------------------------------------------------------- */

/**
 * How this attempt may touch `valor` on a STORED pagamento:
 *
 * - `espelhar` — the pedido's money is being mirrored (or this importer never
 *   wrote the pagamento): the derived `valor`, except that a 0 never replaces a
 *   stored positive one;
 * - `preencher` — the money is kept (D17): only a stored `valor` that is not a
 *   positive number is filled;
 * - `manter` — a reversal: `valor` is never touched.
 */
export type ModoValorPagamentoAmazon = 'espelhar' | 'preencher' | 'manter';

export interface EntradaPagamentoAmazon {
  readonly orderId: string;
  /** The ACCEPTED order clock, µs. */
  readonly watermarkUs: number;
  readonly maisNovo: boolean;
  readonly alvo: AlvoStatusPagamentoAmazon;
  /** This read is a cancellation (`dataCancelamento` is stamped beside `estornado`). */
  readonly cancelamento: boolean;
  readonly modoValor: ModoValorPagamentoAmazon;
  readonly execucoes: readonly ExecucaoPagamentoAmazon[];
  /** The derived `valor`, or `null` when the pedido's money cannot be read. */
  readonly valor: ValorPagamentoAmazon | null;
}

/** The pagamento write one attempt decided. */
export type EscritaPagamentoPuraAmazon =
  | { readonly tipo: 'nada' }
  | { readonly tipo: 'criar'; readonly corpo: Readonly<Record<string, unknown>> }
  | {
      readonly tipo: 'atualizar';
      readonly patch: Readonly<Record<string, unknown>>;
      readonly campos: readonly string[];
    };

export interface DecisaoPagamentoAmazon {
  readonly escrita: EscritaPagamentoPuraAmazon;
  /** The status the pagamento holds once this attempt lands (`null`: none, or unreadable). */
  readonly statusFinal: StatusPagamento | null;
  readonly incidentes: readonly IncidentePedidoAmazon[];
  readonly eventos: readonly EventoPedidoAmazon[];
}

const NADA: EscritaPagamentoPuraAmazon = { tipo: 'nada' };

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** A fill-once field holds nothing yet. */
function vazio(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === '';
}

function numeroFinito(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * The stored `cartao`, when the overlay may build on it: a map the card schema
 * reads WITHOUT rewriting any present subfield (its `.catch` would turn an
 * unreadable value into `null`, which is an overwrite). `null` ⇒ no stored block
 * (the whole new one is written); `'ilegivel'` ⇒ left alone.
 */
function cartaoArmazenado(raw: unknown): Cartao | null | 'ilegivel' {
  if (raw === null || raw === undefined) return null;
  const mapa = objeto(raw);
  if (mapa === null) return 'ilegivel';
  const lido = cartaoSchema.safeParse(mapa);
  if (!lido.success) return 'ilegivel';
  for (const [chave, valor] of Object.entries(mapa)) {
    if ((lido.data as Record<string, unknown>)[chave] !== valor) return 'ilegivel';
  }
  return lido.data;
}

/** The per-subfield overlay: stored non-null kept, stored null filled. `null` ⇒ nothing to fill. */
function cartaoSobreposto(guardado: Cartao, novo: Cartao): Cartao | null {
  const saida: Record<string, unknown> = { ...guardado };
  let preencheu = false;
  for (const [chave, valor] of Object.entries(novo)) {
    if (valor !== null && (guardado as Record<string, unknown>)[chave] === null) {
      saida[chave] = valor;
      preencheu = true;
    }
  }
  return preencheu ? (saida as Cartao) : null;
}

/**
 * The pagamento write of one attempt (module header), from THAT attempt's raw
 * pagamento snapshot (`null` = absent) and what the pedido decision allows.
 * `entrada === null` ⇒ the pedido decision forbids any pagamento write (a D17
 * divergence): nothing, and nothing filed.
 */
export function montarEscritaPagamentoAmazon(
  armazenadoRaw: Readonly<Record<string, unknown>> | null,
  armazenadoStatus: PagamentoArmazenadoAmazon,
  entrada: EntradaPagamentoAmazon | null,
  opcoes: { readonly nowUs: number },
): DecisaoPagamentoAmazon {
  const statusGuardado =
    armazenadoStatus === 'ausente' || armazenadoStatus === 'ilegivel' ? null : armazenadoStatus;
  if (entrada === null) {
    return { escrita: NADA, statusFinal: statusGuardado, incidentes: [], eventos: [] };
  }
  const veredito = statusPagamentoAmazonAplicavel(armazenadoStatus, entrada.alvo, {
    maisNovo: entrada.maisNovo,
  });
  // A create needs the note's total; while the stored lines cannot state it, no
  // pagamento is created, and the human is told (below) rather than left with an
  // approved pedido and no pagamento at all.
  const semTotal = armazenadoRaw === null && veredito.escrever && entrada.valor === null;
  const statusFinal = veredito.escrever && !semTotal ? veredito.status : statusGuardado;
  const vivo =
    entrada.alvo.tipo === 'status' &&
    entrada.alvo.status === STATUS_PAGAMENTO.aprovado &&
    statusFinal === STATUS_PAGAMENTO.aprovado;

  const incidentes: IncidentePedidoAmazon[] = [];
  const eventos: EventoPedidoAmazon[] = [];
  if (veredito.escrever && veredito.ressuscitado) {
    eventos.push(EVENTO_PEDIDO_AMAZON.pagamentoRessuscitado);
  }

  // The forma and the card, read from the largest leg (only for a live order).
  const principal = execucaoPrincipalAmazon(entrada.execucoes);
  const forma = formaDePagamentoAmazon(principal?.metodo);
  const cartao = cartaoMarketplace({
    forma: forma.forma,
    marcaBruta: principal?.marca,
    cnpjBruto: principal?.adquirente,
    cAut: codigoAutorizacaoAmazon(principal?.autorizacao),
  });
  if (vivo) {
    if (entrada.execucoes.length > 1) incidentes.push(INCIDENTE_PEDIDO_AMAZON.pagamentoDividido);
    if (cartao.cnpjRecusado) eventos.push(EVENTO_PEDIDO_AMAZON.cnpjInstituicaoRecusado);
    if (cartao.bandeiraDesconhecida) eventos.push(EVENTO_PEDIDO_AMAZON.bandeiraDesconhecida);
    if (entrada.valor?.divergente === true) {
      incidentes.push(INCIDENTE_PEDIDO_AMAZON.pagamentoDivergente);
    }
  }
  const fechar = (escrita: EscritaPagamentoPuraAmazon): DecisaoPagamentoAmazon => ({
    escrita,
    statusFinal,
    incidentes: codigosOrdenados(incidentes),
    eventos: codigosOrdenados(eventos),
  });

  /* --------------------------------- CREATE -------------------------------- */
  if (armazenadoRaw === null) {
    // Two reasons an approved pedido gets no pagamento here, both reported:
    // the total cannot be stated, or the read is a possible reversal (PR 5-f).
    if (semTotal || entrada.alvo.tipo === 'manter-reversao') {
      incidentes.push(INCIDENTE_PEDIDO_AMAZON.pagamentoDivergente);
    }
    if (!veredito.escrever || entrada.valor === null) return fechar(NADA);
    if (!forma.conhecida) incidentes.push(INCIDENTE_PEDIDO_AMAZON.formaPagamentoDesconhecida);
    return fechar({
      tipo: 'criar',
      corpo: {
        id: entrada.orderId,
        metodoPagamentoOuterRef: null,
        forma_de_pagamento: forma.forma,
        status_pagamento: veredito.status,
        cartao: cartao.cartao ?? null,
        cheque: null,
        descricaoPagamento: forma.descricao,
        valor: entrada.valor.valor,
        parcelas: 1,
        juros: null,
        tarifas: null,
        aVista: true,
        duplicata: false,
        nFat: null,
        vencimento: null,
        ultimaModificacao: opcoes.nowUs,
        lastProviderUpdate: entrada.watermarkUs,
        dataCancelamento: null,
        dataAprovacao: entrada.watermarkUs,
        dataCadastro: entrada.watermarkUs,
      },
    });
  }

  /* --------------------------------- UPDATE -------------------------------- */
  const raw = armazenadoRaw;
  const patch: Record<string, unknown> = {};
  if (veredito.escrever) patch.status_pagamento = veredito.status;

  if (vivo) {
    // The forma: only a KNOWN one overwrites; a 99 fills an unreadable stored one only.
    const formaLida = formaPagamentoSchema.safeParse(raw.forma_de_pagamento);
    const formaGuardada = formaLida.success ? formaLida.data : null;
    let formaFinal: FormaPagamento | null = formaGuardada;
    if (forma.conhecida ? formaGuardada !== forma.forma : formaGuardada === null) {
      patch.forma_de_pagamento = forma.forma;
      formaFinal = forma.forma;
    }
    if (!forma.conhecida && formaFinal === FORMA_PAGAMENTO.outros) {
      incidentes.push(INCIDENTE_PEDIDO_AMAZON.formaPagamentoDesconhecida);
      if (raw.descricaoPagamento !== forma.descricao) patch.descricaoPagamento = forma.descricao;
    }
    // The card, for the forma the pagamento ENDS with. From this leg when it
    // decided that forma; else (a 99 leg beside a stored card forma) the shared
    // builder's block with no Amazon field, so a 3/4/17 never lacks one.
    const outroInstrumento = formaGuardada !== null && formaFinal !== formaGuardada;
    const cartaoFinal =
      formaFinal === null
        ? undefined
        : formaFinal === forma.forma
          ? cartao.cartao
          : cartaoMarketplace({
              forma: formaFinal,
              marcaBruta: undefined,
              cnpjBruto: undefined,
              cAut: null,
            }).cartao;
    if (outroInstrumento) {
      // A known forma replaced a DIFFERENT stored one: the stored block belongs
      // to the other instrument, so it is replaced whole (or dropped, for a forma
      // with no block). The per-subfield overlay (operator-edit-wins) holds
      // within ONE instrument only.
      const novo = cartaoFinal ?? null;
      if (!(novo === null && (raw.cartao === null || raw.cartao === undefined))) {
        patch.cartao = novo;
      }
    } else if (cartaoFinal !== undefined) {
      const guardado = cartaoArmazenado(raw.cartao);
      if (guardado === null) {
        patch.cartao = cartaoFinal;
      } else if (guardado !== 'ilegivel') {
        const sobreposto = cartaoSobreposto(guardado, cartaoFinal);
        if (sobreposto !== null) patch.cartao = sobreposto;
      }
    }
  }

  // The valor (D17's keep-stored rule, per mode).
  const valorGuardado = numeroFinito(raw.valor);
  if (vivo && entrada.valor !== null && entrada.modoValor !== 'manter') {
    const novo = entrada.valor.valor;
    const positivoGuardado = valorGuardado !== null && valorGuardado > 0;
    const pode =
      entrada.modoValor === 'espelhar' ? !(novo === 0 && positivoGuardado) : !positivoGuardado;
    if (pode && !mesmosCentavos(valorGuardado, novo)) patch.valor = novo;
  }

  // The fill-once stamps: an approval stamp beside a live `aprovado` only, a
  // cancellation stamp beside the `estornado` a cancellation decided only.
  if (vivo && vazio(raw.id)) patch.id = entrada.orderId;
  if (vivo && vazio(raw.dataAprovacao)) patch.dataAprovacao = entrada.watermarkUs;
  if (
    entrada.cancelamento &&
    statusFinal === STATUS_PAGAMENTO.estornado &&
    vazio(raw.dataCancelamento)
  ) {
    patch.dataCancelamento = entrada.watermarkUs;
  }
  // A resurrection leaves no cancellation stamp beside `aprovado`: the field is
  // fill-once, so a stale one would also stand in for a LATER cancellation's.
  if (veredito.escrever && veredito.ressuscitado && !vazio(raw.dataCancelamento)) {
    patch.dataCancelamento = null;
  }

  const campos = Object.keys(patch);
  if (campos.length === 0) return fechar(NADA);
  patch.lastProviderUpdate = entrada.watermarkUs;
  // Monotonic and never null (a legacy stamp may be ms or ISO: the STORED side only).
  const ultimaGuardada = coerceToMicros(raw.ultimaModificacao);
  patch.ultimaModificacao =
    ultimaGuardada === null || opcoes.nowUs > ultimaGuardada ? opcoes.nowUs : ultimaGuardada;
  return fechar({ tipo: 'atualizar', patch, campos });
}

/**
 * One Shopee order → the `pedidos/{id}/pagamentos` doc SET, split into the
 * FIELD GROUPS `pagamentoTx.ts` applies separately (#1514, step 6, plan
 * W1–W9).
 *
 * **PURE — no Firestore, no wire call, no clock.** The clock (`nowUs`), the
 * order watermark (`watermarkUs`), the escrow payload and the pedido's OWN
 * `valorCobrado` all arrive as parameters, which is what lets the transaction
 * re-apply the result verbatim on an OCC retry and lets a byte-identical
 * redelivery come out as an EMPTY patch.
 *
 * ## The three money invariants this module exists to hold
 *
 *  1. **`valor` is the BUYER-facing figure and Σ pagante `valor` equals the
 *     pedido's `valorCobrado` to the centavo.** Never `escrow_amount`: on a
 *     marketplace `canalDevolveTroco` is false, so an excess is a hard SEFAZ
 *     cStat 866 and a shortfall an 865 — the NF-e simply does not emit.
 *     `totais.test.ts` crosses this module against `sumPagamentosPagos` and
 *     against `derivePedidoFreteTotals`, because neither side can see the
 *     defect alone.
 *  2. **`tarifas` is the marketplace's cut, clamped at 0** (`pagamentoSchema`
 *     declares `.min(0)`; an unclamped negative is a `ZodError` that PARKS the
 *     code-3 delivery terminally — `disposicaoDaFalhaDeImportacao` in
 *     `notificacoes/notificacao.ts` has an explicit `ZodError` arm precisely so
 *     it does NOT retry for ever the way it does one channel over — and, on the
 *     weekly settlement sweep, is not in `erroContidoPorConta` at all, so it
 *     aborts the whole tick rather than one conta — #794). Its pre-clamp value
 *     and the raw named fee columns ride `pagamento.marketplace`, a DIARY
 *     nothing gates on.
 *  3. **`undefined` means "we did not learn it" and the patch builder OMITS the
 *     key; `null` means "there is none" and is written.** A later delivery may
 *     carry FEWER `payment_info` entries (whether the block survives past
 *     `READY_TO_SHIP` is settle-live register item 22 and is NOT yet known) and
 *     an escrow read can fail on its own, so a `cartao: null` or a
 *     `tarifas: null` written from a degraded delivery would ERASE what an
 *     earlier, richer one already learned — and for `cartao` that destroys the
 *     block PIX needs (cStat 391) on a pedido still awaiting emission.
 *
 * ## ⚠️ The status ladder is driven by the ORDER status, never by a payment event
 *
 * Shopee ships no payment push of any kind — there is no `payment` topic, no
 * `pay_status` field and no settlement callback. Everything this module knows
 * about a payment's lifecycle it reads off `order_status`, which is why
 * {@link statusPagamentoDeOrderStatus} is a `switch` with an explicit `default`
 * and why the monotonicity rule ({@link statusPagamentoAplicavel}) is a
 * SEPARATE function taking the STORED value: the transaction re-derives the
 * verdict from its own `tx.get` snapshot, never from a decision taken outside
 * the callback (root `CLAUDE.md` rule 7).
 */
import { roundReais } from '@delfrance/core/money';
import {
  BANDEIRA,
  FORMA_PAGAMENTO,
  MARKETPLACE_PEDIDO_TIPO,
  STATUS_PAGAMENTO,
  cpfCnpjUtilizavel,
  valorUtilizavel,
  type Bandeira,
  type Cartao,
  type FormaPagamento,
  type MarketplacePagamento,
  type MarketplacePagamentoTaxas,
  type StatusPagamento,
} from '@delfrance/schemas';
import type {
  ShopeeEscrowDetail,
  ShopeeOrderDetailRow,
  ShopeePaymentInfo,
  ShopeeTenureInfo,
} from '@delfrance/integrations-shopee';

import { makePagamentoIdShopee, sufixoPagamentoShopee } from './orderIds';
import {
  REGIAO_BR_PEDIDO,
  microsDeSegundosShopee,
  positivoOuNull,
  segundosShopeeUtilizaveis,
} from './orderMapping';
import { SHOPEE_ORDER_STATUS } from './orderStatusMaps';

/* -------------------------------------------------------------------------- */
/*                          the once-per-process log memo                       */
/* -------------------------------------------------------------------------- */

/**
 * Raw values already reported once by the folds below.
 *
 * The three folds each answer a total function over an OPEN vocabulary — Shopee
 * publishes no closed list for `payment_method`, `card_brand` or
 * `instalment_plan` — so the honest instrument is "tell me each new string you
 * could not map, ONCE". Unmemoised it is one line per order, which on a backfill
 * is thousands of identical lines and the finding is lost in them.
 */
const JA_REPORTADO = new Set<string>();

/** Log `raw` once per process, under `escopo`. Returns whether it logged. */
function reportarUmaVez(escopo: string, raw: string, linha: () => void): boolean {
  const chave = `${escopo}\u0000${raw}`;
  if (JA_REPORTADO.has(chave)) return false;
  JA_REPORTADO.add(chave);
  linha();
  return true;
}

/**
 * Forget every memoised log line.
 *
 * ⚠️ Exists for the SUITES, and the reason is a real hazard rather than
 * tidiness: the memo is module state, so a test asserting "exactly one
 * `console.info` for this raw" would silently assert ZERO whenever an earlier
 * test in the same file had already used the same string. `beforeEach` calls
 * this so each test starts from the same place.
 */
export function esquecerLogsDePagamentoShopee(): void {
  JA_REPORTADO.clear();
}

/* -------------------------------------------------------------------------- */
/*                         tarifas — the two compositions                      */
/* -------------------------------------------------------------------------- */

/** Which fee composition {@link tarifasDeShopee} runs. */
export type ComposicaoTarifasShopee = 'taxas-nomeadas' | 'spread-escrow';

/** Named members of {@link ComposicaoTarifasShopee}. */
export const COMPOSICAO_TARIFAS = {
  taxasNomeadas: 'taxas-nomeadas',
  spreadEscrow: 'spread-escrow',
} as const satisfies Record<string, ComposicaoTarifasShopee>;

/**
 * The composition this channel actually charges (Lucas, 2026-09-10): Shopee's
 * own three fee COLUMNS.
 *
 * ⚠️ ONE literal decides which of the two arms runs, and it survives as a NAMED
 * SEAM — the `SHOPEE_ESCROW_DETAIL_TRANSPORT` precedent. Both arms are
 * implemented and both are tested, because the question "is the marketplace's
 * cut the named fees, or the spread between what the buyer paid and what the
 * escrow releases?" is answerable from real BR data and from nothing else: the
 * SG sandbox order answers **1.29 under either**, so that body cannot tell them
 * apart and a single-arm implementation would have quietly decided it.
 *
 * ⚠️ `tarifas` and `tarifasBrutas` are NOT the two readings — they are the
 * shipped composition's clamped and pre-clamp values, i.e. one composition
 * twice. The per-import log therefore carries a THIRD number, `tarifasSpread`
 * (this function called with {@link COMPOSICAO_TARIFAS.spreadEscrow}), and that
 * is the one the first real BR orders settle the question with. It is also
 * re-derivable per document from the stored diary
 * (`marketplace.buyerTotalAmount − marketplace.escrowAmountAfterAdjustment`
 * against `marketplace.tarifasBrutas`).
 */
export const COMPOSICAO_TARIFAS_SHOPEE: ComposicaoTarifasShopee = COMPOSICAO_TARIFAS.taxasNomeadas;

/** What {@link tarifasDeShopee} answers. */
export interface TarifasShopee {
  /** The clamped figure `pagamento.tarifas` takes. `undefined` ⇒ omit the key. */
  readonly tarifas: number | undefined;
  /** The PRE-CLAMP value, for `marketplace.tarifasBrutas`. */
  readonly bruto: number | undefined;
  /** The RAW named columns, for `marketplace.taxas`. No arithmetic. */
  readonly taxas: MarketplacePagamentoTaxas | undefined;
}

/**
 * The marketplace's cut for one order, both compositions.
 *
 * **(a) `taxas-nomeadas`** (the default) — FAQ 479's three Income-Report
 * columns: `commission_fee + service_fee + seller_transaction_fee`, each with
 * its BR "net" variant preferred when Shopee sends one (announcement 1451).
 *
 * ⚠️ `?? 0` and deliberately NOT `positivoOuNull`: on this wire `0` is the
 * zero-fill for an absent numeric *in general*, but a fee of exactly zero is a
 * REAL fee — a promotion that waived the commission is not a missing commission
 * — and treating it as absence would make `tarifas` read `undefined` and skip
 * the write on precisely the orders where the seller kept the most.
 *
 * ⚠️ **`credit_card_transaction_fee` is NEVER summed here.** Shopee's own page
 * defines it as `buyer_transaction_fee + seller_transaction_fee` — a ROLLUP of
 * a column that is already in the sum — so adding it double-counts the seller
 * leg and invents the buyer's. The SG sandbox body cannot catch that swap
 * (`buyer_transaction_fee` is 0 there, so the rollup and the column are the SAME
 * 0.64), which is why `pagamentoMapping.test.ts` carries a synthetic vector
 * where they differ.
 *
 * **(b) `spread-escrow`** — `buyer_total_amount − (escrow_amount_after_adjustment
 * ?? escrow_amount)`: what the buyer paid minus what Shopee releases. This is
 * the legacy importer's rule, minus its `abs()`.
 *
 * Both arms: `tarifas = max(0, roundReais(bruto))`. ⚠️ **The clamp is
 * mandatory**, not defensive — `pagamentoSchema.tarifas` is `.min(0)`, and
 * `final_shipping_fee` is legitimately negative on Shopee's own sample
 * (`-10`), so the spread really can come out below zero. Unclamped that is a
 * `ZodError` inside the transaction, and on BOTH writers it is terminal rather
 * than transient (#794): on the code-3 task
 * `disposicaoDaFalhaDeImportacao` (`notificacoes/notificacao.ts`) has an
 * explicit `ZodError` arm that PARKS the delivery — no retry at all, which is
 * the whole point of that arm, since one channel over the same error DOES retry
 * for ever — and on the weekly settlement sweep `erroContidoPorConta` does not
 * name `ZodError`, so it is rethrown past the per-conta boundary and the whole
 * tick dies with every remaining conta unswept. The unclamped number is not
 * lost: it rides `marketplace.tarifasBrutas`, where a negative means "Shopee
 * credited the seller" and stays visible as data.
 *
 * ⚠️ **`order_income` absent ⇒ every field `undefined`, never `null`.** The
 * patch builder omits an `undefined` key, so an escrow read that failed can
 * never erase a fee an earlier delivery already learned.
 */
export function tarifasDeShopee(
  escrow: ShopeeEscrowDetail | null,
  composicao: ComposicaoTarifasShopee = COMPOSICAO_TARIFAS_SHOPEE,
): TarifasShopee {
  const oi = escrow?.order_income ?? null;
  if (oi == null) return { tarifas: undefined, bruto: undefined, taxas: undefined };

  const taxas: MarketplacePagamentoTaxas = {
    comissao: oi.net_commission_fee ?? oi.commission_fee ?? null,
    servico: oi.net_service_fee ?? oi.service_fee ?? null,
    transacaoVendedor: oi.seller_transaction_fee ?? null,
    campanha: oi.campaign_fee ?? null,
    protecaoFrete: oi.shipping_seller_protection_fee_amount ?? null,
    processamento: oi.seller_order_processing_fee ?? null,
    ajustes: oi.total_adjustment_amount ?? null,
    devolucoes: oi.seller_return_refund ?? null,
  };

  let bruto: number | undefined;
  if (composicao === COMPOSICAO_TARIFAS.spreadEscrow) {
    const pago = oi.buyer_total_amount;
    const liberado = oi.escrow_amount_after_adjustment ?? oi.escrow_amount;
    bruto = pago == null || liberado == null ? undefined : roundReais(pago - liberado);
  } else {
    const comissao = oi.net_commission_fee ?? oi.commission_fee ?? 0;
    const servico = oi.net_service_fee ?? oi.service_fee ?? 0;
    const transacao = oi.seller_transaction_fee ?? 0;
    bruto = roundReais(comissao + servico + transacao);
  }

  return { tarifas: bruto === undefined ? undefined : Math.max(0, bruto), bruto, taxas };
}

/** The escrow-derived half of `pagamento.marketplace`. */
export interface DiarioMarketplaceShopee {
  readonly buyerTotalAmount: number | null;
  readonly escrowAmount: number | null;
  readonly escrowAmountAfterAdjustment: number | null;
  readonly tarifasBrutas: number | null;
  readonly taxas: MarketplacePagamentoTaxas | null;
}

/**
 * The escrow-derived keys of `pagamento.marketplace`, shared with the WEEKLY
 * SETTLEMENT SWEEP so both writers produce the same diary from one
 * implementation.
 *
 * ⚠️ It is the sharing that makes the two writers safe to converge: the sweep
 * re-reads a FRESHER escrow (`escrow_amount` is documented to move until the
 * order completes) and rebuilds this block, and the freshest read wins. That
 * only holds while there is exactly ONE derivation — a second copy would let
 * the two disagree about the same order and each overwrite the other's answer
 * on every tick.
 *
 * ⚠️ `undefined` when there is no `order_income` to diary, for
 * {@link tarifasDeShopee}'s reason: the caller then omits the whole
 * `marketplace` key rather than writing a map of nulls over numbers an earlier
 * delivery learned. `tipo`, `orderSn` and `atualizadoEm` are the CALLER's — they
 * are not escrow-derived and dating a diary nobody wrote would be a lie about
 * when the escrow was last read.
 */
export function diarioMarketplaceDeEscrow(
  escrow: ShopeeEscrowDetail | null,
  composicao: ComposicaoTarifasShopee = COMPOSICAO_TARIFAS_SHOPEE,
): DiarioMarketplaceShopee | undefined {
  const oi = escrow?.order_income ?? null;
  if (oi == null) return undefined;
  const { bruto, taxas } = tarifasDeShopee(escrow, composicao);
  return {
    buyerTotalAmount: oi.buyer_total_amount ?? null,
    escrowAmount: oi.escrow_amount ?? null,
    escrowAmountAfterAdjustment: oi.escrow_amount_after_adjustment ?? null,
    tarifasBrutas: bruto ?? null,
    taxas: taxas ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*                       forma_de_pagamento — the fold                         */
/* -------------------------------------------------------------------------- */

/** Why {@link formaPagamentoDeShopee} answered what it answered. */
export type MotivoFormaShopee =
  | 'pix'
  | 'boleto'
  | 'credito'
  | 'debito'
  | 'carteira'
  | 'desconhecida'
  /** Nothing usable arrived — a non-string, `''` or whitespace. */
  | 'ausente';

/** Named members of {@link MotivoFormaShopee}. */
export const MOTIVO_FORMA_SHOPEE = {
  pix: 'pix',
  boleto: 'boleto',
  credito: 'credito',
  debito: 'debito',
  carteira: 'carteira',
  desconhecida: 'desconhecida',
  ausente: 'ausente',
} as const satisfies Record<string, MotivoFormaShopee>;

/** What {@link formaPagamentoDeShopee} answers. */
export interface FormaShopee {
  readonly forma: FormaPagamento;
  readonly motivo: MotivoFormaShopee;
  /** The trimmed raw, for `descricaoPagamento` and for the register. `null` when absent. */
  readonly bruto: string | null;
}

/** `"apple pay"`, `"google pay"`, `"samsung pay"` — the wallets that need two tokens. */
const CARTEIRAS_COM_PAY: readonly string[] = ['apple', 'google', 'samsung'];

/**
 * Shopee's free-form payment-method string → `FORMA_PAGAMENTO`.
 *
 * There is no closed vocabulary to match against: guide 31's BR block lists only
 * `Ebanx *` entries, while the sandbox and the announcements show `"Pix"`,
 * `"Apple Pay"`, `"Credit Card/Debit Card"`, `"credit_card"` and
 * `"Combined Payment"`. So the fold normalises and then matches TOKENS in a
 * fixed order.
 *
 * ## What the fold treats as EQUAL, and where it STOPS
 *
 * Equal: case (`Pix` ≡ `PIX` ≡ `pix`), separators (`credit_card` ≡
 * `Credit Card` ≡ `Credit-Card`), and accents — `Cartão de Crédito` ≡
 * `cartao de credito`, because the string is `NFD`-normalised and its combining
 * marks stripped. ⚠️ That last one is not cosmetic: the legacy's Boleto arm was
 * a literal `'Boleto BancÃ¡rio'` — mojibake — so it never matched anything, and
 * a fold that strips diacritics cannot have that bug.
 *
 * NOT equal, and this is the half a "does it fold?" test cannot show: the match
 * is on TOKENS, never on substrings, so **`"Pixel"` is not `pix`** and
 * `"Combined Payment"` is not a wallet (`payment` ≠ `pay`). The order of the
 * rules is load-bearing too: `credit` is tested before `debit` so
 * `"Credit Card/Debit Card"` — one string carrying both words, which is what
 * Shopee sends for a card leg — answers `cartao_credito`, and before the wallet
 * rule so `"Ebanx Credit Card"` is a card rather than a wallet.
 * `pagamentoMapping.test.ts` pins both halves: pairs that must fold together and
 * near-misses that must stay apart.
 *
 * ⚠️ An unmapped value answers `outros` (99) and the RAW string reaches
 * `descricaoPagamento`, which is the ONE field that becomes the NF-e's `xPag` —
 * and only for forma 99. Each distinct unmapped raw is logged ONCE per process
 * (register item 23): that log is how the BR vocabulary gets discovered, and it
 * carries the method name only, never a buyer field.
 *
 * ⚠️ A blank string answers `ausente` with `bruto: null`, NOT `desconhecida`
 * with `bruto: ''`. `descricaoPagamento` would otherwise be the literal
 * `"Shopee: "`, which is what SEFAZ would receive as the payment description.
 */
export function formaPagamentoDeShopee(raw: unknown): FormaShopee {
  if (typeof raw !== 'string') {
    return { forma: FORMA_PAGAMENTO.outros, motivo: MOTIVO_FORMA_SHOPEE.ausente, bruto: null };
  }
  const bruto = raw.trim();
  if (bruto.length === 0) {
    return { forma: FORMA_PAGAMENTO.outros, motivo: MOTIVO_FORMA_SHOPEE.ausente, bruto: null };
  }

  const base = bruto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const tokens = new Set(base.split(/[^a-z0-9]+/).filter((t) => t.length > 0));

  if (tokens.has('pix')) {
    return { forma: FORMA_PAGAMENTO.pix, motivo: MOTIVO_FORMA_SHOPEE.pix, bruto };
  }
  if (tokens.has('boleto')) {
    return { forma: FORMA_PAGAMENTO.boleto_bancario, motivo: MOTIVO_FORMA_SHOPEE.boleto, bruto };
  }
  if (tokens.has('credit') || tokens.has('credito')) {
    return { forma: FORMA_PAGAMENTO.cartao_credito, motivo: MOTIVO_FORMA_SHOPEE.credito, bruto };
  }
  if (tokens.has('debit') || tokens.has('debito')) {
    return { forma: FORMA_PAGAMENTO.cartao_debito, motivo: MOTIVO_FORMA_SHOPEE.debito, bruto };
  }
  const carteira =
    tokens.has('shopeepay') ||
    tokens.has('wallet') ||
    tokens.has('carteira') ||
    (tokens.has('pay') && CARTEIRAS_COM_PAY.some((marca) => tokens.has(marca))) ||
    (tokens.has('bank') && tokens.has('transfer'));
  if (carteira) {
    return {
      forma: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
      motivo: MOTIVO_FORMA_SHOPEE.carteira,
      bruto,
    };
  }

  reportarUmaVez('forma', bruto, () => {
    // eslint-disable-next-line no-console -- once per distinct unmapped value; the register's only instrument (item 23)
    console.info('[shopee/pedidos] forma de pagamento não mapeada — gravada como "outros" (99)', {
      metodo: bruto,
    });
  });
  return { forma: FORMA_PAGAMENTO.outros, motivo: MOTIVO_FORMA_SHOPEE.desconhecida, bruto };
}

/* -------------------------------------------------------------------------- */
/*                         cartão — bandeira and CNPJ                          */
/* -------------------------------------------------------------------------- */

/** What {@link bandeiraDeCardBrand} answers. */
export interface BandeiraShopee {
  readonly bandeira: Bandeira | null;
  readonly desconhecida: boolean;
  readonly bruto: string | null;
}

/**
 * The two brand spellings Shopee sends that are not enum member names.
 *
 * ⚠️ They are ALIASES, not renames: `BANDEIRA` keys on the legacy enum member
 * names (`mastercard`, `american_express`), and Mercado Livre's own
 * `bandeiraFromNome` demonstrably falls through to `outros` on ML's `"master"`
 * for exactly this reason. Shopee's BR vocabulary is not yet known (register
 * item 23), so this table grows from logged evidence, never from a guess.
 */
const APELIDOS_BANDEIRA: Readonly<Record<string, Bandeira>> = {
  master: BANDEIRA.mastercard,
  amex: BANDEIRA.american_express,
};

/**
 * `payment_info[].card_brand` → the NF-e `tBand` catalogue code.
 *
 * Enum-member-name lookup (`"visa"` → `'01'`), plus the two documented aliases.
 *
 * ⚠️ **`''` answers `null`, not `outros`.** The SG body proves Shopee fills the
 * key with an empty string on a non-card leg, and a Pix payment with
 * `bandeira: '99'` would tell the NF-e the buyer used an unlisted CARD brand.
 * `null` is what `buildCardFromCartao` already handles.
 *
 * ⚠️ The lookup is `hasOwnProperty`-gated, not a bare index. `BANDEIRA` is a
 * plain object, so a raw of `"constructor"` or `"toString"` would otherwise
 * return a FUNCTION, which `cartaoSchema.bandeira`'s `.catch(null)` would
 * silently swallow into `null` — an unknown brand reported as "no brand".
 */
export function bandeiraDeCardBrand(raw: unknown): BandeiraShopee {
  if (typeof raw !== 'string') return { bandeira: null, desconhecida: false, bruto: null };
  const bruto = raw.trim();
  if (bruto.length === 0) return { bandeira: null, desconhecida: false, bruto: null };

  const chave = bruto.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BANDEIRA, chave)) {
    return {
      bandeira: BANDEIRA[chave as keyof typeof BANDEIRA],
      desconhecida: false,
      bruto,
    };
  }
  if (Object.prototype.hasOwnProperty.call(APELIDOS_BANDEIRA, chave)) {
    return { bandeira: APELIDOS_BANDEIRA[chave]!, desconhecida: false, bruto };
  }

  reportarUmaVez('bandeira', bruto, () => {
    // eslint-disable-next-line no-console -- once per distinct unknown brand; a brand name, never a card number
    console.info('[shopee/pedidos] bandeira de cartão desconhecida — gravada como "outros" (99)', {
      bandeira: bruto,
    });
  });
  return { bandeira: BANDEIRA.outros, desconhecida: true, bruto };
}

/** The digit count of a CNPJ. A CPF is 11 and must NOT reach `cnpj_instituicao`. */
const DIGITOS_CNPJ = 14;

/**
 * `payment_info[].payment_processor_register` → `cartao.cnpj_instituicao`.
 *
 * `cpfCnpjUtilizavel` in one call, which is the mask gate on the RAW value, then
 * `normalizeDocumento`, then the length test, then `validateCpfCnpj` — and then
 * narrowed here to FOURTEEN characters.
 *
 * ⚠️ The narrowing is not redundant. `cpfCnpjUtilizavel` accepts 11 *or* 14, and
 * a CPF in this field would be written as the payment institution's CNPJ and
 * emitted to SEFAZ as one; the NF-e generator stamps `cnpj_instituicao` into the
 * `<card><CNPJ>` element without re-checking its length.
 *
 * ⚠️ A masked value (`***.***.333/0001-**`) answers `null` and is written
 * NOWHERE — not to the document and not to a log line. The whole field is a
 * CNPJ and sits on the fixture redaction denylist.
 *
 * TODO(IN RFB 2.229/2024): the alphanumeric CNPJ. `normalizeDocumento` already
 * keeps letters and `validateCpfCnpj` already computes the check digits over
 * them, so this reader needs no change — but nothing has yet sent one, so
 * "works" here is an argument, not an observation.
 */
export function cnpjDoProcessador(raw: unknown): string | null {
  const documento = cpfCnpjUtilizavel(raw);
  return documento != null && documento.length === DIGITOS_CNPJ ? documento : null;
}

/* -------------------------------------------------------------------------- */
/*                                  parcelas                                    */
/* -------------------------------------------------------------------------- */

/** What {@link parcelasDeShopee} answers. */
export interface ParcelasShopee {
  readonly parcelas: number;
  /** A raw arrived and carried no readable number. */
  readonly ilegivel: boolean;
  readonly bruto: string | null;
}

/** `pagamentoSchema.parcelas` is `.int().min(1)`; 99 is the NF-e's own ceiling. */
const MAX_PARCELAS = 99;

/** `"N/A"` — Shopee's sentinel for "no instalment plan", case-insensitively. */
const SENTINELA_SEM_PARCELAMENTO = 'n/a';

/** `tenure_info_list` arrives as an ARRAY in reality and as an OBJECT on the page. */
function tenuresComoLista(
  bruto: ShopeeTenureInfo | readonly ShopeeTenureInfo[] | null | undefined,
): readonly ShopeeTenureInfo[] {
  if (bruto == null) return [];
  return Array.isArray(bruto) ? bruto : [bruto as ShopeeTenureInfo];
}

/** Clamp a numeric instalment count into `pagamentoSchema`'s own range. */
function parcelasNoIntervalo(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PARCELAS, Math.max(1, Math.trunc(n)));
}

/**
 * `order_income.instalment_plan` (or the single `tenure_info_list` entry) →
 * `pagamento.parcelas`.
 *
 * ⚠️ **`"N/A"` is a SENTINEL, not a number.** The legacy did
 * `int.parse(raw.replaceAll(nonDigits, ''))`, which on `"N/A"` parses the empty
 * string and THROWS — on every order, because `"N/A"` is what the SG body
 * actually sends. That is why the sentinel is tested before the digit scan and
 * why the digit scan cannot throw.
 *
 * The source is tri-shaped by Shopee's own doing: `instalment_plan` is a STRING
 * on the escrow page and an INT in announcement 1080, and `tenure_info_list` is
 * documented as an object while the live body sends an array. The package
 * records all three verbatim; this is the ONE place they fold.
 *
 * ⚠️ The `tenure_info_list` rung is used only when EXACTLY ONE entry carries an
 * `instalment_plan`. Two entries mean two tenure options were offered and the
 * list does not say which one the buyer took — answering with the first would
 * be a guess stamped onto a fiscal document.
 */
export function parcelasDeShopee(escrow: ShopeeEscrowDetail | null): ParcelasShopee {
  const oi = escrow?.order_income ?? null;
  let fonte: string | number | null = oi?.instalment_plan ?? null;
  if (fonte == null) {
    const comPlano = tenuresComoLista(oi?.tenure_info_list).filter(
      (t) => t.instalment_plan != null,
    );
    fonte = comPlano.length === 1 ? (comPlano[0]!.instalment_plan ?? null) : null;
  }

  if (fonte == null) return { parcelas: 1, ilegivel: false, bruto: null };
  if (typeof fonte === 'number') {
    return { parcelas: parcelasNoIntervalo(fonte), ilegivel: false, bruto: String(fonte) };
  }

  const bruto = fonte.trim();
  if (bruto.length === 0) return { parcelas: 1, ilegivel: false, bruto: null };
  if (bruto.toLowerCase() === SENTINELA_SEM_PARCELAMENTO) {
    return { parcelas: 1, ilegivel: false, bruto };
  }

  const digitos = /(\d{1,2})/.exec(bruto);
  if (digitos == null) {
    reportarUmaVez('parcelas', bruto, () => {
      // eslint-disable-next-line no-console -- once per distinct unparsable plan; register item 24
      console.info('[shopee/pedidos] instalment_plan ilegível — gravado como 1 parcela', {
        instalmentPlan: bruto,
      });
    });
    return { parcelas: 1, ilegivel: true, bruto };
  }
  return { parcelas: parcelasNoIntervalo(Number(digitos[1])), ilegivel: false, bruto };
}

/* -------------------------------------------------------------------------- */
/*                            the status ladder                                */
/* -------------------------------------------------------------------------- */

/** What Shopee's ORDER status says the payment status should be. */
export type AlvoStatusPagamentoShopee =
  | { readonly tipo: 'status'; readonly status: StatusPagamento }
  /** Nothing to say — keep whatever is stored. */
  | { readonly tipo: 'manter' };

/** Named members of {@link AlvoStatusPagamentoShopee}'s discriminator. */
export const ALVO_STATUS_PAGAMENTO_SHOPEE = {
  status: 'status',
  manter: 'manter',
} as const satisfies Record<string, AlvoStatusPagamentoShopee['tipo']>;

/**
 * `order_status` → the payment status this importer wants the pagamento to
 * hold.
 *
 * `PENDING → em_processo_aprovacao` (3) · the five shipping statuses and
 * `COMPLETED → aprovado` (4) · `IN_CANCEL` / `TO_RETURN → em_disputa` (5) ·
 * `CANCELLED → estornado` (8) · everything else, `UNPAID` included, `manter`.
 *
 * ⚠️ **`em_disputa` STILL COUNTS AS PAID** (`isPagamentoPagante`'s own
 * docblock): a mediation is a HOLD, not a reversal, and the money has not moved.
 * Dropping a disputed leg out of Σ pagante would break the NF-e's centavo
 * identity on exactly the orders a human is already dealing with.
 *
 * ⚠️ **`UNPAID` answers `manter`, not `pendente`.** An unpaid order produces no
 * pagamento at all (there is no `pay_time`), so the only way this case is
 * reached is a STALE `UNPAID` re-read arriving after a paid one — and writing
 * `pendente` over an `aprovado` would take the leg out of Σ pagante and out of
 * the nota. The monotonicity rule below would refuse it anyway; answering
 * `manter` means the refusal never has to fire.
 *
 * ⚠️ `CANCELLED → estornado` rather than `cancelado`: `statusToEstadoPedido`
 * maps `estornado` to `estornadoIntegralmente` and `cancelado` to `cancelado`,
 * and neither is pagante — but `estornado` is the one that says the money came
 * back, which is what a cancelled *paid* Shopee order is. A cancellation before
 * payment never reaches here.
 */
export function statusPagamentoDeOrderStatus(orderStatus: string): AlvoStatusPagamentoShopee {
  switch (orderStatus) {
    case SHOPEE_ORDER_STATUS.pending:
      return {
        tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status,
        status: STATUS_PAGAMENTO.em_processo_aprovacao,
      };
    case SHOPEE_ORDER_STATUS.readyToShip:
    case SHOPEE_ORDER_STATUS.processed:
    case SHOPEE_ORDER_STATUS.retryShip:
    case SHOPEE_ORDER_STATUS.shipped:
    case SHOPEE_ORDER_STATUS.toConfirmReceive:
    case SHOPEE_ORDER_STATUS.completed:
      return { tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status, status: STATUS_PAGAMENTO.aprovado };
    case SHOPEE_ORDER_STATUS.inCancel:
    case SHOPEE_ORDER_STATUS.toReturn:
      return { tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status, status: STATUS_PAGAMENTO.em_disputa };
    case SHOPEE_ORDER_STATUS.cancelled:
      return { tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.status, status: STATUS_PAGAMENTO.estornado };
    default:
      return { tipo: ALVO_STATUS_PAGAMENTO_SHOPEE.manter };
  }
}

/** Why a payment status was NOT written. */
export type MotivoStatusPagamentoShopee =
  /** The ladder declined to decide (`UNPAID`, an unknown status). */
  | 'manter'
  /** The stored status already IS the target. */
  | 'sem-mudanca'
  /** Backwards on the ordered ladder (a late `PENDING` over an `aprovado`). */
  | 'regressivo'
  /** The stored status belongs to the business, not to Shopee. */
  | 'fora-da-escada';

/** Named members of {@link MotivoStatusPagamentoShopee}. */
export const MOTIVO_STATUS_PAGAMENTO_SHOPEE = {
  manter: 'manter',
  semMudanca: 'sem-mudanca',
  regressivo: 'regressivo',
  foraDaEscada: 'fora-da-escada',
} as const satisfies Record<string, MotivoStatusPagamentoShopee>;

export type VereditoStatusPagamentoShopee =
  | {
      readonly escrever: true;
      readonly status: StatusPagamento;
      /** A terminal status was left (`estornado → aprovado`). Logged loudly. */
      readonly ressuscitado: boolean;
    }
  | { readonly escrever: false; readonly motivo: MotivoStatusPagamentoShopee };

/**
 * The four statuses this importer is allowed to move AWAY from, with their RANK.
 *
 * ⚠️ **A rank, not a list**, because the ladder is not a line: `em_processo_aprovacao`
 * is strictly before everything else, while `aprovado`, `em_disputa` and
 * `estornado` are all "the money arrived and then something happened to it" and
 * are freely reachable from one another — a dispute opens and closes, a paid
 * order is cancelled, a cancellation is reversed. Modelling them as an ORDER
 * would forbid `aprovado → em_disputa` or `em_disputa → aprovado`, and every
 * mediation would freeze the leg at whichever one it happened to reach first.
 *
 * Anything stored that is NOT here — an operator's `recusado`, `devolvido`,
 * `pago_parcialmente`, `em_revisao`, `cancelado`, `pendente` — belongs to the
 * business, and a marketplace re-fetch must never walk it back.
 */
const RANK_STATUS_PAGAMENTO_SHOPEE: ReadonlyMap<StatusPagamento, number> = new Map<
  StatusPagamento,
  number
>([
  [STATUS_PAGAMENTO.em_processo_aprovacao, 0],
  [STATUS_PAGAMENTO.aprovado, 1],
  [STATUS_PAGAMENTO.em_disputa, 1],
  [STATUS_PAGAMENTO.estornado, 1],
]);

/**
 * The terminal payment statuses on this channel — ENUMERATED, never derived.
 *
 * Terminal does not mean absorbing: leaving one is allowed and merely worth a
 * log line. See clause 4 of {@link statusPagamentoAplicavel}.
 */
const STATUS_PAGAMENTO_SHOPEE_TERMINAL: ReadonlySet<StatusPagamento> = new Set<StatusPagamento>([
  STATUS_PAGAMENTO.estornado,
]);

/**
 * May the STORED payment status be moved to what Shopee now says?
 *
 * Four clauses, in this order:
 *
 * 1. **Target `manter` ⇒ write nothing.**
 * 2. **Already there ⇒ write nothing** (`sem-mudanca`) — which is what makes a
 *    byte-identical redelivery produce an EMPTY patch rather than a
 *    `historicoDeModificacoes` row.
 * 3. **Stored `null` ⇒ any target writes.** A legacy pagamento may carry no
 *    status at all, and `isPagamentoPagante` reads `null` as PAGANTE — so the
 *    first Shopee delivery must be able to say what it really is.
 * 4. **Off the ladder ⇒ write nothing** (`fora-da-escada`); on it, forward only
 *    by RANK. ⚠️ `aprovado → em_processo_aprovacao` is the near-miss this
 *    function exists for: a late-delivered `PENDING` must never un-approve a
 *    shipped order's payment and drop it out of Σ pagante — the NF-e would then
 *    be short by exactly that leg, which on a marketplace is cStat 865 and no
 *    emission at all. `estornado → em_processo_aprovacao` is refused for the
 *    same reason. **`estornado → aprovado` IS allowed**, and flagged
 *    `ressuscitado` so the log says so: the ladder is driven by a RE-FETCH of
 *    the live order, so `READY_TO_SHIP` on a leg we hold as reversed means the
 *    reversal was ours and wrong. Making it absorbing would strand a live sale
 *    with an unsellable nota, permanently.
 */
export function statusPagamentoAplicavel(
  armazenado: StatusPagamento | null,
  alvo: AlvoStatusPagamentoShopee,
): VereditoStatusPagamentoShopee {
  if (alvo.tipo === ALVO_STATUS_PAGAMENTO_SHOPEE.manter) {
    return { escrever: false, motivo: MOTIVO_STATUS_PAGAMENTO_SHOPEE.manter };
  }
  const destino = alvo.status;
  if (armazenado === destino) {
    return { escrever: false, motivo: MOTIVO_STATUS_PAGAMENTO_SHOPEE.semMudanca };
  }
  if (armazenado == null) {
    return { escrever: true, status: destino, ressuscitado: false };
  }
  const de = RANK_STATUS_PAGAMENTO_SHOPEE.get(armazenado);
  if (de === undefined) {
    return { escrever: false, motivo: MOTIVO_STATUS_PAGAMENTO_SHOPEE.foraDaEscada };
  }
  const para = RANK_STATUS_PAGAMENTO_SHOPEE.get(destino);
  if (para !== undefined && para < de) {
    return { escrever: false, motivo: MOTIVO_STATUS_PAGAMENTO_SHOPEE.regressivo };
  }
  return {
    escrever: true,
    status: destino,
    ressuscitado:
      STATUS_PAGAMENTO_SHOPEE_TERMINAL.has(armazenado) &&
      !STATUS_PAGAMENTO_SHOPEE_TERMINAL.has(destino),
  };
}

/* -------------------------------------------------------------------------- */
/*                               the doc SET                                   */
/* -------------------------------------------------------------------------- */

/**
 * The most `payment_info` legs one order may fan out into.
 *
 * ⚠️ **This bound is what makes "which stored docs are OURS" a PURE function of
 * `(contaId, orderSn)`.** The transaction recomputes
 * `makePagamentoIdShopee(contaId, orderSn, sufixoPagamentoShopee(i))` for every
 * `i` up to this number and owns exactly those; without a bound it would have to
 * read the `id` FIELD back, which rides the operator's form through a `...base`
 * spread and is therefore reachable by a human edit. Announcement 1265's own
 * combined-payment sample is 2.
 */
export const MAX_PAGAMENTOS_COMBINADOS_SHOPEE = 8;

/** Why a combined payment collapsed back to ONE document. */
export type MotivoColapsoShopee = 'soma-divergente' | 'excede-maximo';

/** Named members of {@link MotivoColapsoShopee}. */
export const MOTIVO_COLAPSO_SHOPEE = {
  somaDivergente: 'soma-divergente',
  excedeMaximo: 'excede-maximo',
} as const satisfies Record<string, MotivoColapsoShopee>;

/** The statuses at which Shopee documents `payment_info` as provided (announcement 1240). */
const STATUS_COM_PAYMENT_INFO: ReadonlySet<string> = new Set<string>([
  SHOPEE_ORDER_STATUS.readyToShip,
  SHOPEE_ORDER_STATUS.processed,
  SHOPEE_ORDER_STATUS.retryShip,
  SHOPEE_ORDER_STATUS.shipped,
  SHOPEE_ORDER_STATUS.toConfirmReceive,
  SHOPEE_ORDER_STATUS.completed,
]);

/** The three formas that may carry a `cartao` block. */
const FORMAS_COM_CARTAO: ReadonlySet<FormaPagamento> = new Set<FormaPagamento>([
  FORMA_PAGAMENTO.cartao_credito,
  FORMA_PAGAMENTO.cartao_debito,
  FORMA_PAGAMENTO.pix,
]);

export interface MapearPagamentosShopeeArgs {
  readonly linha: ShopeeOrderDetailRow;
  /** `null` when the escrow call failed or the order is unpaid. */
  readonly escrow: ShopeeEscrowDetail | null;
  /**
   * `mapeado.dados.valorCobrado` — the PEDIDO's own figure
   * (`valorCobradoDoPedido`). ⚠️ NEVER recomputed here, and never
   * `escrow_amount`: the two documents have to agree to the centavo or the NF-e
   * refuses to emit.
   */
  readonly valorCobrado: number | null;
  /** The ORDER clock of this delivery, µs. */
  readonly watermarkUs: number;
  /** The importer's single clock read, µs. */
  readonly nowUs: number;
  readonly contaId: string;
  readonly orderSn: string;
  /** Test seam only — production uses {@link COMPOSICAO_TARIFAS_SHOPEE}. */
  readonly composicaoTarifas?: ComposicaoTarifasShopee;
}

/** ONE mapped pagamento, in the groups the transaction applies separately. */
export interface PagamentoMapeadoShopee {
  readonly docId: string;
  readonly indice: number;
  readonly sufixo: string | undefined;
  /** ALWAYS — the marketplace's lifecycle and its own money. */
  readonly sempre: {
    readonly alvoStatus: AlvoStatusPagamentoShopee;
    /** ⚠️ `undefined` ⇒ the patch OMITS the key. Never written as `null`. */
    readonly tarifas: number | undefined;
    /** ⚠️ `undefined` ⇒ the patch OMITS the key. */
    readonly marketplace: MarketplacePagamento | undefined;
  };
  /** DATA — frozen while the pedido is `congelado` or the delivery is degraded. */
  readonly dados: {
    readonly valor: number;
    readonly forma_de_pagamento: FormaPagamento;
    readonly parcelas: number;
    readonly aVista: boolean;
    /** ⚠️ `undefined` ⇒ OMIT. A `null` here would erase the block PIX needs. */
    readonly cartao: Cartao | undefined;
    /** Only for forma 99 — it is the NF-e's `xPag`, and only forma 99 emits one. */
    readonly descricaoPagamento: string | null;
  };
  readonly preencherUmaVez: { readonly id: string; readonly dataCadastro: number };
  readonly datas: { readonly dataAprovacao: number | undefined };
}

/** Counts, booleans and enum tokens — NEVER a value. What the import log prints. */
export interface DiagnosticoPagamentoShopee {
  readonly orderSn: string;
  readonly payTimeUsavel: boolean;
  /** How many `payment_info` entries carried a usable `payment_amount`. */
  readonly entradasPaymentInfo: number;
  readonly combinado: boolean;
  readonly motivoColapso: MotivoColapsoShopee | null;
  readonly somaPaymentInfo: number | null;
  readonly deltaDaSoma: number | null;
  /** The PRIMARY document's fold verdict. */
  readonly formaMotivo: MotivoFormaShopee;
  readonly parcelasIlegivel: boolean;
  readonly bandeiraDesconhecida: boolean;
  readonly cnpjProcessadorRecusado: boolean;
  readonly escrowAusente: boolean;
  readonly composicaoTarifas: ComposicaoTarifasShopee;
  readonly tarifasBrutas: number | null;
}

export interface PagamentosMapeadosShopee {
  readonly docs: readonly PagamentoMapeadoShopee[];
  readonly diagnosticos: DiagnosticoPagamentoShopee;
}

/**
 * The content key one combined leg sorts by.
 *
 * ⚠️ Shopee documents no ordering for `payment_info`, so the WIRE order cannot
 * decide which leg is the primary: the same order re-read could hand the
 * `order_sn` `id` to a different leg and move money between two documents that
 * both already exist. The key is therefore built from the leg's own CONTENT.
 *
 * ⚠️ The separator is NUL (`\u0000`) — a byte no payment method, authorization
 * code or formatted amount can contain — for the reason `chaveDaLinhaShopee`
 * gives one collection up: joined without one, `("ab","c")` and `("a","bc")`
 * produce the same key, and two different legs would sort as ONE.
 *
 * ⚠️ The comparison is a plain code-unit `<` / `>`, deliberately NOT
 * `localeCompare`: collation is locale- and ICU-dependent, so two machines could
 * order the same pair differently — and it IGNORES control characters outright,
 * which would throw away the very separator this key depends on.
 */
const SEPARADOR_CHAVE_DE_ORDEM = '\u0000';

function chaveDeOrdem(entrada: ShopeePaymentInfo): string {
  return [
    (entrada.payment_method ?? '').trim().toLowerCase(),
    entrada.transaction_id ?? '',
    // ⚠️ `roundReais` + `String`, never `.toFixed(2)`: this is money, and
    // `delfrance/no-ad-hoc-money-rounding` bans the ad-hoc formatter outright.
    // The key needs DETERMINISM, not a fixed width — it is a tiebreak after the
    // method and the authorization code, never a numeric ordering.
    String(roundReais(positivoOuNull(entrada.payment_amount) ?? 0)),
  ].join(SEPARADOR_CHAVE_DE_ORDEM);
}

function compararChaves(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The first argument that is a non-blank string, or `null`. */
function primeiroNaoVazio(...valores: readonly unknown[]): string | null {
  for (const valor of valores) {
    if (typeof valor === 'string' && valor.trim().length > 0) return valor;
  }
  return null;
}

/** What {@link cartaoDaEntrada} answers. */
interface CartaoDaEntrada {
  readonly cartao: Cartao | undefined;
  readonly bandeiraDesconhecida: boolean;
  /** A register ARRIVED and was refused (masked, a CPF, bad check digits). */
  readonly cnpjRecusado: boolean;
}

/** The `cartao` block for one leg, or `undefined` when nothing supplies it. */
function cartaoDaEntrada(
  forma: FormaPagamento,
  entrada: ShopeePaymentInfo | undefined,
): CartaoDaEntrada {
  if (!FORMAS_COM_CARTAO.has(forma) || entrada === undefined) {
    return { cartao: undefined, bandeiraDesconhecida: false, cnpjRecusado: false };
  }
  const bandeira = bandeiraDeCardBrand(entrada.card_brand);
  const registroBruto = entrada.payment_processor_register;
  const cnpj = cnpjDoProcessador(registroBruto);
  return {
    cartao: {
      tpIntegra: '2',
      bandeira: bandeira.bandeira,
      numeroCartao: null,
      cAut: valorUtilizavel(entrada.transaction_id),
      cnpj_instituicao: cnpj,
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
    },
    bandeiraDesconhecida: bandeira.desconhecida,
    // ⚠️ "refused", not "absent". A register that never arrived is nothing to
    // report; one that arrived MASKED or as a CPF is the finding — and neither
    // the value nor its length ever reaches the diagnostic or a log line.
    cnpjRecusado: typeof registroBruto === 'string' && registroBruto.trim() !== '' && cnpj === null,
  };
}

/**
 * Map one `get_order_detail` row (+ its escrow) into the pagamento doc SET.
 *
 * ## The creation gate
 *
 * `segundosShopeeUtilizaveis(pay_time) === null` ⇒ **no documents at all**.
 * That covers `UNPAID`, `PENDING` before the payment lands, and Shopee's
 * `pay_time: 0` zero-fill — which a `!= null` test would read as a 1970 date and
 * create a paid pagamento for an unpaid order.
 *
 * ⚠️ **The gate governs CREATION only.** The transaction still applies the
 * status ladder and the fill-once dates to documents of ours that ALREADY exist,
 * so a `CANCELLED` re-read whose `pay_time` came back `0` still moves a stored
 * `aprovado` to `estornado`. This function reports that through
 * `diagnosticos.payTimeUsavel`; it does not decide it.
 *
 * ## The N-docs rule
 *
 * A BR combined payment (announcement 1265) fans out to one document per
 * `payment_info` leg — but ONLY when the legs add up to the pedido's own
 * `valorCobrado` to the centavo, and only up to
 * {@link MAX_PAGAMENTOS_COMBINADOS_SHOPEE}. Anything else collapses to ONE
 * primary carrying the whole `valorCobrado`, with the reason in
 * `motivoColapso` and one `console.warn`. The asymmetry is deliberate: N
 * documents whose sum is wrong is a nota that cannot be emitted, while one
 * document with the right total is merely less detailed.
 */
export function mapearPagamentosShopee(args: MapearPagamentosShopeeArgs): PagamentosMapeadosShopee {
  const { linha, escrow, valorCobrado, watermarkUs, nowUs, contaId, orderSn } = args;
  const composicao = args.composicaoTarifas ?? COMPOSICAO_TARIFAS_SHOPEE;

  const payTimeS = segundosShopeeUtilizaveis(linha.pay_time);
  const alvoStatus = statusPagamentoDeOrderStatus(linha.order_status);
  const fold = tarifasDeShopee(escrow, composicao);
  const diario = diarioMarketplaceDeEscrow(escrow, composicao);
  const marketplace: MarketplacePagamento | undefined =
    diario === undefined
      ? undefined
      : {
          tipo: MARKETPLACE_PEDIDO_TIPO.shopee,
          orderSn,
          ...diario,
          // ⚠️ The ORDER clock, never `nowUs`. This single choice is what makes
          // a byte-identical replay produce an EMPTY patch instead of a write —
          // and `onPagamentoChanged` ignores only `id` and `ultimaModificacao`,
          // so any other re-stamped field is a history row per redelivery.
          atualizadoEm: watermarkUs,
        };
  const parcelasFold = parcelasDeShopee(escrow);

  const entradas = [...(linha.payment_info ?? [])]
    .filter((e) => positivoOuNull(e.payment_amount) !== null)
    .sort((a, b) => compararChaves(chaveDeOrdem(a), chaveDeOrdem(b)));

  const diagnosticoBase = {
    orderSn,
    payTimeUsavel: payTimeS !== null,
    entradasPaymentInfo: entradas.length,
    escrowAusente: escrow?.order_income == null,
    composicaoTarifas: composicao,
    tarifasBrutas: fold.bruto ?? null,
    parcelasIlegivel: parcelasFold.ilegivel,
  } as const;

  if (payTimeS === null) {
    return {
      docs: [],
      diagnosticos: {
        ...diagnosticoBase,
        combinado: false,
        motivoColapso: null,
        somaPaymentInfo: null,
        deltaDaSoma: null,
        formaMotivo: MOTIVO_FORMA_SHOPEE.ausente,
        bandeiraDesconhecida: false,
        cnpjProcessadorRecusado: false,
      },
    };
  }

  if (
    entradas.length === 0 &&
    linha.region === REGIAO_BR_PEDIDO &&
    STATUS_COM_PAYMENT_INFO.has(linha.order_status)
  ) {
    // ⚠️ `orderSn` and nothing else. `payment_processor_register` is a CNPJ and
    // `transaction_id` is an authorization code; neither ever reaches a log.
    console.warn('[shopee/pedidos] pedido BR sem payment_info utilizável — cartão não preenchido', {
      orderSn,
      orderStatus: linha.order_status,
    });
  }

  /* — how many documents, and why ------------------------------------------ */
  let combinado = false;
  let motivoColapso: MotivoColapsoShopee | null = null;
  let somaPaymentInfo: number | null = null;
  let deltaDaSoma: number | null = null;

  if (entradas.length >= 2) {
    somaPaymentInfo = roundReais(
      entradas.reduce((s, e) => s + (positivoOuNull(e.payment_amount) ?? 0), 0),
    );
    const alvoSoma = valorCobrado == null ? null : roundReais(valorCobrado);
    deltaDaSoma = alvoSoma == null ? null : roundReais(somaPaymentInfo - alvoSoma);
    if (entradas.length > MAX_PAGAMENTOS_COMBINADOS_SHOPEE) {
      motivoColapso = MOTIVO_COLAPSO_SHOPEE.excedeMaximo;
    } else if (alvoSoma == null || somaPaymentInfo !== alvoSoma) {
      motivoColapso = MOTIVO_COLAPSO_SHOPEE.somaDivergente;
    } else {
      combinado = true;
    }
    if (motivoColapso !== null) {
      console.warn('[shopee/pedidos] pagamento combinado recusado — gravado como um único doc', {
        orderSn,
        motivo: motivoColapso,
        entradas: entradas.length,
        soma: somaPaymentInfo,
        valorCobrado: alvoSoma,
        delta: deltaDaSoma,
      });
    }
  }

  /* — the legs ------------------------------------------------------------- */
  const legs: readonly {
    readonly entrada: ShopeePaymentInfo | undefined;
    readonly valor: number;
  }[] = combinado
    ? entradas.map((entrada) => ({
        entrada,
        valor: roundReais(positivoOuNull(entrada.payment_amount) ?? 0),
      }))
    : [{ entrada: entradas[0], valor: roundReais(valorCobrado ?? 0) }];

  // ⚠️ `primeiroNaoVazio`, never `??`: Shopee zero-fills an absent STRING with
  // `''` exactly as it zero-fills an absent number with `0`, so `a ?? b` never
  // reaches the escrow's own `buyer_payment_method` on a row whose
  // `payment_method` came back empty — and the order would read as forma 99 with
  // a `descricaoPagamento` of nothing. Same argument as `positivoOuNull`'s.
  const brutoDaOrdem = primeiroNaoVazio(
    linha.payment_method,
    escrow?.order_income?.buyer_payment_method,
  );
  const formas = legs.map((leg) =>
    combinado
      ? formaPagamentoDeShopee(leg.entrada?.payment_method)
      : formaPagamentoDeShopee(brutoDaOrdem),
  );

  // The instalment plan describes ONE credit-card leg. In a combined set it may
  // only be attributed when exactly one leg IS a credit card; otherwise every
  // leg takes 1, because splitting an instalment count across legs invents a
  // figure and giving it to the wrong leg misstates a fiscal document.
  const indicesDeCredito = formas.reduce<number[]>((acc, f, i) => {
    if (f.forma === FORMA_PAGAMENTO.cartao_credito) acc.push(i);
    return acc;
  }, []);
  const indiceDoParcelamento = combinado
    ? indicesDeCredito.length === 1
      ? indicesDeCredito[0]!
      : null
    : 0;
  if (combinado && indiceDoParcelamento === null && parcelasFold.parcelas > 1) {
    // eslint-disable-next-line no-console -- a real instalment count was dropped; counts only, no value
    console.info('[shopee/pedidos] parcelamento não atribuído — nenhum leg de crédito único', {
      orderSn,
      legs: legs.length,
      legsDeCredito: indicesDeCredito.length,
      parcelas: parcelasFold.parcelas,
    });
  }

  let bandeiraDesconhecida = false;
  let cnpjProcessadorRecusado = false;

  const docs = legs.map((leg, i): PagamentoMapeadoShopee => {
    const forma = formas[i]!;
    const cartaoDoLeg = cartaoDaEntrada(forma.forma, leg.entrada);
    if (cartaoDoLeg.bandeiraDesconhecida) bandeiraDesconhecida = true;
    if (cartaoDoLeg.cnpjRecusado) cnpjProcessadorRecusado = true;
    const parcelas = i === indiceDoParcelamento ? parcelasFold.parcelas : 1;
    const sufixo = sufixoPagamentoShopee(i);
    return {
      docId: makePagamentoIdShopee(contaId, orderSn, sufixo),
      indice: i,
      sufixo,
      sempre: {
        alvoStatus,
        // The fee is the ORDER's, not the leg's: Shopee bills the order once.
        // It rides the primary and the siblings carry a real, asserted 0 — the
        // alternative is N copies of one charge in Σ tarifas.
        tarifas: i === 0 ? fold.tarifas : 0,
        marketplace: i === 0 ? marketplace : undefined,
      },
      dados: {
        valor: leg.valor,
        forma_de_pagamento: forma.forma,
        parcelas,
        aVista: parcelas === 1,
        cartao: cartaoDoLeg.cartao,
        descricaoPagamento:
          forma.forma === FORMA_PAGAMENTO.outros && forma.bruto !== null
            ? `Shopee: ${forma.bruto}`
            : null,
      },
      preencherUmaVez: {
        id: i === 0 ? orderSn : `${orderSn}-${i}`,
        dataCadastro: nowUs,
      },
      datas: { dataAprovacao: microsDeSegundosShopee(payTimeS) },
    };
  });

  return {
    docs,
    diagnosticos: {
      ...diagnosticoBase,
      combinado,
      motivoColapso,
      somaPaymentInfo,
      deltaDaSoma,
      formaMotivo: formas[0]!.motivo,
      bandeiraDesconhecida,
      cnpjProcessadorRecusado,
    },
  };
}

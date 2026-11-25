import { z } from 'zod';
import { centavosDeReais } from '@delfrance/core/money';
import { parseWireDecimal } from '@delfrance/core/wire';
import {
  precoDaTabela,
  precoDoFilhoNaTabela,
  propagaPrecoAosFilhos,
} from './produto/pureLogic/precoCalculo';
import { idDocumentoEstoqueLiSchema } from './sincEstoqueLojaIntegrada';

/**
 * The ONE price function of the Loja Integrada price sync (master plan step 13, PR 13-a), shared
 * with the publish (step 11): which produto is a root, what a tabela entry says, the price a
 * linked child must show in the store, how a store price value reads, whether a send would
 * lower what the buyer pays, and (PR 13-b) how a send spells the promotion's CLEAR on the wire
 * and when a store promotion reads as that clear having landed
 * ({@link formaPromoLimpaLiSchema}, {@link promocionalLimpoNaFormaLi}). The twin of
 * `estoqueErpLojaIntegrada.ts`, and here for the same
 * reason: the send run, the trigger, the daily reconcile and a `tools/migrations` read-only audit
 * need the identical answer, and an app cannot be imported by the others. One copy of each rule
 * (root `CLAUDE.md`, #1369).
 *
 * Built ONLY from the shared pieces: `precoDaTabela`, `propagaPrecoAosFilhos` and
 * `precoDoFilhoNaTabela` (`produto/pureLogic/precoCalculo.ts`, the readers and the child rule
 * every other channel's price sender binds), `centavosDeReais` (`@delfrance/core/money`, which
 * applies `roundReais`), `parseWireDecimal` (`@delfrance/core/wire`) and the ERP document-id
 * grammar `idDocumentoEstoqueLiSchema` (`sincEstoqueLojaIntegrada.ts`). No second rounding, no
 * second decimal grammar, no second id check.
 *
 * ## Money is INTEGER CENTAVOS here
 *
 * Every price this module hands out or compares is an integer number of centavos, converted ONCE
 * through `centavosDeReais` (which applies `roundReais` first). So two values are the same price
 * exactly when their centavos are equal — the same verdict `mesmoPrecoEmReais` gives on the
 * rounded reais — and a `< 0.01` tolerance, which would equate `49.991` with `50`, can never
 * creep in.
 *
 * ## No custo anywhere
 *
 * The ERP custo is never sent to the store (the owner's answer to the master plan's §7 q1,
 * 2026-10-27, re-confirmed 2026-11-23): a price send repeats the store's own custo from the
 * deciding read, and custo enters no comparison here. Nothing in this module reads it.
 *
 * PURE and TOTAL: no clock, no network, no Firestore, no environment read. Only
 * {@link decidirBaixaPrecoLi} and {@link assinaturaEnvioPrecoLi} throw, on a target no reader of
 * this module can build (a bug).
 */

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/** A tabela id that can name an entry: a non-empty string (`precoDaTabela`'s own test). */
function tabelaInformada(tabelaId: string | null): tabelaId is string {
  return tabelaId !== null && tabelaId !== '';
}

/* -------------------------------------------------------------------------- */
/*                              The family root                                */
/* -------------------------------------------------------------------------- */

/**
 * The parent a produto's stored `paiId` names, or `null` when the produto is a ROOT: a non-empty
 * string other than the produto's own id. Absent, `null`, `''` (a legacy root's spelling), a
 * self-parent (`paiId === id`) and any other shape are roots.
 *
 * Bound by the trigger, the send run, the reconcile's parent set and {@link precoAlvoLi}: a ref is
 * never built from a raw `paiId`. It returns the id AS STORED and is not an id check: a value
 * that is not an ERP document id (`idDocumentoEstoqueLiSchema`: `a/b`, `.`, `..`, `__x__`, over
 * 1 500 bytes) names no document. ONE check decides that, everywhere: {@link precoAlvoLi} holds
 * such a child as `pai-ausente` without needing the parent, a caller that reads the parent checks
 * the same schema first (never a looser path test), and the reconcile snapshot's `pai` refuses
 * it, so its key walk stores such a child as held `pai-ausente`, never as a root
 * (`sincPrecoLojaIntegrada.ts`).
 *
 * Equal (a root): absent, `null`, `''`, `paiId === id`, a number. Distinct: `'P1'` on `'p1'` is a
 * child of `'P1'` (ids are exact), and `' '` is a child of `' '` (no trim: an id is not folded).
 */
export function paiDoProdutoErp(
  dados: Readonly<Record<string, unknown>>,
  id: string,
): string | null {
  const paiId = proprio(dados, 'paiId');
  return typeof paiId === 'string' && paiId !== '' && paiId !== id ? paiId : null;
}

/* -------------------------------------------------------------------------- */
/*                            One tabela entry                                 */
/* -------------------------------------------------------------------------- */

/** What one tabela entry of a `precos` map says. `valor` is in REAIS, rounded and positive. */
export type LeituraTabelaPrecoLi = { readonly valor: number } | 'ausente' | 'ilegivel';

/**
 * One tabela's entry in a `precos` map: `precoDaTabela`, with its "no price" split in two.
 *
 *  - `{ valor }` exactly when `precoDaTabela` answers a price (the same rounded, positive reais);
 *  - `'ausente'` — nothing to read: no tabela id, a `precos` that is not a plain object, no OWN
 *    key for the tabela (an inherited key is no entry), or a finite `valor` that is not negative
 *    and ROUNDS TO 0 (`0`, `-0`, `0.004`);
 *  - `'ilegivel'` — an OWN key whose entry is not a plain object (a legacy bare number), whose
 *    `valor` is not a finite number (`'10'`, `NaN`, absent), or a NEGATIVE `valor` — judged on the
 *    stored value, before any rounding, so `-0.004` is negative too (the sign is what
 *    {@link valorPrecoLi} judges, the same way).
 *
 * ## The decision on a stored `valor` ≤ 0 (pinned by test)
 *
 * The ERP's own schema refuses a `valor` below 0.01, so no ERP editor stores either kind; both are
 * legacy data. The two directions differ on the PROMO tabela only: there `'ausente'` CLEARS the
 * store's promotion (D10: no positive promo ⇒ cleared) and `'ilegivel'` HOLDS the whole child (no
 * price sent at all). On the NORMAL tabela both hold the child, so the choice costs nothing there.
 *
 *  - A value that rounds to 0 is `'ausente'`. It is exactly the shared reader's "no price"
 *    (`precoDaTabela`: positivity after rounding), so this channel never disagrees with Mercado
 *    Livre and Shopee about whether a produto has a promo; and a 0 promo IS the binding text's
 *    "no positive promo", whose answer is the clear. A clear never lowers what the buyer pays.
 *  - A NEGATIVE value is `'ilegivel'`, however small (`-0.004`, which rounds to 0, included). No
 *    reading of a negative price is a promotion or its absence, so holding — the reversible
 *    direction, which lists the child in the "sem preço no ERP" aviso — is the only safe one; a
 *    clear decided over corrupt data would act on a guess. Rounding first would let `-0.004`
 *    clear a promotion that `-0.01` holds.
 *
 * An unreadable SHAPE is held for the same reason: a bare-number legacy entry may be a real price
 * the operator set, and reading it as "no promo" would clear a promotion they meant to keep.
 */
export function leituraTabelaPrecoLi(
  precos: unknown,
  tabelaId: string | null,
): LeituraTabelaPrecoLi {
  const valor = precoDaTabela(precos, tabelaId);
  if (valor !== null) return { valor };
  // Why the shared reader found no price, in its own order.
  if (!tabelaInformada(tabelaId) || !ehObjeto(precos) || !Object.hasOwn(precos, tabelaId)) {
    return 'ausente';
  }
  const entrada: unknown = precos[tabelaId];
  if (!ehObjeto(entrada)) return 'ilegivel';
  // Read exactly as `precoDaTabela` reads it.
  const bruto = (entrada as { valor?: unknown }).valor;
  if (typeof bruto !== 'number' || !Number.isFinite(bruto)) return 'ilegivel';
  return bruto < 0 ? 'ilegivel' : 'ausente';
}

/**
 * One tabela's entry as the CHILD RULE reads it (`precoDoFilhoNaTabela`): the value is the shared
 * rule's own answer, and only a missing price is classified, on the map that rule reads under the
 * same flag — the parent's when it propagates, the child's own otherwise. Should the two ever
 * disagree (the rule priced where the map reads nothing, or the reverse), the entry is
 * `'ilegivel'`: a disagreement must hold the child, never send.
 */
function leituraDoFilhoNaTabelaLi(
  regra: {
    readonly precosDoPai: unknown;
    readonly propagaPreco: boolean;
    readonly precosDoFilho: unknown;
  },
  tabelaId: string,
): LeituraTabelaPrecoLi {
  const valor = precoDoFilhoNaTabela(regra, tabelaId);
  const lida = leituraTabelaPrecoLi(
    regra.propagaPreco ? regra.precosDoPai : regra.precosDoFilho,
    tabelaId,
  );
  if (valor === null) return typeof lida === 'string' ? lida : 'ilegivel';
  return typeof lida !== 'string' && lida.valor === valor ? { valor } : 'ilegivel';
}

/* -------------------------------------------------------------------------- */
/*                               The target                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a linked child's price is HELD (never sent; the store keeps its own price):
 *
 *  - `sem-tabela`: the conta names no normal tabela;
 *  - `sem-preco`: the map that prices the child has no normal-tabela price NOW (the produto
 *    document cannot tell "never had one" from "removed": clearing an entry deletes it);
 *  - `ilegivel`: an entry the child depends on (normal or promo) is present but unreadable;
 *  - `pai-ausente`: the produto names a parent that is not there (or a parent id that names no
 *    document).
 *
 * `sem-preco`, `ilegivel` and `pai-ausente` are what the "sem preço no ERP" aviso lists (each a
 * child the store keeps its own price for; the two latter counted apart). `sem-tabela` is a fact
 * of the conta, not of a child: the routes refuse such a conta and the reconcile does not price
 * it.
 */
export const motivoRetencaoPrecoLiSchema = z.enum([
  'sem-tabela',
  'sem-preco',
  'ilegivel',
  'pai-ausente',
]);
export type MotivoRetencaoPrecoLi = z.infer<typeof motivoRetencaoPrecoLiSchema>;

/** Named members of {@link motivoRetencaoPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_RETENCAO_PRECO_LI = {
  semTabela: 'sem-tabela',
  semPreco: 'sem-preco',
  ilegivel: 'ilegivel',
  paiAusente: 'pai-ausente',
} as const satisfies Record<string, MotivoRetencaoPrecoLi>;

/** Counted, never decisive: what a send's target says about the conta's tabelas. */
export interface SinaisPrecoLi {
  /** The conta's promo tabela IS its normal one: read as "no promo list", so the promo clears. */
  readonly promoIgualNormal: boolean;
  /** A positive promo at or above the full price, sent literally ("> 0 ⇒ promocional"). */
  readonly promoNaoMenor: boolean;
}

/** The promotion a send sets: a positive price, or the clear (D10). */
export type PromoAlvoPrecoLi = { readonly centavos: number } | 'limpar';

/** The price a linked child must show in the store, or why it is held. */
export type AlvoPrecoLi =
  | { readonly tipo: 'retido'; readonly motivo: MotivoRetencaoPrecoLi }
  | {
      readonly tipo: 'enviar';
      /** The full price, integer centavos, > 0. */
      readonly cheioCentavos: number;
      readonly promo: PromoAlvoPrecoLi;
      readonly sinais: SinaisPrecoLi;
    };

/** One ERP produto as a read hands it over: its document id and its raw data. */
export interface ProdutoPrecoLi {
  readonly id: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/**
 * The price a linked Loja Integrada child must show, computed from the ERP at send time.
 *
 * **Which map prices it** — the shared child rule, verbatim:
 *
 *  - a ROOT ({@link paiDoProdutoErp} is `null`: no parent, `''`, a self-parent) ⇒ its own `precos`;
 *  - a CHILD ⇒ `pai` is the parent's raw data (`null` = not found ⇒ held `pai-ausente`; so is a
 *    parent id `idDocumentoEstoqueLiSchema` refuses, whatever `pai` says). Under the PARENT's flag
 *    (`propagaPrecoAosFilhos`: anything but a stored literal `false` propagates) the child reads
 *    the PARENT's entries only — a parent without a normal-tabela price holds the child even when
 *    the child has one; otherwise the child's own entries, and the parent is not consulted.
 *
 * **What it sends:**
 *
 *  - `cheio` = the normal tabela's price; none ⇒ held `sem-preco`;
 *  - `promo` = the promo tabela's price when positive; the CLEAR (`'limpar'`) when the conta
 *    names no promo tabela, names its normal one again (signal `promoIgualNormal`), or the entry
 *    is absent or rounds to 0 (D10). A promo at or above `cheio` is sent literally (signal
 *    `promoNaoMenor`);
 *  - any entry it depends on that is `ilegivel` ⇒ held `ilegivel` (it wins over `sem-preco`: the
 *    more specific fact, and fixing the missing price would still meet it). So is a price whose
 *    centavos are past a safe integer (a corrupt stored value): every target sent is one
 *    {@link decidirBaixaPrecoLi} accepts.
 *
 * `pai` is ignored for a root. Kits are ordinary store products here: a kit's own `precos`.
 * Every price goes through `precoDaTabela` or `precoDoFilhoNaTabela`, then `centavosDeReais`.
 */
export function precoAlvoLi(args: {
  readonly produto: ProdutoPrecoLi;
  /** The parent's raw data, read only when {@link paiDoProdutoErp} names one; `null` = not found. */
  readonly pai: Readonly<Record<string, unknown>> | null;
  readonly tabelaNormalId: string | null;
  readonly tabelaPromocionalId: string | null;
}): AlvoPrecoLi {
  const { produto, tabelaNormalId, tabelaPromocionalId } = args;
  if (!tabelaInformada(tabelaNormalId)) {
    return { tipo: 'retido', motivo: MOTIVO_RETENCAO_PRECO_LI.semTabela };
  }
  const paiId = paiDoProdutoErp(produto.dados, produto.id);
  let ler: (tabelaId: string) => LeituraTabelaPrecoLi;
  if (paiId === null) {
    const precos = proprio(produto.dados, 'precos');
    ler = (tabelaId) => leituraTabelaPrecoLi(precos, tabelaId);
  } else {
    if (args.pai === null || !idDocumentoEstoqueLiSchema.safeParse(paiId).success) {
      return { tipo: 'retido', motivo: MOTIVO_RETENCAO_PRECO_LI.paiAusente };
    }
    const regra = {
      precosDoPai: proprio(args.pai, 'precos'),
      propagaPreco: propagaPrecoAosFilhos(proprio(args.pai, 'propagatePriceToChildren')),
      precosDoFilho: proprio(produto.dados, 'precos'),
    };
    ler = (tabelaId) => leituraDoFilhoNaTabelaLi(regra, tabelaId);
  }
  // A price whose centavos are past a safe integer is no price a send can carry: the shared reader
  // answers it, but `valorPrecoLi` reads the same value as unreadable on the store side, and
  // `decidirBaixaPrecoLi` would throw on it at every retry. Held as unreadable, before `sem-preco`.
  const lerEnviavel = (tabelaId: string): LeituraTabelaPrecoLi => {
    const lida = ler(tabelaId);
    if (typeof lida === 'string') return lida;
    return Number.isSafeInteger(centavosDeReais(lida.valor)) ? lida : 'ilegivel';
  };

  const normal = lerEnviavel(tabelaNormalId);
  const promoIgualNormal = tabelaPromocionalId === tabelaNormalId;
  const promo: LeituraTabelaPrecoLi =
    tabelaInformada(tabelaPromocionalId) && !promoIgualNormal
      ? lerEnviavel(tabelaPromocionalId)
      : 'ausente';
  if (normal === 'ilegivel' || promo === 'ilegivel') {
    return { tipo: 'retido', motivo: MOTIVO_RETENCAO_PRECO_LI.ilegivel };
  }
  if (normal === 'ausente') return { tipo: 'retido', motivo: MOTIVO_RETENCAO_PRECO_LI.semPreco };

  const cheioCentavos = centavosDeReais(normal.valor);
  const promoCentavos = promo === 'ausente' ? null : centavosDeReais(promo.valor);
  return {
    tipo: 'enviar',
    cheioCentavos,
    promo: promoCentavos === null ? 'limpar' : { centavos: promoCentavos },
    sinais: {
      promoIgualNormal,
      promoNaoMenor: promoCentavos !== null && promoCentavos >= cheioCentavos,
    },
  };
}

/**
 * A `precos` map that reads back EXACTLY as the given entries: `{ valor }` ⇒ that entry,
 * `'ilegivel'` ⇒ an entry with no readable `valor`, `'ausente'` ⇒ no key. The reconcile stores a
 * produto's readings (in centavos) instead of its whole map; this rebuilds a map from them, so
 * the stored readings replay through {@link precoAlvoLi} itself — never through a second copy of
 * the rule. `leituraTabelaPrecoLi(precosDasLeiturasLi(e), id)` is `e`'s reading of `id`, for
 * every reading this module produces (pinned by test).
 */
export function precosDasLeiturasLi(
  entradas: Readonly<Record<string, LeituraTabelaPrecoLi>>,
): Record<string, { readonly valor: number | null }> {
  const precos: Record<string, { readonly valor: number | null }> = {};
  for (const [tabelaId, leitura] of Object.entries(entradas)) {
    if (leitura === 'ausente') continue;
    precos[tabelaId] = { valor: leitura === 'ilegivel' ? null : leitura.valor };
  }
  return precos;
}

/* -------------------------------------------------------------------------- */
/*                     The fold: a store price value, read                     */
/* -------------------------------------------------------------------------- */

/** A Loja Integrada price value, read: integer centavos (≥ 0), nothing, or unreadable. */
export type ValorPrecoLi = { readonly centavos: number } | 'vazio' | 'ilegivel';

/**
 * A price value as Loja Integrada (or the ERP) hands it over — a `preco_*` leaf of a read, a
 * `cheio`/`promocional` of a PUT echo — in integer centavos:
 *
 *  - a JSON NUMBER ⇒ `centavosDeReais` (`274.42` ⇒ 27442; the ERP's `10.004` ⇒ 1000);
 *  - a STRING ⇒ the ONE wire decimal rule, `parseWireDecimal` (`'274.42'`, `'259.9'`, a padded
 *    4-decimal string such as `'160.0000'` — the form the store's order lines and its price
 *    resource carry: the owner's read-only price capture (2026-11-24, both stores) found every
 *    price-resource value it read to be text with exactly four decimals, or `null`, with no
 *    fraction of a centavo, while the produto detail carries the same values as JSON numbers —
 *    `'+10.00'` and `'.5'` all read; a second grammar is never written here);
 *  - `null` or absent ⇒ `'vazio'`;
 *  - a NEGATIVE value (number or string), a non-finite number, a string the wire rule refuses
 *    (`'1,50'`, `'1e3'`, `''`, `'abc'`), an amount whose centavos are past a safe integer, and any
 *    other type ⇒ `'ilegivel'`.
 *
 * `-0` and `'-0.00'` are 0, not negative. This is the transform the three folds below compare
 * through; it decides nothing itself.
 */
export function valorPrecoLi(v: unknown): ValorPrecoLi {
  if (v === null || v === undefined) return 'vazio';
  let reais: number | null = null;
  if (typeof v === 'number') reais = Number.isFinite(v) ? v : null;
  else if (typeof v === 'string') reais = parseWireDecimal(v);
  if (reais === null || reais < 0) return 'ilegivel';
  const centavos = centavosDeReais(reais);
  return Number.isSafeInteger(centavos) ? { centavos } : 'ilegivel';
}

/** The positive centavos of a read value, or `null` (empty, zero or unreadable). */
function positivoLi(v: ValorPrecoLi): number | null {
  return typeof v !== 'string' && v.centavos > 0 ? v.centavos : null;
}

/**
 * THE price equality: are `a` and `b` the same POSITIVE price, in centavos? A `true` means "the
 * store already shows it" and a send is skipped, so folding too much drops a real price edit.
 *
 * EQUAL: `'10.00'` ≡ `10`; `274.42` ≡ `'274.42'`; `'259.9'` ≡ `259.90`; the ERP's `10.004` ≡ `10`;
 * `'+10.00'` ≡ `10` and `'.5'` ≡ `0.50` (the one wire rule accepts them); `'160.0000'` ≡ `160`, and
 * `'259.9000'` ≡ `259.9` (the price resource's text against the detail's number).
 * DISTINCT: one centavo apart — `'10.01'` ≠ `10`, `'49.99'` ≠ `50`, and `49.991` ≠ `50`, which a
 * `< 0.01` tolerance would equate; the truncation `'22'` ≠ `22.83`; an unreadable value equals
 * nothing; and a `null` or 0 price equals NOTHING, not even another `null` or 0 — an empty full
 * price is never "already correct". A cleared promotion is {@link promocionalLimpoLi}'s question.
 */
export function mesmoPrecoLi(a: unknown, b: unknown): boolean {
  const ca = positivoLi(valorPrecoLi(a));
  return ca !== null && ca === positivoLi(valorPrecoLi(b));
}

/**
 * Does a PROMOTION value say "no promotion"? `null`, absent, and any value that reads as 0
 * centavos: `0`, `'0.00'`, `'0'`, `'0.0000'` (the store's own spelling of a zero promotion, the
 * only one its price resource uses), a JSON `0.004`.
 *
 * It looks at the promo value ALONE. A promotion EQUAL to the full price (`50.00` beside a
 * `cheio` of `50.00`) is NOT cleared: it is a stored promotion, so it differs from a clear, and a
 * target that clears the promotion sends the clear. DISTINCT, too:
 * `'0.01'` and `'0.0100'` (one centavo is a price, in either spelling), and every unreadable value
 * (`'-1.00'`, JSON `-1`, `'1,50'`, `''`) — never "cleared", never equal.
 */
export function promocionalLimpoLi(v: unknown): boolean {
  const lido = valorPrecoLi(v);
  return lido === 'vazio' || (typeof lido !== 'string' && lido.centavos === 0);
}

/**
 * What the buyer pays, from a full price and a promotion as the store holds them: the LOWER of the
 * positive ones (`min(cheio, promo > 0 ? promo : ∞)`), in centavos. `'vazio'` when neither is a
 * positive price (nothing protects a lower one); `'ilegivel'` when either value is unreadable.
 *
 * EQUAL: `(50, null)` ≡ `(50, '0.00')` ≡ `(50, 60)` ≡ 5000 — a cleared promo and one above the full
 * price leave the full price; `(null, 30)` ≡ 3000 (an empty full price protects nothing itself,
 * the promotion still does). DISTINCT: `(50, 39.99)` ⇒ 3999.
 */
export function efetivoPrecoLi(cheio: unknown, promocional: unknown): ValorPrecoLi {
  const c = valorPrecoLi(cheio);
  const p = valorPrecoLi(promocional);
  if (c === 'ilegivel' || p === 'ilegivel') return 'ilegivel';
  const positivos = [positivoLi(c), positivoLi(p)].filter((n): n is number => n !== null);
  return positivos.length === 0 ? 'vazio' : { centavos: Math.min(...positivos) };
}

/* -------------------------------------------------------------------------- */
/*               The clear: its wire shape, and when it has landed             */
/* -------------------------------------------------------------------------- */

/**
 * How a price send CLEARS the store's promotion (no positive promotion ⇒ cleared, `precoAlvoLi`'s
 * `'limpar'`), that is, what its `promocional` carries. A deploy-time choice: the functions entry point reads it from
 * `LOJA_INTEGRADA_PRECO_PROMO_LIMPO` (master plan step 13), so a clear the store refuses can be
 * retried with another shape in the window without a code change.
 *
 *  - `nulo` ⇒ JSON `null`, the DEFAULT ({@link FORMA_PROMO_LIMPA_PADRAO_LI}). The owner's
 *    read-only price capture (2026-11-24, both stores) found the rows with no promotion carrying
 *    `null` far more often than `'0.0000'`, the store's only zero spelling;
 *  - `zero` ⇒ JSON `0`;
 *  - `igual-cheio` ⇒ the full price itself: a window-only fallback a person chooses, tried once
 *    if the first canary write refuses both others. Never the default.
 *
 * Three layers must agree on it, which is why it lives here and not in the wire package: the
 * wire's body builder (the bytes sent), the send run's read-back and the nightly diff (what counts
 * as a landed clear, {@link promocionalLimpoNaFormaLi}). The values are spelled like every other
 * value here, never as a JS literal: an env value `null` or `0` reads to a person as "unset" or
 * "false". A caller parses the env value EXACTLY (`.safeParse`: no trim, no case fold), as the
 * valves are read.
 */
export const formaPromoLimpaLiSchema = z.enum(['nulo', 'zero', 'igual-cheio']);
export type FormaPromoLimpaLi = z.infer<typeof formaPromoLimpaLiSchema>;

/** Named members of {@link formaPromoLimpaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FORMA_PROMO_LIMPA_LI = {
  nulo: 'nulo',
  zero: 'zero',
  igualCheio: 'igual-cheio',
} as const satisfies Record<string, FormaPromoLimpaLi>;

/** The clear a send uses when none is configured: `null` on the wire. */
export const FORMA_PROMO_LIMPA_PADRAO_LI = FORMA_PROMO_LIMPA_LI.nulo;

/**
 * Does the store's promotion read as CLEARED under the configured clear `forma`? The question a
 * send's read-back, its PUT echo and the nightly diff ask after a send that cleared it:
 *
 *  - under every forma, {@link promocionalLimpoLi}: `null`, absent, or a value that reads as 0
 *    centavos (`'0.0000'`, `0`, `'0.00'`, `'0'`);
 *  - under `igual-cheio` ONLY, also a promotion that is the same positive price as `cheio`
 *    ({@link mesmoPrecoLi}), because that forma sends the full price AS the clear.
 *
 * Elsewhere a promotion equal to the full price stays what {@link promocionalLimpoLi} says it is:
 * a stored promotion, not a clear. The same capture found no promotion equal to the full price
 * among the rows it read, so the `igual-cheio` branch is a tested rule that no row read so far
 * meets.
 *
 * EQUAL (cleared) under `igual-cheio`: `('50.0000', '50.0000')`, `(50, '50.00')`, and every clear
 * of {@link promocionalLimpoLi}. DISTINCT (not cleared): a promotion equal to the full price under
 * `nulo` and under `zero`; under `igual-cheio`, `49.99` against `50` and `60` against `50` (one
 * centavo below, or a promotion above the full price, is not the full price), and `'0.01'`. A
 * `null` promotion beside a `null` full price is cleared by the clear rule, never by the equality:
 * a `null` or 0 price equals nothing.
 */
export function promocionalLimpoNaFormaLi(a: {
  readonly forma: FormaPromoLimpaLi;
  readonly cheio: unknown;
  readonly promocional: unknown;
}): boolean {
  return (
    promocionalLimpoLi(a.promocional) ||
    (a.forma === FORMA_PROMO_LIMPA_LI.igualCheio && mesmoPrecoLi(a.promocional, a.cheio))
  );
}

/* -------------------------------------------------------------------------- */
/*                                 No-lower                                    */
/* -------------------------------------------------------------------------- */

/** What a send would do to the price the buyer sees, against the store's current values. */
export type DecisaoBaixaPrecoLi =
  /** Nothing the buyer pays goes down. */
  | { readonly tipo: 'nao-baixa' }
  /** Something goes down; each leaf that does is named. */
  | {
      readonly tipo: 'baixa';
      readonly cheio: boolean;
      readonly promocional: boolean;
      readonly efetivo: boolean;
    }
  /** A current value is present but unreadable: neither "lowers" nor "does not". */
  | { readonly tipo: 'atual-ilegivel' };

/** A target as {@link precoAlvoLi} builds it: a positive full price and a promotion or the clear. */
export interface EnvioPrecoLi {
  readonly cheioCentavos: number;
  readonly promo: PromoAlvoPrecoLi;
}

function centavosValidos(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** Throws `RangeError` on a target no reader of this module builds (a bug). */
function validarEnvioPrecoLi(alvo: EnvioPrecoLi, quem: string): void {
  if (
    !centavosValidos(alvo.cheioCentavos) ||
    (alvo.promo !== 'limpar' && !centavosValidos(alvo.promo.centavos))
  ) {
    throw new RangeError(`${quem}: alvo fora da forma (centavos inteiros positivos)`);
  }
}

/**
 * Would sending `alvo` LOWER what the buyer pays, against the store's current `cheio` and
 * `promocional` (the deciding read's raw leaves)? The owner's no-lower rule (2026-11-23: "any
 * lower buyer price"), in integer centavos. It is `baixa` when ANY of these holds:
 *
 *  - `cheio`: the new full price is below the store's, when the store's is a positive price —
 *    an empty or 0 full price in the store protects nothing on that leaf;
 *  - `promocional`: both promotions are positive and the new one is below the store's;
 *  - `efetivo`: the new buyer price ({@link efetivoPrecoLi} of the target) is below the store's —
 *    which catches a NEW promotion where the store shows none.
 *
 * The three leaves are the owner's rule as approved, each applied literally. ⚠️ So the
 * `promocional` leaf compares two positive promotions even when the store's is ABOVE its own full
 * price, where {@link efetivoPrecoLi} assumes the buyer pays the full price: a store at 60.00
 * with a promotion of 70.00 and a target of 65.00 / 68.00 is `baixa` (`promocional` only),
 * although under that reading the buyer price rises. Deliberate: whether the store charges a
 * promotion that is not below its full price is not known (the owner's read-only price capture
 * found no such row among the rows it read on either store), and under either reading the literal
 * rule lets no lowering through — the cost is a raise held for an operator's "permitir baixar
 * preços", never a lower price sent unasked.
 *
 * A CLEAR never counts as lowering by itself: it can only raise the buyer price. A current value
 * that is present but unreadable is `atual-ilegivel`, reported apart — never "lowers", never
 * "does not". Which callers may lower is theirs to decide (an event, the manual push and a
 * publish may; an account-wide push asks first).
 *
 * Throws `RangeError` on a target that is not positive integer centavos (a bug).
 */
export function decidirBaixaPrecoLi(args: {
  readonly alvo: EnvioPrecoLi;
  readonly atual: { readonly cheio: unknown; readonly promocional: unknown };
}): DecisaoBaixaPrecoLi {
  validarEnvioPrecoLi(args.alvo, 'decidirBaixaPrecoLi');
  const cheioLi = valorPrecoLi(args.atual.cheio);
  const promoLi = valorPrecoLi(args.atual.promocional);
  const efetivoLi = efetivoPrecoLi(args.atual.cheio, args.atual.promocional);
  if (cheioLi === 'ilegivel' || promoLi === 'ilegivel' || efetivoLi === 'ilegivel') {
    return { tipo: 'atual-ilegivel' };
  }
  const { cheioCentavos } = args.alvo;
  const promoNova = args.alvo.promo === 'limpar' ? null : args.alvo.promo.centavos;
  const cheioDaLoja = positivoLi(cheioLi);
  const promoDaLoja = positivoLi(promoLi);
  const efetivoNovo = promoNova === null ? cheioCentavos : Math.min(cheioCentavos, promoNova);

  const cheio = cheioDaLoja !== null && cheioCentavos < cheioDaLoja;
  const promocional = promoNova !== null && promoDaLoja !== null && promoNova < promoDaLoja;
  const efetivo = efetivoLi !== 'vazio' && efetivoNovo < efetivoLi.centavos;
  return cheio || promocional || efetivo
    ? { tipo: 'baixa', cheio, promocional, efetivo }
    : { tipo: 'nao-baixa' };
}

/* -------------------------------------------------------------------------- */
/*                     The reconcile's non-convergence key                     */
/* -------------------------------------------------------------------------- */

/**
 * The grammar of {@link assinaturaEnvioPrecoLi}: four non-negative integers joined by `:`.
 * `sincPrecoLojaIntegrada.ts` stores it.
 */
export const ASSINATURA_ENVIO_PRECO_LI_REGEX = /^(?:0|[1-9]\d{0,15})(?::(?:0|[1-9]\d{0,15})){3}$/;

/**
 * The daily reconcile's key of ONE send it enqueued: the target and the store's value it was
 * diffed against, as exact centavos text — `<cheio>:<promo>:<cheio na loja>:<promo na loja>`,
 * with 0 for the clear and for an empty or 0 store value. Two nights with the same key for one
 * store product mean the send did not converge. The store read computes it, being the only phase
 * that holds the store row, and the candidate carries it to the queue phase.
 *
 * EQUAL: the store's promotion read as `null`, `0`, `'0.00'` or `'0.0000'` gives ONE key (all "no
 * promotion", {@link promocionalLimpoLi}), as do `'10.00'` and `10`. DISTINCT: any centavo of any
 * of the four (`'10.01'` vs `10`), and a cleared promo vs a promo equal to the full price.
 *
 * Throws `RangeError` on a target that is not positive integer centavos, or a store value that is
 * unreadable (such a row is never a candidate).
 */
export function assinaturaEnvioPrecoLi(
  alvo: EnvioPrecoLi,
  atual: { readonly cheio: unknown; readonly promocional: unknown },
): string {
  validarEnvioPrecoLi(alvo, 'assinaturaEnvioPrecoLi');
  const cheioLi = valorPrecoLi(atual.cheio);
  const promoLi = valorPrecoLi(atual.promocional);
  if (cheioLi === 'ilegivel' || promoLi === 'ilegivel') {
    throw new RangeError('assinaturaEnvioPrecoLi: valor da loja ilegível');
  }
  const partes = [
    alvo.cheioCentavos,
    alvo.promo === 'limpar' ? 0 : alvo.promo.centavos,
    positivoLi(cheioLi) ?? 0,
    positivoLi(promoLi) ?? 0,
  ];
  return partes.map(String).join(':');
}

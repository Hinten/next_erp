/**
 * The price TRIGGER's relevance (master plan step 13, PR 13-e): from the event's payload ALONE,
 * with zero reads, can this ERP produto write move the price a Loja Integrada child must show?
 * The trigger (`gatilhoPreco.ts`) fires on EVERY write of `produtos/{produtoId}`, every channel's
 * included, so this is its first gate and the one almost every write stops at.
 *
 * ## What it reads, EXACTLY
 *
 * The produto's OWN (`Object.hasOwn`) `precos`, `propagatePriceToChildren` and `paiId`
 * ({@link CAMPOS_RELEVANCIA_PRECO_LI}, the send run's own mask: the three fields the price
 * function reads), plus the path id. Nothing else — never the custo, the name, the photos,
 * `publicado`, the kit fields or the anchor. A write that moves none of the three cannot move a
 * target, so it stops here.
 *
 * A write is relevant exactly when one of these moved, before vs after:
 *
 *  - **a tabela reading** ({@link tabelasMovidasLi}): every own key of either side's `precos` that
 *    is an ERP document id, read on each side through the shared `leituraTabelaPrecoLi` and
 *    compared through {@link mesmaLeituraTabelaPrecoLi}, whose price equality is the shared
 *    `mesmoPrecoLi` (integer centavos). So float residue (`10` → `10.004`) and a key that can name
 *    no tabela (`'a/b'`, `'__x__'`) stop here at zero reads, while `49.99` → `50` and an
 *    unreadable value against a readable one (fail-open) go on;
 *  - **the propagation flag, FOLDED** (`propagaPrecoAosFilhos`: only a stored literal `false`
 *    stops propagation, so absent → `true` and `'false'` → absent move nothing);
 *  - **the parent** (`paiDoProdutoErp`: `''`, a self-parent and any non-string are roots; the id is
 *    exact, never trimmed or case-folded, and a ref is never built from a raw `paiId`).
 *
 * This folds per tabela key already, at zero reads: stricter than a deep-unequal `precos` test,
 * and the same verdict the conta-level comparison would give, so float residue and ghost keys
 * never cost the conta map's read. Another tabela's VALID key passes it and stops at the conta map
 * ({@link tabelaDaContaMoveuLi}: the conta's normal tabela, and its promotional one when set and
 * not the normal one again).
 *
 * ## Deliberately NOT signals
 *
 *  - **The custo.** The ERP custo is never sent (the send run echoes the store's own), so a
 *    custo-only write moves no target.
 *  - **A new counting link** (an anchor-only write): an "only link" import must not become an
 *    unreviewed mass price change. The nightly price phase, "Atualizar preços" or a publish take
 *    those rows (later PRs of step 13).
 *  - **A create or a delete**: a created produto has no link yet, and a deleted one has nothing to
 *    price.
 *  - Any other field.
 *
 * Pure and TOTAL over an unvalidated body: no clock, no Firestore, no environment, and no throw —
 * a throw here would ride the trigger's `retry: true` redelivery for ever.
 */
import {
  type LeituraTabelaPrecoLi,
  idDocumentoEstoqueLiSchema,
  leituraTabelaPrecoLi,
  mesmoPrecoLi,
  paiDoProdutoErp,
  propagaPrecoAosFilhos,
} from '@delfrance/schemas';

/** A produto document's raw data, as the event hands it over. */
export type DadosProdutoPrecoLi = Readonly<Record<string, unknown>>;

/** The ONLY payload fields relevance reads — the send run's mask (PR 13-d), by test. */
export const CAMPOS_RELEVANCIA_PRECO_LI = ['paiId', 'precos', 'propagatePriceToChildren'] as const;

type CampoRelevanciaPrecoLi = (typeof CAMPOS_RELEVANCIA_PRECO_LI)[number];

/** A side as an object: anything that is not one (never handed over today) reads as empty. */
function comoDados(dados: DadosProdutoPrecoLi): DadosProdutoPrecoLi {
  return typeof dados === 'object' && dados !== null ? dados : {};
}

/** An OWN property only, of the three fields this module reads: an inherited one is not stored data. */
function proprio(dados: DadosProdutoPrecoLi, campo: CampoRelevanciaPrecoLi): unknown {
  return Object.hasOwn(dados, campo) ? dados[campo] : undefined;
}

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Are two readings of ONE tabela key the same? Both `{valor}` and `mesmoPrecoLi(a.valor, b.valor)`
 * (integer centavos, positive), or the same class (`'ausente'` both, `'ilegivel'` both).
 *
 * EQUAL: `10` ≡ `10.004`; absent ≡ `0` (both `'ausente'`); `'10'` ≡ `'11'` (both `'ilegivel'`: the
 * run holds the child either way). DISTINCT: `49.99` vs `50`; `49.991` vs `50`; `'10'` vs `10`
 * (unreadable vs readable, fail-open); a legacy bare number vs `{valor}`; `'ausente'` vs `{valor}`.
 * A `valor` whose centavos pass a safe integer (corrupt data the run holds as unreadable) equals
 * nothing, itself included: that key always reads as moved, the over-including direction.
 */
export function mesmaLeituraTabelaPrecoLi(
  a: LeituraTabelaPrecoLi,
  b: LeituraTabelaPrecoLi,
): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return mesmoPrecoLi(a.valor, b.valor);
}

/** The own keys of a `precos` map that can name a tabela (an ERP document id); none otherwise. */
function chavesDeTabela(precos: unknown): string[] {
  if (!ehObjeto(precos)) return [];
  return Object.keys(precos).filter((chave) => idDocumentoEstoqueLiSchema.safeParse(chave).success);
}

/**
 * The tabela ids whose reading moved: every OWN key of either side's `precos` (when that side's
 * `precos` is a plain object) that is a valid ERP document id (`idDocumentoEstoqueLiSchema`, the
 * grammar `tabelasDaContaLi` applies to a conta's tabela), read on each side through
 * `leituraTabelaPrecoLi` and compared through {@link mesmaLeituraTabelaPrecoLi}. A ghost key
 * (`'a/b'`, `'__x__'`) is never a tabela and is skipped; an inherited key is not stored data.
 */
export function tabelasMovidasLi(
  antes: DadosProdutoPrecoLi,
  depois: DadosProdutoPrecoLi,
): ReadonlySet<string> {
  const precosAntes = proprio(comoDados(antes), 'precos');
  const precosDepois = proprio(comoDados(depois), 'precos');
  const movidas = new Set<string>();
  for (const chave of new Set([...chavesDeTabela(precosAntes), ...chavesDeTabela(precosDepois)])) {
    const lidaAntes = leituraTabelaPrecoLi(precosAntes, chave);
    const lidaDepois = leituraTabelaPrecoLi(precosDepois, chave);
    if (!mesmaLeituraTabelaPrecoLi(lidaAntes, lidaDepois)) movidas.add(chave);
  }
  return movidas;
}

export type RelevanciaPrecoLi =
  | { readonly relevante: false }
  | {
      readonly relevante: true;
      readonly tabelasMovidas: ReadonlySet<string>;
      /** `propagaPrecoAosFilhos(after.propagatePriceToChildren)`. */
      readonly propagaDepois: boolean;
      /** The FOLDED flag differs before vs after (only a literal `false` stops propagation). */
      readonly flagMudou: boolean;
      /** `paiDoProdutoErp(side, produtoId)`: `''`, a self-parent and any non-string are roots. */
      readonly paiAntes: string | null;
      readonly paiDepois: string | null;
      readonly paiMudou: boolean;
    };

/**
 * A create (`antes === null`) or a delete (`depois === null`) ⇒ not relevant. Otherwise relevant
 * exactly when a tabela reading moved, the folded flag flipped, or the parent moved (module
 * header).
 */
export function relevanciaEventoPrecoLi(ev: {
  readonly produtoId: string;
  readonly antes: DadosProdutoPrecoLi | null;
  readonly depois: DadosProdutoPrecoLi | null;
}): RelevanciaPrecoLi {
  if (ev.antes === null || ev.depois === null) return { relevante: false };
  const antes = comoDados(ev.antes);
  const depois = comoDados(ev.depois);
  const tabelasMovidas = tabelasMovidasLi(antes, depois);
  const propagaAntes = propagaPrecoAosFilhos(proprio(antes, 'propagatePriceToChildren'));
  const propagaDepois = propagaPrecoAosFilhos(proprio(depois, 'propagatePriceToChildren'));
  const paiAntes = paiDoProdutoErp(antes, ev.produtoId);
  const paiDepois = paiDoProdutoErp(depois, ev.produtoId);
  const flagMudou = propagaAntes !== propagaDepois;
  const paiMudou = paiAntes !== paiDepois;
  if (tabelasMovidas.size === 0 && !flagMudou && !paiMudou) return { relevante: false };
  return {
    relevante: true,
    tabelasMovidas,
    propagaDepois,
    flagMudou,
    paiAntes,
    paiDepois,
    paiMudou,
  };
}

/**
 * Did a tabela THIS conta prices at move? Its normal tabela, and its promotional one when set and
 * not equal to the normal one (`precoAlvoLi` reads a promo equal to the normal as "no promo list").
 */
export function tabelaDaContaMoveuLi(
  movidas: ReadonlySet<string>,
  conta: { readonly tabelaNormalId: string; readonly tabelaPromocionalId: string | null },
): boolean {
  if (movidas.has(conta.tabelaNormalId)) return true;
  const promo = conta.tabelaPromocionalId;
  return promo !== null && promo !== conta.tabelaNormalId && movidas.has(promo);
}

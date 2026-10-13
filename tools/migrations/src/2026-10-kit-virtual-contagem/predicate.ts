/**
 * Pure half of the L7 contagem (Shopee step 19, #1527): one row per produto whose
 * stored `ehKitVirtual` is literally `true`, split by whether it carries a Mercado
 * Livre link — on the produto itself OR on ANY of its children.
 *
 * No Firestore here — `audit.ts` owns the walk and hands this module what each
 * `limit(1)` read answered. The decision lives here so the part that can be wrong
 * is the part vitest reaches (`tools/migrations/README.md`, contract point 5).
 *
 * ## Why the count exists
 *
 * Step 19 gives the flag a meaning on Shopee: the FIRST publish of a produto with
 * `ehKit && ehKitVirtual` and no live Shopee link goes to `add_kit_item` (a native
 * kit, composition frozen, one main component), not to `add_item`. The legacy
 * Flutter app set the flag for Mercado Livre "User Products" kits
 * (`exportarProdutos.dart:157-170`), so the imported corpus can carry `true` on
 * produtos nobody meant as a native Shopee kit. Lucas's old Shopee kits are
 * ordinary listings with the flag false/null (2026-10-07). Lucas REVIEWS this list
 * before anything is flipped; nothing here writes, and there is no backfill.
 *
 * ## Named a CONTAGEM, never a census
 *
 * Lucas rejected a census issue for native kits (L7): old kits cannot become
 * native without a delete + create he does by hand. This is a read-only COUNT for
 * his review, and the name says so.
 */

/** The stored fields of one `produtos` doc the contagem reads — raw, never coerced. */
export interface ProdutoContado {
  readonly id: string;
  readonly paiId: unknown;
  readonly ehKit: unknown;
  readonly ehKitVirtual: unknown;
  readonly componentesKit: unknown;
}

/**
 * What the produto's OWN link subcollections answered — each one `limit(1)` read,
 * so `true` means "at least one document".
 *
 * ⚠️ Both link KINDS are read on the produto itself, by design. A root holds the
 * listing kinds (`produtoMercadoLivre`, `prodshopee`); a variation child holds the
 * variation kinds (`variacaoMercadoLivre`, `variashopee`). A família-de-um MEMBER
 * mirrors its parent's `ehKitVirtual` (`camposDeKitDoMembroUnico`, `familia.ts`),
 * so a child CAN be a row — and reading only the listing kinds there would print
 * "sem Mercado Livre" for a member whose ML link is a variation link.
 */
export interface VinculosDoProduto {
  readonly produtoMercadoLivre: boolean;
  readonly variacaoMercadoLivre: boolean;
  readonly prodshopee: boolean;
  readonly variashopee: boolean;
}

/** One child (`produtos where paiId == <id>`) and whether its `variacaoMercadoLivre` holds a doc. */
export interface FilhoContado {
  readonly id: string;
  readonly variacaoMercadoLivre: boolean;
}

/**
 * One JSONL row. The field set is the one the L7 window issue (#1854) promises Lucas
 * (reconcile §8.1), in that order.
 */
export interface LinhaDaContagem {
  readonly produtoId: string;
  /** `null` for a root; the parent's id for a child (a família-de-um member mirrors the flag). */
  readonly paiId: string | null;
  /**
   * `ehKit === true`, strictly — a legacy `null`, an absent key or a string is NOT
   * a kit, the same strictness as the schemas' `ehKitVirtualEfetivo`.
   */
  readonly ehKit: boolean;
  /** `componentesKit` is a map with at least one key. */
  readonly temComponentes: boolean;
  /** `mlNoProduto || mlNosFilhos`. */
  readonly comMercadoLivre: boolean;
  /** An ML link doc (listing or variation kind) in the produto's own subcollections. */
  readonly mlNoProduto: boolean;
  /** SOME child holds a `variacaoMercadoLivre` doc — any child, never only the first. */
  readonly mlNosFilhos: boolean;
  /**
   * A Shopee link doc (`prodshopee` or `variashopee`) in the produto's own
   * subcollections, whatever its estado and conta: a FACT for the review, not the
   * publisher's per-conta "live link" test.
   */
  readonly comShopee: boolean;
}

/**
 * Whether a produto enters the contagem: its stored `ehKitVirtual` is LITERALLY
 * `true`. Strict on purpose — L7 asks for `ehKitVirtual === true`, and a stray
 * string `'true'` or a `1` is a corpus oddity this count must not quietly absorb.
 * `ehKit` does NOT gate entry: the `ehKit !== true` rows are the subset step 19's
 * publisher refuses (`kit-virtual-sem-kit`) and the web editor switches off on the
 * next save, and Lucas sees them as such.
 */
export function entraNaContagem(produto: { readonly ehKitVirtual?: unknown }): boolean {
  return produto.ehKitVirtual === true;
}

/** `componentesKit` holds at least one component — the same test the member mirror applies. */
function temComponentesKit(componentesKit: unknown): boolean {
  if (typeof componentesKit !== 'object' || componentesKit === null) return false;
  if (Array.isArray(componentesKit)) return false;
  return Object.keys(componentesKit).length > 0;
}

/** A non-empty string id, else `null` — `''` is the legacy "no parent". */
function idOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * The row for one produto in the contagem.
 *
 * ⚠️ `mlNosFilhos` asks EVERY child. A legacy User Products kit stores one
 * `variacaoMercadoLivre` per variation under each child, and a family whose first
 * child was never published can still sell on ML through its second — one child
 * alone does not decide (M161).
 */
export function montarLinhaDaContagem(
  produto: ProdutoContado,
  vinculos: VinculosDoProduto,
  filhos: readonly FilhoContado[],
): LinhaDaContagem {
  const mlNoProduto = vinculos.produtoMercadoLivre || vinculos.variacaoMercadoLivre;
  const mlNosFilhos = filhos.some((filho) => filho.variacaoMercadoLivre);
  return {
    produtoId: produto.id,
    paiId: idOuNull(produto.paiId),
    ehKit: produto.ehKit === true,
    temComponentes: temComponentesKit(produto.componentesKit),
    comMercadoLivre: mlNoProduto || mlNosFilhos,
    mlNoProduto,
    mlNosFilhos,
    comShopee: vinculos.prodshopee || vinculos.variashopee,
  };
}

/** The totals the run prints on stdout. Every one is a count of ROWS. */
export interface ResumoDaContagem {
  readonly total: number;
  readonly comMercadoLivre: number;
  readonly semMercadoLivre: number;
  /** Rows whose `ehKit !== true`: refused by the publisher, switched off by the editor. */
  readonly semEhKit: number;
  readonly comShopee: number;
  /** Rows that are children (`paiId` set) — mirrored members, never published on their own. */
  readonly filhos: number;
}

/** Totals over the rows. Pure; `audit.ts` prints them. */
export function resumirContagem(linhas: readonly LinhaDaContagem[]): ResumoDaContagem {
  let comMercadoLivre = 0;
  let semEhKit = 0;
  let comShopee = 0;
  let filhos = 0;
  for (const linha of linhas) {
    if (linha.comMercadoLivre) comMercadoLivre += 1;
    if (!linha.ehKit) semEhKit += 1;
    if (linha.comShopee) comShopee += 1;
    if (linha.paiId !== null) filhos += 1;
  }
  return {
    total: linhas.length,
    comMercadoLivre,
    semMercadoLivre: linhas.length - comMercadoLivre,
    semEhKit,
    comShopee,
    filhos,
  };
}

/**
 * The order import's ONE fill-once predicate (master plan step 5, PR 5-b): is
 * a STORED field still empty, so this import may fill it? The pedido
 * (`pedidoMapeamento.ts`), its freight block (`freteMapeamento.ts`) and its
 * payments (`pagamentoMapeamento.ts`) all ask it of the same stored documents,
 * so they import it from here and keep no copy: three copies of one rule
 * drift, and the groups of one document would then fill by different rules.
 *
 * Empty: `null`, absent (`undefined`) and the empty text `''` — what a writer
 * that had nothing leaves. NOT empty: `0`, `false`, a whitespace-only text
 * (`' '`), an empty list or map — each is a value somebody wrote, and filling
 * over it would overwrite that writer. Pinned by `vazioArmazenado.test.ts`.
 */

/** Nothing stored yet, for a fill-once field: `null`, absent or `''` — never `0` (module header). */
export function vazioArmazenadoLi(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === '';
}

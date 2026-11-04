/**
 * The `nome` / `sku` JOIN of the price surfaces — read at answer time, never
 * denormalised onto a row (#1529, step 21).
 *
 * Two callers, one join: the job report page
 * (`app/api/marketplace/shopee/atualizar-precos/relatorio/route.ts`, keyed on
 * the produto that PRICED each row) and the manual push
 * (`app/api/marketplace/shopee/enviar-precos/route.ts`, keyed on each model
 * row's `variacaoProdutoId`, so five models of one listing stop reading as five
 * identical lines). Moved here from the report route verbatim, so the two cannot
 * disagree about what a missing produto or a non-string field reads as.
 *
 * Next-free and clock-free: a key read through the `produtoCollection` handle.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';

/** `getAll` is unbounded but a request is not; the name join is chunked. */
const PRODUTOS_POR_LOTE = 300;

/**
 * Batched `nome` / `sku` for the DISTINCT produtos named, a field mask per
 * read. A family contributes a row per model, so the distinct set is far smaller
 * than the row count — and an empty list reads nothing.
 *
 * ⚠️ A missing produto is DATA, not an error: it is simply absent from the map,
 * and a caller renders it as blanks, never as a failed answer. A field that is
 * not a string reads `null`.
 */
export async function lerNomesDosProdutos(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<Map<string, { nome: string | null; sku: string | null }>> {
  const distintos = [...new Set(produtoIds)];
  const saida = new Map<string, { nome: string | null; sku: string | null }>();
  for (let i = 0; i < distintos.length; i += PRODUTOS_POR_LOTE) {
    const lote = distintos.slice(i, i + PRODUTOS_POR_LOTE);
    const snaps = await db.getAll(...lote.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: ['nome', 'sku'],
    });
    for (const s of snaps) {
      if (!s.exists) continue;
      const bruto = (s.data() ?? {}) as { nome?: unknown; sku?: unknown };
      saida.set(s.id, {
        nome: typeof bruto.nome === 'string' ? bruto.nome : null,
        sku: typeof bruto.sku === 'string' ? bruto.sku : null,
      });
    }
  }
  return saida;
}

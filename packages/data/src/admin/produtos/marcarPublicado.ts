/**
 * `marcarProdutoPublicado` — a successful channel publish ticks the produto's
 * ERP catalogue flag `publicado`.
 *
 * Lucas, 2026-11-17: a produto published on a marketplace must show as
 * **Publicado** in the ERP. No channel wrote the flag on publish before this —
 * the legacy Flutter app set it only on IMPORT
 * (`.old/.../shopee/lib/src/produto/importar.dart`, ML `models.dart`) — so a
 * produto published from the ERP stayed a draft in the catalogue.
 *
 * ⚠️ This is a WRITER of the flag, never a gate. The `publicado` docblock in
 * `@delfrance/schemas` (`produto.ts`) still holds: no integration may decide
 * anything from it.
 *
 * Shared here, beside the `integracoesComProduto` maintenance, so every channel
 * calls ONE copy (Shopee first; the other channels are a follow-up issue).
 *
 * ## Race discipline (root CLAUDE.md rule 7 / ADR 0011) — tier 1
 *
 * The write is derived from a read (`publicado !== true`), so it rides the
 * read's `updateTime` as a `lastUpdateTime` precondition. The interesting loser
 * is an operator who un-ticks Publicado between our read and our write: their
 * edit wins, we write nothing and answer `conflito`. There is no retry — the
 * next publish re-applies the flag, and a retry would only re-race that same
 * operator.
 *
 * ## What is deliberately NOT written
 *
 * Only `publicado`. No `ultimaModificacao`: the same reasoning as
 * `integracoesComProduto.ts` — a stamp would make the produtos list flash and
 * raise a false conflict for an operator who has the produto form open (the
 * Shopee editor lives on that very page). ObjectView saves DIRTY fields only,
 * so a form opened before the publish never writes `publicado: false` back.
 *
 * A family of one needs nothing more: `onProdutoChanged`'s
 * `sincronizarMembroUnico` already mirrors `publicado` onto `filhoUnicoId`.
 */

import type { Firestore } from 'firebase-admin/firestore';

import { produtoCollection } from '../collections';
import { isFailedPrecondition, isNotFound } from '../grpcErrors';

/**
 * - `marcado` — the flag went from not-true to `true`;
 * - `ja-publicado` — it was already `true`, nothing written;
 * - `inexistente` — the produto does not exist (never resurrected);
 * - `conflito` — the produto changed between the read and the write; the other
 *   writer wins and nothing was written.
 */
export type DesfechoMarcarPublicado = 'marcado' | 'ja-publicado' | 'inexistente' | 'conflito';

export async function marcarProdutoPublicado(
  db: Firestore,
  produtoId: string,
): Promise<DesfechoMarcarPublicado> {
  const ref = produtoCollection.docRef(db, {}, produtoId);
  const snap = await ref.get();
  if (!snap.exists) return 'inexistente';
  if ((snap.data() as { publicado?: unknown } | undefined)?.publicado === true) {
    return 'ja-publicado';
  }

  try {
    await ref.update({ publicado: true }, { lastUpdateTime: snap.updateTime });
    return 'marcado';
  } catch (err) {
    if (isNotFound(err)) return 'inexistente';
    if (isFailedPrecondition(err)) {
      console.warn(
        '[produtos/publicado] o produto mudou entre a leitura e a escrita; publicado não foi marcado',
        { produtoId },
      );
      return 'conflito';
    }
    throw err;
  }
}

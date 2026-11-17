import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { produtoLojaIntegrada } from '@delfrance/schemas';

import {
  adicionarContaLi,
  planejarMudancaDeLinkLi,
  removerContaLiSeOrfa,
} from '../../lib/lojaIntegrada/produtos/integracoesComProdutoLi';
import { getDb } from './lib/admin';

/**
 * The `integracoesComProduto` anchor trigger for Loja Integrada (master plan step 9, PR 9-v) —
 * step 12's prerequisite, shipped with the link docs' first writer (the product import). It
 * derives the Loja Integrada half of `produtos.integracoesComProduto` from the link documents
 * themselves rather than from a stamp every writer has to remember.
 *
 * All the logic is in `lib/lojaIntegrada/produtos/integracoesComProdutoLi.ts` — the binding —
 * over the channel-neutral core in `@delfrance/data/admin/produtos`, where the failure asymmetry
 * and the race discipline are argued. This file is the thin wrapper, the shape of Shopee's
 * `onProdutoShopeeLinkChanged`.
 *
 * Why it exists: that array is the ANCHOR PRE-FILTER the stock and price sweeps open with, so its
 * accuracy IS stock and price coverage. A conta listed with no counting link costs one skipped
 * sweep row; a counting link with no conta entry is a SILENT outage — the produto is never
 * selected and nothing logs a reason.
 *
 * ONE trigger serves parents and children: a Loja Integrada child's link sits under the ERP
 * CHILD produto in the same leaf collection (`produtolojaintegrada`) as a parent's link under the
 * ERP root, so this path covers both, and each produto's array follows its own links.
 *
 * ---- The decision comes from the payload, BEFORE `getDb()` ----
 * That is load-bearing, not a nicety: link documents are rewritten for reasons that cannot move
 * membership — the product import refreshes their mirror fields (`ativo`, `bloqueado`) on every
 * run, and later steps' publish and sync flows write them again. An edit that moves nothing (a
 * `nome`, a mirror field, a publication code) costs ZERO reads and ZERO writes; the test pins it
 * with a handle that throws on any touch. A malformed document can never throw here either: both
 * folds are total over an unvalidated body, because a throw inside the fast path would ride the
 * redelivery for ever.
 *
 * ---- Rule 7 ----
 * The add is tier 0 (`arrayUnion`: commutative and idempotent, but blind — see `retry` below for
 * the one order it cannot survive); the remove is tier 1, inside the core's inventoried guarded
 * write, re-derived from the unfiltered survivor read the binding supplies. This codebase spells no multi-document atomic write (`lib/lojaIntegrada/estrutura.test.ts`),
 * so the transaction inventory gains no row. The adds run before the checks: a delivery that
 * dies between the two leaves the over-inclusive state (the new conta in, the old not yet
 * checked) — the cheap direction — and the redelivery finishes the job.
 *
 * ---- Options ----
 * ⚠️ `database` is the repo's NAMED `default` database, never the `(default)` sentinel: a trigger
 * bound to `(default)` deploys fine and never fires. `build.mjs` defines the id at build time
 * (Firebase reads no env during codebase analysis), exactly as for the conta trigger, whose
 * docblock says what the define does and does not cover; `index.test.ts` pins the analysed
 * binding to exactly `'default'`.
 *
 * `retry: true` → Eventarc at-least-once, for TRANSIENT Firestore failures. A redelivery replays
 * the ORIGINAL before/after. The remove is safe under that: it re-derives its verdict from a
 * guarded re-read of what is stored NOW. ⚠️ The add is NOT, because it reads nothing: Eventarc
 * guarantees no order, so a link's create (or un-trash, or re-point) event — first delivered or
 * retried — can be handled AFTER the same link's delete, `removido: true` flip or re-point. The
 * close's check then found nothing to remove, the late `arrayUnion` lists a conta with no
 * counting link, and nothing removes it: `planLinkChange`'s fast path ignores every later write
 * to a link that no longer counts (the core's header says the same of its read-derived add), and
 * this channel runs no audit that drops stale entries. Only a manual fix clears it (the window's
 * anchor census looks for the opposite gap: a counting link whose conta is missing).
 * Accepted (the core's event-derived tier-0 add, as Shopee's trigger makes it): it is the
 * over-inclusive direction, one skipped sweep row per run, never the silent outage. Closing it
 * would mean routing the event's add through the core's guarded `adicionarContaSeViva` — one
 * more guarded write and survivor read per add that moves membership.
 *
 * No `region:` — `options.ts` sets it globally. NO `secrets:` — this trigger never calls Loja
 * Integrada (D17), and a needless binding is one more Secret Manager grant that can fail the
 * deploy. It is not gated by the read switch, which gates calls, and it makes none. No memory or
 * timeout of its own.
 *
 * LOGS: ids only (the produto, the link doc, the conta) and the write's boolean outcome — never
 * a link's `sku`, `nome` or any other value.
 *
 * No loop: it writes ONE key on `produtos`, which is not a link document, and
 * `integracoesComProduto` is already in `onProdutoChanged`'s `PRODUTO_HISTORY_IGNORE_FIELDS` —
 * denorm churn is not an operator edit.
 */
export const onProdutoLojaIntegradaLinkChanged = onDocumentWritten(
  {
    // The meta, never a literal: `produtos/{produtoId}/produtolojaintegrada`. A guessed leaf
    // spelling matches a collection nothing writes — silently.
    document: `${produtoLojaIntegrada.meta.collectionPath}/{linkId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:`, no memory/timeout — see the docblock.
  },
  async (event) => {
    // The middle `{produtoId}` wildcard sits inside the meta-derived path prefix, so its type is
    // not inferred into `event.params` (only the trailing `{linkId}` is) — both are present at
    // runtime. `produtoId` comes from the PATH, never from a field of the link document.
    const { produtoId, linkId } = event.params as { produtoId: string; linkId: string };
    const antes = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const depois = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    const plano = planejarMudancaDeLinkLi(antes, depois);
    if (plano.add.length === 0 && plano.check.length === 0) return; // 0 reads, 0 writes

    const db = getDb();

    for (const contaId of plano.add) {
      const escrito = await adicionarContaLi(db, produtoId, contaId);
      logger.info('[loja-integrada] onProdutoLojaIntegradaLinkChanged add', {
        produtoId,
        linkId,
        contaId,
        escrito,
      });
    }

    for (const contaId of plano.check) {
      const removido = await removerContaLiSeOrfa(db, produtoId, contaId);
      logger.info('[loja-integrada] onProdutoLojaIntegradaLinkChanged check', {
        produtoId,
        linkId,
        contaId,
        removido,
      });
    }
  },
);

import {
  FieldPath,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { INTEGRACAO_TIPO, linkHasLiveListing, variacaoLinkHasListing } from '@delfrance/schemas';

import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import {
  contaIdFromRef,
  normalizarCaminho,
  planContaOuterRefBackfill,
  planIntegracoesComProduto,
} from './transform';

/**
 * Reconcile `produtos.integracoesComProduto` against the Mercado Livre link
 * subcollections, and backfill `variacaoMercadoLivre.contaOuterRef` (#920).
 * Idempotent, dry-run by default. Runbook:
 * `tools/migrations/ml-integracoes-com-produto.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:ml-integracoes-com-produto \
 *     --project <id>            # dry-run: log every change it WOULD make
 *   pnpm --filter @delfrance/migrations migrate:ml-integracoes-com-produto \
 *     --project <id> --apply    # write
 *
 * ## Why it has to exist
 *
 * The two link triggers own that array now, but a trigger only fires on a link
 * WRITE. Two populations are therefore invisible to them:
 *
 *  - **Pre-existing drift.** Produtos whose links have not been touched since
 *    the triggers were deployed. This already causes silent under-sends today —
 *    `check-stock-indexes.mjs` notes that its own ratio counter is a lower
 *    bound because "an anchor with a live link but a stale array entry is
 *    missing from it (and is invisible to the shipped sweep today)".
 *  - **Everything that arrives by import.** A Firestore import fires NO Cloud
 *    Functions triggers (root CLAUDE.md rule 8), so after the production data
 *    moves, nothing derives the array or the new `contaOuterRef` on arrival.
 *    This script is the only thing that does.
 *
 * ## The safety rule
 *
 * `integracoesComProduto` is NOT an ML field — the legacy Amazon code writes it
 * and Amazon's periodic stock sender reads it. So this reconciles ONLY ids that
 * resolve to an ML conta and passes every other id through untouched. See
 * `transform.ts`.
 *
 * ## Cost shape
 *
 * Three paged scans, diffed in memory — deliberately NOT a per-conta
 * `produtos where integracoesComProduto array-contains X` query, which has no
 * index of its own and on Enterprise would full-scan `produtos` once per conta.
 * Field masks keep the pages light (produtos docs carry heavy media arrays).
 */

const PAGE_SIZE = 300;

/** What one parent link contributes: its conta, and whether it counts. */
interface LinkPai {
  contaId: string | null;
  conta: boolean;
  contaRef: string | null;
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/** Page by document id — a stable cursor with bounded memory. */
async function* pagesByDocId(
  coll: CollectionReference | Query,
): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = coll.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/** The produto id a `produtos/<id>/<sub>/<doc>` path belongs to. */
function produtoIdDoCaminho(path: string): string | null {
  const segs = normalizarCaminho(path).split('/').filter(Boolean);
  return segs[0] === 'produtos' && segs.length >= 2 ? (segs[1] ?? null) : null;
}

function adicionar(mapa: Map<string, Set<string>>, chave: string, valor: string): void {
  let s = mapa.get(chave);
  if (!s) mapa.set(chave, (s = new Set()));
  s.add(valor);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;

  /* -- 1. Which integrações are Mercado Livre? ------------------------------ */
  // Everything outside this set belongs to another channel and is off limits.
  const contasSnap = await ctx.db
    .collection('integracao')
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .get();
  const contasMl = new Set(contasSnap.docs.map((d) => d.id));
  log(`[ml-integracoes] ${contasMl.size} conta(s) Mercado Livre: ${[...contasMl].join(', ')}`);
  if (contasMl.size === 0) {
    log('[ml-integracoes] nothing to reconcile — no ML conta in this project');
    return { docsScanned: 0, docsChanged: 0 };
  }

  /* -- 2. Parent links ------------------------------------------------------ */
  // Keyed by normalized doc path so a variation's `produtoMercadoLivreOuterRef`
  // resolves without a second read.
  const linksPorCaminho = new Map<string, LinkPai>();
  const derivadas = new Map<string, Set<string>>();
  for await (const docs of pagesByDocId(
    ctx.db.collectionGroup('produtoMercadoLivre').select('contaOuterRef', 'id', 'estado'),
  )) {
    for (const doc of docs) {
      docsScanned += 1;
      const raw = doc.data() as Record<string, unknown>;
      const contaRef = typeof raw.contaOuterRef === 'string' ? raw.contaOuterRef : null;
      const contaId = contaIdFromRef(contaRef);
      const conta = contaId != null && contasMl.has(contaId) && linkHasLiveListing(raw);
      linksPorCaminho.set(normalizarCaminho(doc.ref.path), { contaId, conta, contaRef });

      const produtoId = produtoIdDoCaminho(doc.ref.path);
      if (conta && produtoId && contaId) adicionar(derivadas, produtoId, contaId);
    }
  }
  log(`[ml-integracoes] ${linksPorCaminho.size} link(s) de anúncio`);

  /* -- 3. Variation links: backfill contaOuterRef + derive the child's contas */
  let backfilled = 0;
  for await (const docs of pagesByDocId(
    ctx.db
      .collectionGroup('variacaoMercadoLivre')
      .select('contaOuterRef', 'produtoMercadoLivreOuterRef', 'id', 'itemId'),
  )) {
    for (const doc of docs) {
      docsScanned += 1;
      const raw = doc.data() as Record<string, unknown>;
      const pai =
        typeof raw.produtoMercadoLivreOuterRef === 'string'
          ? linksPorCaminho.get(normalizarCaminho(raw.produtoMercadoLivreOuterRef))
          : undefined;

      // Backfill: the conta the parent link names, written onto the child link
      // so the trigger stops needing its fallback hop.
      const novoRef = planContaOuterRefBackfill(raw.contaOuterRef, pai?.contaRef ?? null);
      if (novoRef != null) {
        ctx.sink.change(doc.ref.path, 'contaOuterRef', raw.contaOuterRef ?? null, novoRef);
        backfilled += 1;
        docsChanged += 1;
        await ctx.writer.update(doc.ref, { contaOuterRef: novoRef });
      } else if (raw.contaOuterRef == null && pai == null) {
        ctx.sink.skip(doc.ref.path, 'contaOuterRef', null, 'link-pai-ausente');
      }

      // Membership: the child's own field once backfilled, else the parent's.
      // `estado` is deliberately NOT consulted here — same asymmetry the child
      // trigger documents.
      const contaId = contaIdFromRef(raw.contaOuterRef ?? novoRef ?? pai?.contaRef ?? null);
      const produtoId = produtoIdDoCaminho(doc.ref.path);
      if (contaId && contasMl.has(contaId) && variacaoLinkHasListing(raw) && produtoId) {
        adicionar(derivadas, produtoId, contaId);
      }
    }
  }
  log(`[ml-integracoes] ${backfilled} contaOuterRef backfilled em variacaoMercadoLivre`);

  /* -- 4. Reconcile every produto ------------------------------------------ */
  // Driven by a full paged scan of `produtos` rather than a per-conta
  // `array-contains` query: this pass has to find produtos that must LOSE an id
  // as well as those that must gain one, and the scan does both in one go.
  for await (const docs of pagesByDocId(
    ctx.db.collection('produtos').select('integracoesComProduto'),
  )) {
    for (const doc of docs) {
      docsScanned += 1;
      const raw = doc.data() as Record<string, unknown>;
      const plano = planIntegracoesComProduto(
        raw.integracoesComProduto,
        contasMl,
        derivadas.get(doc.id) ?? new Set<string>(),
      );
      if (plano == null) continue;
      ctx.sink.change(doc.ref.path, 'integracoesComProduto', plano.from, plano.to);
      docsChanged += 1;
      await ctx.writer.update(doc.ref, { integracoesComProduto: plano.to });
    }
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('ml-integracoes-com-produto', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}

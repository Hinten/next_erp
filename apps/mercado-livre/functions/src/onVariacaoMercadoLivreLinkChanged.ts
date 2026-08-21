import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { variacaoLinkHasListing, variacaoMercadoLivre } from '@delfrance/schemas';

import {
  adicionarConta,
  lerLinkPai,
  planLinkChange,
  removerContaSeOrfa,
  resolverContaRefDaVariacao,
  sobrevivemVariacoesDoProduto,
  variacaoPodeMudarMembership,
} from '../../lib/marketplace/anuncios/integracoesComProduto';
import { getDb } from './lib/admin';

/**
 * The variation-child half of #920: owns `integracoesComProduto` on produtos
 * with a `paiId`, whose ML link is a `variacaoMercadoLivre` doc rather than a
 * `produtoMercadoLivre` one.
 *
 * Neither ML sweep reads the array on children — both open with
 * `paiId == null` — so this exists to keep the produto list's integração filter
 * and badge honest, which is the only consumer children have.
 *
 * ⚠️ `estado` is NOT consulted here, and that asymmetry with the parent trigger
 * is deliberate: `estado` lives only on the parent link, so honouring it would
 * force `onProdutoMercadoLivreLinkChanged` to fan out to every child on every
 * status transition. It also matches the behaviour being replaced —
 * `updateParentDenorm` only ever touched the link's OWN produto, so a cancel
 * dropped the conta from the parent and left the children alone. See
 * `variacaoLinkHasListing`.
 *
 * Same options block, same reasoning, as `onProdutoMercadoLivreLinkChanged`:
 * named `default` database, `retry: true` over idempotent arms, no `secrets:`.
 *
 * COST: `variacaoPodeMudarMembership` decides from the payload alone, before
 * `getDb()` — it has to, since resolving the conta may itself need a read on
 * rows that predate the `contaOuterRef` field.
 */
export const onVariacaoMercadoLivreLinkChanged = onDocumentWritten(
  {
    document: `${variacaoMercadoLivre.meta.collectionPath}/{docId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: process.env.FUNCTIONS_REGION ?? 'us-east5',
    retry: true,
  },
  async (event) => {
    // Middle-wildcard cast, as in the parent trigger.
    const { produtoId, docId } = event.params as { produtoId: string; docId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    if (!variacaoPodeMudarMembership(before, after)) return; // 0 reads, 0 writes

    const db = getDb();

    // Resolve each side's conta ref, then reuse the parent planner by handing it
    // records whose `contaOuterRef` is filled in. On legacy rows this is where
    // the transitional parent-link hop happens; it yields null once the parent
    // link is gone, and a null conta simply drops out of the plan — leaving the
    // entry, which is the safe direction.
    const lerPai = lerLinkPai(db);
    const contaRefBefore = await resolverContaRefDaVariacao(before, lerPai);
    const contaRefAfter = await resolverContaRefDaVariacao(after, lerPai);
    const plano = planLinkChange(
      before == null ? null : { ...before, contaOuterRef: contaRefBefore },
      after == null ? null : { ...after, contaOuterRef: contaRefAfter },
      variacaoLinkHasListing,
    );
    if (plano.add.length === 0 && plano.check.length === 0) return;

    for (const integracaoId of plano.add) {
      const escrito = await adicionarConta(db, produtoId, integracaoId);
      logger.info('[mercado-livre] onVariacaoMercadoLivreLinkChanged add', {
        produtoId,
        docId,
        integracaoId,
        escrito,
      });
    }

    for (const integracaoId of plano.check) {
      const removido = await removerContaSeOrfa(
        db,
        produtoId,
        integracaoId,
        sobrevivemVariacoesDoProduto(db, produtoId, integracaoId),
      );
      logger.info('[mercado-livre] onVariacaoMercadoLivreLinkChanged check', {
        produtoId,
        docId,
        integracaoId,
        removido,
      });
    }
  },
);

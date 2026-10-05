/**
 * `POST /api/marketplace/shopee/reverificar-anuncio` — re-read ONE listing's
 * authoritative state from Shopee and reconcile the stored link with it. Body:
 * `{ integracaoId, produtoId, linkDocId? }`. Requires `PERM.integracao.write`.
 *
 * It is the manual twin of the violation push: the same read-back, the same
 * violation pull, the same child-model sync, the same aviso resolution — so an
 * operator who never received a delivery (a lost push, a subscription that was
 * off) can still bring the ERP's reading up to date, and one who fixed the
 * listing at Seller Centre can close the aviso from here.
 *
 * ## ⚠️ Both 4xx bodies are built in THIS file, not by an error class
 *
 * `respond.ts`'s ladder exists for classes that cross module boundaries. "this
 * conta holds no link for that produto" and "the link was never published" are
 * route-local facts the orchestrator answers with a `null` and an `acao`; a new
 * error class for either would put a response decision behind an exception for
 * no gain. Step 11 adds no error class beyond the two publish ones.
 *
 * ## Outcomes
 *
 * 200 with the nine result keys, built BY NAME · 400 for a bad body ·
 * 404 {@link CODIGO_ANUNCIO_SEM_VINCULO} when this conta holds no `prodshopee`
 * for the produto (a `linkDocId` belonging to another conta resolves the same
 * way — the conta filter runs first, so an id can only narrow within what this
 * conta already owns) · 409 {@link CODIGO_ANUNCIO_NAO_PUBLICADO} when the link
 * carries no `item_id`, which spent ZERO Shopee calls: there is no listing to
 * ask about yet · everything else through `shopeeErrorResponse`.
 *
 * ⚠️ A listing Shopee no longer has is NOT an error here — it comes back 200
 * with the `removido` verdict, which is what lets the link be marked and the
 * aviso closed.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerCorpoReverificar } from '@/lib/shopee/anuncios/corpoPublicacao';
import {
  ACAO_REVERIFICACAO,
  reverificarAnuncioShopee,
} from '@/lib/shopee/anuncios/reverificarAnuncio';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { corpoDeErro, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** No `prodshopee` document for this produto on this conta. */
export const CODIGO_ANUNCIO_SEM_VINCULO = 'SHOPEE_ANUNCIO_SEM_VINCULO';

/** The link exists but carries no `item_id` — nothing was ever published. */
export const CODIGO_ANUNCIO_NAO_PUBLICADO = 'SHOPEE_ANUNCIO_NAO_PUBLICADO';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = lerCorpoReverificar(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErro(corpo), { status: 400 });
  const { integracaoId, produtoId, linkDocId } = corpo.valor;

  // ONE clock read, handed down: the read-back stamp, the violation-reading
  // stamp and any aviso this run closes all carry the same instant.
  const nowMs = Date.now();

  try {
    const res = await reverificarAnuncioShopee(
      getAdminFirestore(),
      { integracaoId, produtoId, linkDocId },
      { increment: (by: number) => FieldValue.increment(by), nowMs },
    );

    if (res === null) {
      return NextResponse.json(
        {
          error:
            `Nenhum anúncio desta conta para o produto ${produtoId}` +
            (linkDocId === null ? '.' : ` sob o vínculo ${linkDocId}.`),
          code: CODIGO_ANUNCIO_SEM_VINCULO,
        },
        { status: 404 },
      );
    }

    if (res.acao === ACAO_REVERIFICACAO.ignoradoSemItemId) {
      // 409 and not 404: the vínculo exists, so the request addressed something
      // real — it simply has no listing yet, and there is nothing to re-verify
      // until `publicar` has run. The link doc id is echoed so the caller can
      // hand it straight to that route.
      return NextResponse.json(
        {
          error: `O vínculo ${res.linkDocId} do produto ${produtoId} ainda não foi publicado na Shopee.`,
          code: CODIGO_ANUNCIO_NAO_PUBLICADO,
          linkDocId: res.linkDocId,
        },
        { status: 409 },
      );
    }

    // Built by NAME. `produtoId`, `linkDocId` and `itemId` are deliberately NOT
    // echoed on the 200: the first two are the caller's own request and the
    // third is an id the operator addresses listings by only through the link.
    //
    // `violacoes` rides the body as the ROW LIST, not a count, because that is
    // the whole point of a re-verify — the operator needs to read what Shopee
    // objects to. The rows are `shopeeViolacaoSchema`-parsed and carry only the
    // eight modelled keys, so there is no unenumerated field to leak; the two
    // prose leaves are for an authenticated operator's eyes and never for a log.
    return NextResponse.json({
      acao: res.acao,
      estadoAnuncio: res.estadoAnuncio,
      itemStatus: res.itemStatus,
      deboost: res.deboost,
      violacoes: res.violacoes,
      violacoesLidas: res.violacoesLidas,
      modelos:
        res.modelos === null
          ? null
          : {
              total: res.modelos.total,
              atualizados: res.modelos.atualizados,
              ausentes: res.modelos.ausentes,
            },
      avisoResolvido: res.avisoResolvido,
      chamadasShopee: res.chamadasShopee,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

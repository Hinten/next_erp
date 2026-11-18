/**
 * `GET /api/marketplace/shopee/canais?integracaoId=&produtoId=[&linkDocId=]` (#1911 P15) —
 * the shop's logistics channels for ONE produto, each with the PUBLISHER's own
 * verdict (`avaliarCanaisDaLojaShopee`, `lib/shopee/anuncios/logisticaPublicacao.ts`),
 * for the draft editor's Logística section (P16). Depth:
 * `lib/shopee/anuncios/README.md`, the logistics section.
 *
 * ⚠️ **NOT a draft route.** `PERM.integracao.read`, zero Firestore writes, and
 * ONE uncached `get_channel_list` per request — a stale list would offer a
 * channel the shop closed minutes ago, and publish reads it uncached for the
 * same reason. The three draft routes (`rascunho/**`) still make zero Shopee
 * calls; this one is the read beside them.
 *
 * ## The ladder
 *
 * `verifyCaller(PERM.integracao.read)` → `integracaoId` (400) → `produtoId`
 * (400: absent or blank — trimmed, like every free-text parameter here — then
 * `MSG_PRODUTO_ID_INVALIDO` when it is not a document id) → the conta's shop
 * client (404/409 through `shopeeErrorResponse`, before any Shopee call and
 * before the produto read) → the produto by id (404 with OUR sentence, ZERO
 * Shopee calls) → the channels (a Shopee failure through
 * `shopeeErrorResponse`, 502 with its `kind`) → 200.
 *
 * The 200 is built `satisfies z.input<typeof respostaCanaisShopeeSchema>` —
 * the ONE envelope in `@delfrance/schemas` that `apps/web` parses with (#1369),
 * rows in `get_channel_list` order. The fit is judged against the STORED
 * produto (`anuncios/canaisDoRascunho.ts`), exactly what a publish would read.
 *
 * `linkDocId` is OPTIONAL (a PUBLISHED listing's editor): when present (not
 * blank) it must be a document id (400), and after the produto read that
 * produto's `prodshopee` link is read — absent or another conta's ⇒ 404 with
 * OUR sentence, still ZERO Shopee calls. The listing's stored size/fee then
 * feed each channel's verdict (see `anuncios/canaisDoRascunho.ts`). Without it
 * the answer is the draft editor's, byte for byte; the envelope is unchanged.
 *
 * ⚠️ `integracaoId` is not doc-id-checked, as on the seven taxonomy routes —
 * a residual of the shared reader, not widened here.
 *
 * ⚠️ **Never cached** — `Cache-Control: no-store` on EVERY answer, errors
 * included. Anything that is not a Shopee error rethrows (root CLAUDE.md
 * rule 6).
 */
import { NextResponse } from 'next/server';
import type { respostaCanaisShopeeSchema } from '@delfrance/schemas';
import type { z } from 'zod';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerCanaisDoRascunhoShopee } from '@/lib/shopee/anuncios/canaisDoRascunho';
import { MSG_PRODUTO_ID_INVALIDO, naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import {
  lerIntegracaoId,
  lerTextoObrigatorio,
  lerTextoOpcional,
} from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function responder(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const produtoId = lerTextoObrigatorio(params, 'produtoId');
  if (!produtoId.ok) return NextResponse.json({ error: produtoId.erro }, { status: 400 });
  if (naoDocId(produtoId.valor)) {
    return NextResponse.json({ error: MSG_PRODUTO_ID_INVALIDO }, { status: 400 });
  }

  const linkDocId = lerTextoOpcional(params, 'linkDocId');
  if (!linkDocId.ok) return NextResponse.json({ error: linkDocId.erro }, { status: 400 });
  if (linkDocId.valor !== null && naoDocId(linkDocId.valor)) {
    return NextResponse.json(
      { error: 'linkDocId deve ser um id de documento (sem "/" nem "..").' },
      { status: 400 },
    );
  }

  try {
    const db = getAdminFirestore();
    const client = (await loadShopeeContext(db, integracaoId.valor)).createShopClient();
    const lido = await lerCanaisDoRascunhoShopee(
      { db, client },
      linkDocId.valor === null
        ? { produtoId: produtoId.valor }
        : {
            produtoId: produtoId.valor,
            linkDocId: linkDocId.valor,
            integracaoId: integracaoId.valor,
          },
    );
    if (lido.tipo === 'produto-inexistente') {
      return NextResponse.json(
        { error: `Produto ${produtoId.valor} não encontrado.` },
        { status: 404 },
      );
    }
    if (lido.tipo === 'vinculo-inexistente') {
      return NextResponse.json(
        { error: `Vínculo ${linkDocId.valor ?? ''} não encontrado neste produto.` },
        { status: 404 },
      );
    }
    return NextResponse.json({
      medidasCompletas: lido.resposta.medidasCompletas,
      canais: lido.resposta.canais,
    } satisfies z.input<typeof respostaCanaisShopeeSchema>);
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const res = await responder(req);
  // EVERY answer — a cached 200 would offer a channel the shop has since
  // closed, and a cached 404 or 502 would outlive the state it describes.
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

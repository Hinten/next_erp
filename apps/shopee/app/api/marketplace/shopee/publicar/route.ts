/**
 * `POST /api/marketplace/shopee/publicar` — publish (or re-publish) ONE ERP
 * produto as a Shopee listing. Body:
 * `{ integracaoId, produtoId, linkDocId?, status?, categoryId? }`. Requires
 * `PERM.integracao.write`.
 *
 * SYNCHRONOUS by design, exactly as `importar` is: the unit of work is ONE
 * produto, the call budget is bounded by the plan, and the acceptance the
 * operator needs is the listing's own read-back — not a job id to poll.
 *
 * ## ⚠️ This route is the composition root, and it owns three things the
 * `anuncios/` folder deliberately cannot build
 *
 *  - **the clock.** ONE `Date.now()`, handed down as `deps.nowMs`, so every
 *    document written by one publish agrees about when it happened. No module
 *    under `anuncios/` reads a clock at all.
 *  - **the wait.** `add_item` needs a settle window before the model leg, and
 *    the folder constructs no timer: the promise is built here and injected.
 *  - **the partner client.** `upload_image` is Public-signed, so the photo unit
 *    receives a bound FUNCTION over a client this route supplies as a factory.
 *
 * ## Outcomes
 *
 * 200 with the publish summary, built BY NAME · 400 for a bad body ·
 * 404 `SHOPEE_ANUNCIO_NAO_ENCONTRADO` when the produto does not exist or the
 * named `linkDocId` is not this conta's · everything else goes to
 * `shopeeErrorResponse`, which holds the two per-produto publish arms (a
 * refusal decided BEFORE anything was sent, and one Shopee itself returned)
 * above its base arm. Re-mapping either of them here would be a second copy of
 * a decision that already has one home, and below that base arm the operator
 * would be told OUR service failed instead of which field was refused.
 */
import { NextResponse } from 'next/server';
import { createShopeePartnerClient } from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerCorpoPublicar } from '@/lib/shopee/anuncios/corpoPublicacao';
import {
  publicarAnuncioShopee,
  type PublicarAnuncioDeps,
} from '@/lib/shopee/anuncios/publicarAnuncio';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { criarMemoDeCategorias } from '@/lib/shopee/produtos/categoriaShopee';
import { corpoDeErro, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';
import { taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The 404 body: a produto with nothing to publish onto under this conta. */
export const CODIGO_ANUNCIO_NAO_ENCONTRADO = 'SHOPEE_ANUNCIO_NAO_ENCONTRADO';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = lerCorpoPublicar(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErro(corpo), { status: 400 });
  const { integracaoId, produtoId, linkDocId, status, categoryId } = corpo.valor;

  // ⚠️ ONE clock read for the whole request, handed DOWN — `importar`'s own
  // rule. Two documents written by one publish can never disagree about when it
  // happened, and no module under `anuncios/` can read a second instant.
  const nowMs = Date.now();

  try {
    const db = getAdminFirestore();
    const ctx = await loadShopeeContext(db, integracaoId);
    // ONE shop-signed client per request: `taxonomiaCtx` builds it and the
    // publisher reuses THAT one, so the taxonomy reads and the write calls
    // cannot end up signed by two different clients.
    const taxonomia = taxonomiaCtx(ctx);
    const client = taxonomia.client;

    const deps: PublicarAnuncioDeps = {
      db,
      client,
      // C8: the PARTNER client as a factory, and the only thing it is used for
      // is binding the Public-signed `upload_image`. It is lazy, so a publish
      // that refuses before any picture never constructs one.
      partnerClient: () =>
        createShopeePartnerClient({
          partnerId: ctx.config.partnerId,
          partnerKey: ctx.config.partnerKey,
          hosts: ctx.config.hosts,
        }),
      integracaoId: ctx.integracaoId,
      tabelaNormalOuterRef: ctx.conta.tabelaNormalOuterRef,
      depositoOuterRef: ctx.conta.depositoOuterRef,
      operacaoOuterRef: ctx.conta.operacaoOuterRef,
      nowMs,
      // The folder's ONE wait, supplied here: `anuncios/` constructs no timer,
      // which is what keeps every module in it drivable without a fake clock.
      esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      taxonomia,
      categorias: criarMemoDeCategorias(client, ctx.integracaoId),
    };
    // ⚠️ `hostEmulador` is deliberately OMITTED rather than passed as null:
    // nothing in this app writes an emulator-hosted `arquivo.url`, so there is
    // no value to read, and an explicit key would imply a source that does not
    // exist.

    const res = await publicarAnuncioShopee(deps, {
      produtoId,
      linkDocId,
      // C36: the operator's explicit choice. The publisher uses it ONLY when the
      // resolved link has no `category_id`; it never overrides a stored one.
      categoryId,
      statusPedido: status,
    });

    if (res === null) {
      return NextResponse.json(
        {
          error:
            `Nenhum anúncio desta conta para o produto ${produtoId}` +
            (linkDocId === null ? '.' : ` sob o vínculo ${linkDocId}.`),
          code: CODIGO_ANUNCIO_NAO_ENCONTRADO,
        },
        { status: 404 },
      );
    }

    // Built by NAME, never spread. The result type is ours and carries the whole
    // plan plus every diagnostic the CLI prints; echoing it would put the item
    // body, the description and every stored ref into an HTTP response nobody
    // reviewed — and would keep doing it for each field a later wave adds.
    //
    // `modelos.semFilho` and `fotos.falhas` are COUNTS here: this object is a
    // summary of four numbers beside three, and the per-row detail (which model
    // binds nothing, which picture refused and why) rides the log line and the
    // rehearsal CLI, which is where an operator acts on it.
    return NextResponse.json({
      itemId: res.itemId,
      estadoAnuncio: res.estadoAnuncio,
      itemStatus: res.itemStatus,
      modelos: {
        total: res.modelos.total,
        criados: res.modelos.criados,
        atualizados: res.modelos.atualizados,
        semFilho: res.modelos.semFilho.length,
      },
      fotos: {
        reutilizadas: res.fotos.reutilizadas,
        enviadas: res.fotos.enviadas,
        falhas: res.fotos.falhas,
      },
      avisoShopee: res.avisoShopee,
      taxInfoOmitido: res.taxInfoOmitido,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

/**
 * `POST /api/marketplace/shopee/publicar` — publish (or re-publish) ONE ERP
 * produto as a Shopee listing. Body:
 * `{ integracaoId, produtoId, linkDocId?, status?, categoryId?, principal?,
 * recriar?, converterEmKit? }`. Requires `PERM.integracao.write`.
 *
 * Since step 19 (#1527) the produto may publish as a NATIVE Shopee kit. The
 * route does not decide that: `publicarShopee` (`anuncios/publicarShopee.ts`)
 * reads the produto and this conta's links once and the dispatcher
 * (`kits/armaDePublicacao.ts`) picks the arm — step 11's item publish, or the
 * kit create / republish / recreate (`recriar`, which always names its
 * `linkDocId`) / conversion of an ordinary listing (`converterEmKit`). The three
 * kit fields are the operator's (L1, L4(4), L8); `principal` names the kit's
 * main component by ERP produto id. `status: 'UNLIST'` is USED by a kit
 * CREATE — criar, recriar and converter send `add_kit_item` with
 * `item_setting.unlisted: true` (OP-9, register 305) — and ignored by a kit
 * republish; a recriar never deletes a kit on sale for a paused one
 * (`kit-novo-inativo`).
 *
 * SYNCHRONOUS by design, exactly as `importar` is: the unit of work is ONE
 * produto, the call budget is bounded by the plan, and the acceptance the
 * operator needs is the listing's own read-back — not a job id to poll.
 *
 * ## ⚠️ This route is the composition root, and it owns four things the
 * `anuncios/` and `kits/` folders deliberately cannot build
 *
 *  - **the clock.** ONE `Date.now()`, handed down as `deps.nowMs`, so every
 *    document written by one publish agrees about when it happened. No module
 *    under `anuncios/` reads a clock at all.
 *  - **the wait.** `add_item` needs a settle window before the model leg, and
 *    the folder constructs no timer: the promise is built here and injected.
 *  - **the partner client.** `upload_image` is Public-signed, so the photo unit
 *    receives a bound FUNCTION over a client this route supplies as a factory.
 *  - **the aviso counter.** A kit run re-decides the recipe aviso (L4), which
 *    can RAISE it: `FieldValue.increment`, wired here as `deps.increment`.
 *
 * ## Outcomes
 *
 * 200 with the publish summary, built BY NAME — step 11's for the item arm, the
 * kit summary for a kit arm · **202** for a kit create whose outcome Shopee left
 * UNCERTAIN (`desfecho: 'incerto'`): NOTHING was written, and the body carries
 * Shopee's refusal (`recusa`), the sentence `MENSAGEM_KIT_INCERTO` and the exact
 * command to re-run (`comando`) · 400 for a bad body (both kit actions at once,
 * or `recriar` with no `linkDocId`, included) · 404
 * `SHOPEE_ANUNCIO_NAO_ENCONTRADO` when the produto does not exist or the named
 * `linkDocId` is not this conta's · everything else goes to
 * `shopeeErrorResponse`, which holds the two per-produto publish arms (a
 * refusal decided BEFORE anything was sent — the dispatcher's own included —
 * and one Shopee itself returned, a kit create Shopee refused at etapa
 * `add_kit_item` included) above its base arm. Re-mapping either of them here
 * would be a second copy of a decision that already has one home, and below
 * that base arm the operator would be told OUR service failed instead of which
 * field was refused.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { createShopeePartnerClient } from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerCorpoPublicar } from '@/lib/shopee/anuncios/corpoPublicacao';
import type { ResultadoPublicacao } from '@/lib/shopee/anuncios/publicarAnuncio';
import { publicarShopee } from '@/lib/shopee/anuncios/publicarShopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import {
  MENSAGEM_KIT_INCERTO,
  type KitDeps,
  type ResultadoPublicacaoKit,
} from '@/lib/shopee/kits/resultadoKit';
import { criarMemoDeCategorias } from '@/lib/shopee/produtos/categoriaShopee';
import { corpoDeErro, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';
import { taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The 404 body: a produto with nothing to publish onto under this conta. */
export const CODIGO_ANUNCIO_NAO_ENCONTRADO = 'SHOPEE_ANUNCIO_NAO_ENCONTRADO';

/**
 * Step 11's summary, built BY NAME, never spread. The result type is ours and
 * carries the whole plan plus every diagnostic the CLI prints; echoing it would
 * put the item body, the description and every stored ref into an HTTP
 * response nobody reviewed — and would keep doing it for each field a later
 * wave adds.
 *
 * `modelos.semFilho` and `fotos.falhas` are COUNTS here: this object is a
 * summary of four numbers beside three, and the per-row detail (which model
 * binds nothing, which picture refused and why) rides the log line and the
 * rehearsal CLI, which is where an operator acts on it.
 */
function corpoDoItem(res: ResultadoPublicacao) {
  return {
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
    // Step 18: by NAME as well. The read-back echo (`lidaDeVolta`,
    // `fotoLidaDeVolta`) is a diagnostic for the log and the CLI, not an
    // answer the operator acts on, so it stays out of this body.
    tabelaDeMedidas: {
      sizeChartId: res.tabelaDeMedidas.sizeChartId,
      fonte: res.tabelaDeMedidas.fonte,
      motivo: res.tabelaDeMedidas.motivo,
      fotoOmitida: res.tabelaDeMedidas.fotoOmitida,
      avisoObrigatoria: res.tabelaDeMedidas.avisoObrigatoria,
    },
  };
}

/**
 * The native-kit summary (step 19), BY NAME for the same reason: every field is
 * named, the sub-objects too. A warning travels as its CODE and the produto it
 * is about — the pt-BR sentence is the CLI's and the log's, and a code is what a
 * UI keys on.
 */
function corpoDoKit(res: ResultadoPublicacaoKit) {
  return {
    arma: res.arma,
    desfecho: res.desfecho,
    itemId: res.itemId,
    linkDocId: res.linkDocId,
    estadoAnuncio: res.estadoAnuncio,
    itemStatus: res.itemStatus,
    kitNativo: res.kitNativo,
    modelos: {
      vinculados: res.modelos.vinculados,
      anexados: res.modelos.anexados,
      semFilho: res.modelos.semFilho,
    },
    antecessor:
      res.antecessor === null
        ? null
        : {
            itemId: res.antecessor.itemId,
            linkDocId: res.antecessor.linkDocId,
            excluido: res.antecessor.excluido,
            substituido: res.antecessor.substituido,
          },
    avisos: res.avisos.map((a) => ({ codigo: a.codigo, produtoId: a.produtoId })),
    avisosResolvidos: res.avisosResolvidos,
    recusa:
      res.recusa === null
        ? null
        : {
            codigo: res.recusa.codigo,
            fraseShopee: res.recusa.fraseShopee,
            motivo: res.recusa.motivo,
          },
    comando: res.comando,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = lerCorpoPublicar(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErro(corpo), { status: 400 });
  const { integracaoId, produtoId, linkDocId, status, categoryId, principal, recriar } =
    corpo.valor;
  const { converterEmKit } = corpo.valor;

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

    const deps: KitDeps = {
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
      // Step 19: the aviso counter a kit run's recipe-aviso decision raises
      // through (L4); `kits/` builds no Firestore sentinel of its own.
      increment: (n: number) => FieldValue.increment(n),
    };
    // ⚠️ `hostEmulador` is deliberately OMITTED rather than passed as null:
    // nothing in this app writes an emulator-hosted `arquivo.url`, so there is
    // no value to read, and an explicit key would imply a source that does not
    // exist.

    const res = await publicarShopee(deps, {
      produtoId,
      linkDocId,
      // C36: the operator's explicit choice. The publisher uses it ONLY when the
      // resolved link has no `category_id`; it never overrides a stored one.
      categoryId,
      statusPedido: status,
      principal,
      recriar,
      converterEmKit,
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

    if (res.tipo === 'item') return NextResponse.json(corpoDoItem(res.resultado));

    const kit = corpoDoKit(res.resultado);
    if (res.resultado.desfecho === 'incerto') {
      // Accepted, not done: Shopee may or may not have created the kit, and
      // NOTHING was written. The operator waits and re-runs EXACTLY `comando`
      // (S1F-03) — a plain publish would be a different arm after a recriar or
      // a converter.
      return NextResponse.json({ ...kit, mensagem: MENSAGEM_KIT_INCERTO }, { status: 202 });
    }
    return NextResponse.json(kit);
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

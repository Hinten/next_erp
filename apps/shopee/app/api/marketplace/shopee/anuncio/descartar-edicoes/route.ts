/**
 * `POST /api/marketplace/shopee/anuncio/descartar-edicoes` — discard the ERP
 * edits saved on ONE published Shopee listing and reload Shopee's current
 * content into its `prodshopee` link. Body (`corpoDescartarEdicoesAnuncioShopeeSchema`,
 * STRICT): `{ integracaoId, produtoId, linkDocId, revisao }`. Requires
 * `PERM.integracao.write`. The decisions are
 * `anuncios/descartarEdicoes.ts`'s.
 *
 * The route owns the caller check, the STRICT body parse (the `error` is Zod's
 * own rendering — paths and the schema's sentences, never a value), the CLOCK
 * (ONE `Date.now()`, handed down as `nowMs`) and the HTTP shape, built BY NAME.
 *
 * ⚠️ ZERO Shopee calls before the gate passes: the conta context is loaded
 * LAZILY, inside `deps.lerAnuncio`, so a refused request (404 / 409, or nothing
 * pending) never loads a credential nor signs a call.
 *
 * ## Outcomes
 *
 * **200** `{linkDocId, descartado}` — `false` when nothing was pending · 400 a
 * malformed body · 401/403 · 404 `INEXISTENTE` · 409 `ANUNCIO_NAO_EDITAVEL`,
 * `CONFLITO {conflitos: []}` (a stale `revisao`, or concurrent writes won every
 * attempt) · Shopee's own errors through `shopeeErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  corpoDescartarEdicoesAnuncioShopeeSchema,
  type respostaDescartarEdicoesAnuncioShopeeSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { descartarEdicoesDoAnuncioShopee } from '@/lib/shopee/anuncios/descartarEdicoes';
import {
  RecusaDeRascunhoShopeeError,
  corpoDaRecusaDeRascunhoShopee,
} from '@/lib/shopee/anuncios/rascunho';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { corpoDeErro, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';
import { lerAnuncioShopee } from '@/lib/shopee/produtos/lerAnuncio';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = corpoDescartarEdicoesAnuncioShopeeSchema.safeParse(json.valor);
  if (!corpo.success) {
    return NextResponse.json({ error: z.prettifyError(corpo.error) }, { status: 400 });
  }

  // ⚠️ ONE clock read for the whole request, handed DOWN as `nowMs`.
  const nowMs = Date.now();
  const db = getAdminFirestore();
  const { integracaoId } = corpo.data;

  try {
    const res = await descartarEdicoesDoAnuncioShopee(
      {
        db,
        nowMs,
        // Lazy: the context (credential, client) exists only once the gate passed.
        lerAnuncio: async (itemId) => {
          const ctx = await loadShopeeContext(db, integracaoId);
          return lerAnuncioShopee(ctx.createShopClient(), itemId);
        },
      },
      corpo.data,
    );
    return NextResponse.json({
      linkDocId: res.linkDocId,
      descartado: res.descartado,
    } satisfies z.input<typeof respostaDescartarEdicoesAnuncioShopeeSchema>);
  } catch (err) {
    // ⚠️ BEFORE `isShopeeError`: a refusal is OUR answer, never Shopee's.
    if (err instanceof RecusaDeRascunhoShopeeError) {
      return NextResponse.json(corpoDaRecusaDeRascunhoShopee(err), { status: err.status });
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

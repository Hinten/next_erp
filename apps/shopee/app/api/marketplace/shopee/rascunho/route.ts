/**
 * `POST /api/marketplace/shopee/rascunho` — create ONE Shopee listing DRAFT
 * (#1911, P4 — D1, D2, D15). Body (`corpoCriarRascunhoShopeeSchema`, STRICT):
 * `{ integracaoId, produtoId, linkDocId, conteudo?, confirmarSegundoAnuncio? }`.
 * Requires `PERM.integracao.write` (D6: the produto's tab also asks for
 * `produto.write`; this route enforces the integração bit, like every other
 * write of this app).
 *
 * The draft IS the produto's `prodshopee` document with `item_id: null` (D2),
 * created at the id the CLIENT generated — Firestore's 20-character auto-id
 * shape, never a native kit's 64-hex link id — so a double click, or a retry
 * whose first answer was lost, lands on the SAME document instead of minting a
 * second draft (rule 7 tier 0: `create()` makes the race impossible).
 *
 * ## ⚠️ This route decides NOTHING about the draft
 *
 * Every rule — the conta and produto checks, the second-listing guard, the
 * defaults, the `ALREADY_EXISTS` reading — is `anuncios/rascunho.ts`'s, shared
 * with the two sibling draft routes. The route owns four things only:
 *
 *  - **the caller** — `verifyCaller` with `integracao.write`;
 *  - **the STRICT body parse** — an unknown key (`item_id` included) is a 400,
 *    never silently dropped, so a web deployed before this app fails loudly;
 *    the 400's `error` is Zod's own rendering of the issues (paths and the
 *    schema's sentences, never a value of the body);
 *  - **the clock** — ONE `Date.now()`, handed down as `nowMs` (the draft's
 *    `dataCadastro` and `ultimaModificacao`); no module under `anuncios/`
 *    reads one;
 *  - **the HTTP shape** — every body built BY NAME, a refusal through
 *    `corpoDaRecusaDeRascunhoShopee`.
 *
 * ZERO Shopee calls: the leaf gate, the bands and the brand are publish's.
 *
 * ## Outcomes
 *
 * **201** `{linkDocId, criado: true}` — created now · **200** `{linkDocId,
 * criado: false}` — the draft already existed for this conta and produto
 * holding exactly what THIS create would write (K1-9: every projected field;
 * a key the retry omits is the `null` — or the produto's `nome` — it would
 * write, never a wildcard) · 400 a malformed body, or a produto with no usable
 * name and no `item_name` · 401/403 the caller · 404 the conta is absent or not
 * a Shopee one (`ShopeeContaNotConfiguredError`, `shopeeErrorResponse`'s
 * answer), or the produto does not exist (`INEXISTENTE`) · 409
 * `CONTA_JA_TEM_ANUNCIO {vinculos}` (D15, without `confirmarSegundoAnuncio:
 * true`), `CONFLITO {conflitos}` (the same draft with OTHER content),
 * `ID_EM_USO` (the id holds something that is not this conta's draft) · 422
 * `PRODUTO_INVALIDO {motivo}` (a variation child, a virtual kit). Every code
 * is `CODIGO_RASCUNHO_SHOPEE`'s (`@delfrance/schemas`), the vocabulary the web
 * reads.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  corpoCriarRascunhoShopeeSchema,
  type respostaCriarRascunhoShopeeSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  RecusaDeRascunhoShopeeError,
  corpoDaRecusaDeRascunhoShopee,
  criarRascunhoShopee,
} from '@/lib/shopee/anuncios/rascunho';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { corpoDeErro, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = corpoCriarRascunhoShopeeSchema.safeParse(json.valor);
  if (!corpo.success) {
    return NextResponse.json({ error: z.prettifyError(corpo.error) }, { status: 400 });
  }

  // ⚠️ ONE clock read for the whole request, handed DOWN as `nowMs`.
  const nowMs = Date.now();

  try {
    const res = await criarRascunhoShopee({ db: getAdminFirestore(), nowMs }, corpo.data);
    // BY NAME: 201 only for a draft created NOW; the same draft, same content,
    // already there is a 200 — the web reads both as "saved".
    return NextResponse.json(
      { linkDocId: res.linkDocId, criado: res.criado } satisfies z.input<
        typeof respostaCriarRascunhoShopeeSchema
      >,
      { status: res.criado ? 201 : 200 },
    );
  } catch (err) {
    // ⚠️ BEFORE `isShopeeError`: a draft refusal is OUR answer, never Shopee's.
    if (err instanceof RecusaDeRascunhoShopeeError) {
      return NextResponse.json(corpoDaRecusaDeRascunhoShopee(err), { status: err.status });
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

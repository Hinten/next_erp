/**
 * `POST /api/marketplace/shopee/rascunho/descartar` — discard ONE Shopee
 * listing DRAFT (#1911, P4 — D18). Body (`corpoDescartarRascunhoShopeeSchema`,
 * STRICT): `{ integracaoId, produtoId, linkDocId, base,
 * confirmarCriacaoIncerta? }`. Requires `PERM.integracao.write`.
 *
 * ⚠️ The ONE `prodshopee` delete in this app (`lib/shopee/produtos/links.ts`
 * names the exception). `anuncios/rascunho.ts` deletes only a DRAFT, only with
 * the snapshot's `lastUpdateTime` precondition (rule 7 tier 1, re-deciding on
 * a loss), and only when
 *
 *  - no publish holds its lock (live, or inside the post-expiry grace);
 *  - the stored draft is what the operator SAW — `base` carries EVERY
 *    projected field (K1-13), so an edit made meanwhile in another tab is
 *    never thrown away unseen;
 *  - its last create is not `incerta`, unless the operator attests it did not
 *    reach Shopee (`confirmarCriacaoIncerta: true`, K1-6): the draft is the
 *    only record of that attempt.
 *
 * A publish whose create lands afterwards is not resurrected onto it — its
 * write-back `add`s a fresh link, so a listing is never orphaned.
 *
 * The route owns the caller check, the STRICT body parse (the `error` is Zod's
 * own rendering — paths and the schema's sentences, never a value), the CLOCK
 * (ONE `Date.now()`, handed down as `nowMs` — the instant the lock is read at)
 * and the HTTP shape, built BY NAME. ZERO Shopee calls.
 *
 * ## Outcomes
 *
 * **200** `{linkDocId, descartado: true, criacaoIncerta}` — `true` when the
 * draft discarded was `incerta` (if the listing appears after all, it is
 * imported, never re-created) · 400 a malformed body (a `base` missing a
 * field, a non-boolean attestation, an unknown key) · 401/403 · 404
 * `INEXISTENTE` · 409 `JA_PUBLICADO {linkDocId}` (a listing is never deleted
 * here), `EM_ANDAMENTO {aguardarMs}`, `CONFLITO {conflitos}`,
 * `CRIACAO_INCERTA`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  corpoDescartarRascunhoShopeeSchema,
  type respostaDescartarRascunhoShopeeSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  RecusaDeRascunhoShopeeError,
  corpoDaRecusaDeRascunhoShopee,
  descartarRascunhoShopee,
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
  const corpo = corpoDescartarRascunhoShopeeSchema.safeParse(json.valor);
  if (!corpo.success) {
    return NextResponse.json({ error: z.prettifyError(corpo.error) }, { status: 400 });
  }

  // ⚠️ ONE clock read for the whole request, handed DOWN as `nowMs`.
  const nowMs = Date.now();

  try {
    const res = await descartarRascunhoShopee({ db: getAdminFirestore(), nowMs }, corpo.data);
    return NextResponse.json({
      linkDocId: res.linkDocId,
      descartado: res.descartado,
      criacaoIncerta: res.criacaoIncerta,
    } satisfies z.input<typeof respostaDescartarRascunhoShopeeSchema>);
  } catch (err) {
    // ⚠️ BEFORE `isShopeeError`: a draft refusal is OUR answer, never Shopee's.
    if (err instanceof RecusaDeRascunhoShopeeError) {
      return NextResponse.json(corpoDaRecusaDeRascunhoShopee(err), { status: err.status });
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

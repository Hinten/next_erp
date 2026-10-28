/**
 * `POST /api/marketplace/shopee/rascunho/atualizar` — edit ONE Shopee listing
 * DRAFT (#1911, P4 — D1, D4, D8). Body (`corpoAtualizarRascunhoShopeeSchema`,
 * STRICT): `{ integracaoId, produtoId, linkDocId, base, patch }`. Requires
 * `PERM.integracao.write`.
 *
 * `patch` is the write, through the draft whitelist (normalised); `base` is
 * what the operator SAW for exactly the fields `camposDaBaseDoRascunhoShopee(patch)`
 * names — `patch`'s, PLUS `attributes` whenever the patch NAMES `category_id`
 * without them (even unchanged), because a category change clears the stored
 * attributes (K1-12, P6) —
 * parsed by the TOLERANT `baseRascunhoShopeeSchema`: verbatim, never
 * normalised (K2-4), so a legacy `''` or an absent title stays editable. `anuncios/rascunho.ts` compares
 * `base` against the stored draft through `@delfrance/schemas`' ONE projection
 * and its CONFLICT compare before it writes (rule 7 tier 3: an operator who lost the
 * race is TOLD, never silently overwritten), then writes with the snapshot's
 * `lastUpdateTime` precondition (tier 1), re-deciding on a loss.
 *
 * The route owns the caller check, the STRICT body parse (an unknown key is a
 * 400; the `error` is Zod's own rendering — paths and the schema's sentences,
 * never a value), the CLOCK (ONE `Date.now()`, handed down as `nowMs`: it
 * measures a live lock's wait and stamps `ultimaModificacao`) and the HTTP
 * shape, built BY NAME. Every decision is `rascunho.ts`'s. ZERO Shopee calls;
 * an edit never writes the publish lock.
 *
 * ## Outcomes
 *
 * **200** `{linkDocId, gravados}` — the fields written, canonical order; `[]`
 * = the patch equals what is stored (the WRITE compare: a brand as its id AND
 * name) and NOTHING was written; a category change that clears the stored
 * attributes also lists `attributes` · 400 a malformed body (an unknown key,
 * an empty `patch`, a `base` that does not name exactly `patch`'s fields — plus
 * `attributes` beside a `category_id` patch without them,
 * `MSG_BASE_SEM_ATRIBUTOS_NA_TROCA_DE_CATEGORIA_RASCUNHO_SHOPEE`) · 401/403 ·
 * 404 `INEXISTENTE` (no such draft, or another
 * conta's) · 409 `JA_PUBLICADO {linkDocId}` (a listing exists — D8),
 * `EM_ANDAMENTO {aguardarMs}` (a publish holds the lock, its post-expiry grace
 * included), `CATEGORIA_TRAVADA` (a patch NAMING `category_id` — even the
 * stored value — while the last create is `incerta`: it may have made the
 * listing in the stored category),
 * `CONFLITO {conflitos}` (a stored value is not the operator's `base`; `[]`
 * when the write lost its precondition on every attempt).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  corpoAtualizarRascunhoShopeeSchema,
  type respostaAtualizarRascunhoShopeeSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  RecusaDeRascunhoShopeeError,
  atualizarRascunhoShopee,
  corpoDaRecusaDeRascunhoShopee,
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
  const corpo = corpoAtualizarRascunhoShopeeSchema.safeParse(json.valor);
  if (!corpo.success) {
    return NextResponse.json({ error: z.prettifyError(corpo.error) }, { status: 400 });
  }

  // ⚠️ ONE clock read for the whole request, handed DOWN as `nowMs`: every
  // re-derive after a lost precondition judges the lock at the same instant.
  const nowMs = Date.now();

  try {
    const res = await atualizarRascunhoShopee({ db: getAdminFirestore(), nowMs }, corpo.data);
    return NextResponse.json({
      linkDocId: res.linkDocId,
      gravados: [...res.gravados],
    } satisfies z.input<typeof respostaAtualizarRascunhoShopeeSchema>);
  } catch (err) {
    // ⚠️ BEFORE `isShopeeError`: a draft refusal is OUR answer, never Shopee's.
    if (err instanceof RecusaDeRascunhoShopeeError) {
      return NextResponse.json(corpoDaRecusaDeRascunhoShopee(err), { status: err.status });
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

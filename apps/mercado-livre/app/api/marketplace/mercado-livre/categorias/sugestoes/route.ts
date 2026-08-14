/**
 * `GET /api/marketplace/mercado-livre/categorias/sugestoes?integracaoId=&q=[&limit=]`
 *
 * ML's category suggestions for a product title
 * (`GET /sites/MLB/domain_discovery/search`). This route OFFERS them — it
 * writes nothing and picks nothing.
 *
 * That is the whole point of #799. Publish used to call
 * `suggestCategories(produto.nome, 1)` and apply `[0]` with no human in the
 * loop, so a wrong first hit only surfaced once the listing existed, in the
 * wrong category, on a live marketplace. The full ranked list comes back here
 * and a person chooses.
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import type { MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { getCategoriaCached, getSugestaoCategoriasCached } from '@/lib/marketplace/mlMetadataCache';
import {
  isMercadoLivreError,
  isMercadoLivreRequestError,
  mercadoLivreErrorResponse,
} from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ML's own picker shows a handful; more is noise and a bigger cache key space. */
const MAX_SUGESTOES = 8;
/** Below this a query is all noise — the legacy required a non-empty title. */
const MIN_QUERY_LENGTH = 2;

interface SugestaoWire {
  category_id: string;
  category_name?: string | null;
  domain_id?: string | null;
  domain_name?: string | null;
}

/**
 * The ancestor trail for one suggestion, root-first.
 *
 * ⚠️ **`domain_discovery/search` does not return a path** — only
 * `category_name`, which is the LEAF name. That is a real usability bug and not
 * a cosmetic one: ML files "Camisetas e Regatas" under several different
 * parents (men's, women's, kids', and more), so a five-row suggestion list
 * renders as the same label five times over, distinguishable only by an opaque
 * `MLB…` id. The path is the only thing that tells them apart.
 *
 * One `GET /categories/{id}` per suggestion, all through `getCategoriaCached`:
 * ML category metadata is **global**, not per-seller, so every account shares one
 * cache entry, sibling suggestions share ancestors, and the cascade the operator
 * then walks hits the same entries — and the cache dedups in-flight duplicates
 * for free. The caller bounds how many of these run; see `GET` below.
 *
 * Returns `null` rather than throwing, but only for a failure scoped to THIS
 * read. A suggestion whose path could not be resolved is still selectable and
 * still better than nothing — degrading one row to its leaf name beats failing
 * the whole list over a metadata read.
 */
async function resolvePathFromRoot(
  api: MercadoLivreApi,
  categoryId: string,
): Promise<Array<{ id: string; name: string | null }> | null> {
  try {
    const node = await getCategoriaCached(api, categoryId);
    const path = node.path_from_root ?? [];
    if (path.length === 0) return null;
    return path.map((c) => ({ id: c.id, name: c.name ?? null }));
  } catch (err) {
    // ⚠️ Narrowed to a REQUEST-scoped failure, not to `isMercadoLivreError`. A
    // 4xx/5xx/transport blip on one category is exactly what this degrades for;
    // an account-level error is not, because it hits every row identically. The
    // one that bites is a dead grant: `api.ts` maps a 401 onto
    // `MercadoLivreReauthRequiredError`, and the suggestion call above can be
    // served from `sugestaoCache` without touching ML, so a revoked token
    // surfaces HERE first. Swallowing it would turn the `409 ML_REAUTH_REQUIRED`
    // that tells the operator to reconnect into eight trail-less rows.
    if (!isMercadoLivreRequestError(err)) throw err;
    // Degrading is deliberate; doing it silently is not. A lost trail is
    // indistinguishable from ML genuinely having no path for the category, so
    // without this line the only symptom is a picker that quietly got worse and
    // nothing to grep in Cloud Logging. Same prefix as `logErrorResponse`.
    console.warn(`[mercado-livre/api] path_from_root indisponível para ${categoryId}:`, err);
    return null;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = params.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  const q = (params.get('q') ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `q deve ter ao menos ${MIN_QUERY_LENGTH} caracteres.` },
      { status: 400 },
    );
  }
  const rawLimit = Number(params.get('limit') ?? MAX_SUGESTOES);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_SUGESTOES)
    : MAX_SUGESTOES;

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const hits = (await getSugestaoCategoriasCached(api, q, limit)) as SugestaoWire[];
    const sugestoes = await Promise.all(
      // ⚠️ `limit` shapes the REQUEST; nothing clamps the response.
      // `domainDiscoverySchema` is an uncapped `z.array`, and neither the API
      // wrapper nor the cache re-clamps, so the length here is ML's to honour.
      // That was free while an over-long answer only meant a longer JSON array —
      // it now costs one `GET /categories/{id}` each, against a per-token rate
      // limit, on a path the operator hits once per product. The fan-out is
      // ours, so bound it here rather than trusting `limit` to have been obeyed.
      hits.slice(0, limit).map(async (h) => ({
        categoryId: h.category_id,
        categoryName: h.category_name ?? null,
        domainId: h.domain_id ?? null,
        domainName: h.domain_name ?? null,
        pathFromRoot: await resolvePathFromRoot(api, h.category_id),
      })),
    );
    return NextResponse.json({ sugestoes });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}

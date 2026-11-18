/**
 * `GET /api/marketplace/shopee/taxonomia/categorias/busca?integracaoId=&q=`
 *
 * The category picker's TEXT search: the categories of this conta's tree whose
 * own name holds every word of `q` (`buscarCategorias`, folded by
 * `correspondeABuscaShopee` from `@delfrance/schemas` — case and accents only),
 * each with its path from the root, leaves first, capped at
 * `SHOPEE_BUSCA_CATEGORIAS_LIMITE` with `truncated`.
 *
 * It answers from the SAME cached index the drill-down route reads
 * (`lerIndiceDeCategorias`), so a search costs no Shopee call on a warm cache
 * window and the whole tree still never crosses this wire — only the hits.
 *
 * `q` is trimmed and must be 2–100 characters (`lerConsultaDeBusca`), else a
 * pt-BR 400. An empty `resultados` is a real answer: nothing matched.
 *
 * The 200 is built `satisfies` the input type of its envelope,
 * `respostaBuscaCategoriasShopeeSchema`, declared once in `@delfrance/schemas`
 * for this route and its browser reader.
 *
 * Requires `PERM.integracao.read`. Reads only; writes nothing.
 */
import { NextResponse } from 'next/server';
import { termosDaBuscaShopee, type respostaBuscaCategoriasShopeeSchema } from '@delfrance/schemas';
import type { z } from 'zod';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { lerIndiceDeCategorias, taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { buscarCategorias } from '@/lib/shopee/taxonomia/categorias';
import { projetarCategoriaEncontrada } from '@/lib/shopee/taxonomia/dto';
import { lerConsultaDeBusca, lerIntegracaoId } from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const consulta = lerConsultaDeBusca(params);
  if (!consulta.ok) return NextResponse.json({ error: consulta.erro }, { status: 400 });

  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
    const indice = await lerIndiceDeCategorias(ctx);
    const { encontradas, truncada } = buscarCategorias(indice, termosDaBuscaShopee(consulta.valor));
    return NextResponse.json({
      resultados: encontradas.map((row) => projetarCategoriaEncontrada(indice, row)),
      truncated: truncada,
    } satisfies z.input<typeof respostaBuscaCategoriasShopeeSchema>);
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

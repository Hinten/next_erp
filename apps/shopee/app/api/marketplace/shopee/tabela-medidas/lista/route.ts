/**
 * `GET /api/marketplace/shopee/tabela-medidas/lista?integracaoId=&categoryId=`
 * (#1526, step 18) — the size-chart TEMPLATES this shop authored in Seller
 * Centre for one LEAF category, each with its name, for the `/medidas` Shopee
 * tab's picker. Depth: `lib/shopee/tabelaMedidas/README.md`.
 *
 * ## The ladder (the `taxonomia/variacoes` shape, in that order)
 *
 * `verifyCaller(PERM.integracao.read)` → `integracaoId` (400) → `categoryId`
 * (400; digits only, a positive safe integer, NOT trimmed) → the conta →
 * the THREE-valued leaf gate over this conta's cached tree:
 * - `desconhecida` ⇒ 404 `SHOPEE_CATEGORIA_DESCONHECIDA`, the `variacoes`
 *   body byte for byte (our tree does not know the id);
 * - `nao-folha` ⇒ 200 `leaf: false` with an empty list and ZERO
 *   `get_size_chart_list` calls — the picker only ever offers a leaf, and a
 *   legacy non-leaf entry is displayed off the stored entry, never by listing;
 * - `folha` ⇒ `listarTabelasDaCategoria` (the cursor walk and the width-4
 *   detail fan-out live there, and the cursor never crosses this boundary),
 *   answered BY NAME, never spread.
 *
 * ## Errors
 *
 * - A Shopee refusal (`ShopeeApiError` of kind `other`) that
 *   `classificarRecusaTabelaMedidas` reads as `categoria-invalida` ⇒ 404
 *   `SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA` with OUR sentence, which ends in
 *   the action ("escolha outra categoria" — the browser shows it verbatim, beside
 *   its "Trocar categoria" button): Shopee refused an id our (up to
 *   15-minute-stale) tree calls a leaf. DISTINCT from
 *   `SHOPEE_CATEGORIA_DESCONHECIDA`, which is our tree not knowing it.
 * - ⚠️ Kind `other` ONLY. A dead grant and a rate limit are `ShopeeApiError`s
 *   too, and each keeps `shopeeErrorResponse`'s answer (409 re-auth, 502 with
 *   `kind`) — read as a refusal, a dead grant would never tell the operator to
 *   reconnect.
 * - The other motivo (`tabela-inexistente`) is not this route's answer and
 *   falls through to the mapper with everything else; a rate limit stays the
 *   502 `SHOPEE_HTTP_ERROR` + `kind` every Shopee route answers (no in-band
 *   retry, no route-local 429). Anything that is not a Shopee error rethrows
 *   (rule 6).
 *
 * ⚠️ **Never cached** — `Cache-Control: no-store` on EVERY answer, errors
 * included: a template created in Seller Centre a minute ago must appear, and
 * a cached 404 would outlive the state it describes. Zero Firestore writes.
 *
 * Logs: `listarTabelasDaCategoria` writes the counts line of a healthy read;
 * this route adds one line per 404 — ids, the motivo and the code through
 * `codigoSeguro`, never Shopee's sentence.
 */
import { NextResponse } from 'next/server';
import { SHOPEE_ERROR_KIND, ShopeeApiError } from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { codigoSeguro } from '@/lib/shopee/nfe/redacaoNfe';
import type { ListaTabelasMedidasDto } from '@/lib/shopee/tabelaMedidas/dto';
import { listarTabelasDaCategoria } from '@/lib/shopee/tabelaMedidas/listarTabelasMedidas';
import {
  MOTIVO_RECUSA_TABELA_MEDIDAS,
  classificarRecusaTabelaMedidas,
} from '@/lib/shopee/tabelaMedidas/recusaTabelaMedidas';
import { lerIndiceDeCategorias, taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { ehFolha } from '@/lib/shopee/taxonomia/categorias';
import { lerCategoryIdObrigatorio, lerIntegracaoId } from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function responder(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const categoryId = lerCategoryIdObrigatorio(params);
  if (!categoryId.ok) return NextResponse.json({ error: categoryId.erro }, { status: 400 });

  const id = categoryId.valor;
  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
    const veredicto = ehFolha(await lerIndiceDeCategorias(ctx), id);

    if (veredicto === 'desconhecida') {
      return NextResponse.json(
        {
          error: `Categoria ${String(id)} não existe na árvore desta conta.`,
          code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
        },
        { status: 404 },
      );
    }
    if (veredicto === 'nao-folha') {
      const vazia: ListaTabelasMedidasDto = {
        leaf: false,
        categoryId: id,
        tabelas: [],
        totalCount: null,
        truncado: false,
        removidas: 0,
        idsIlegiveis: 0,
      };
      return NextResponse.json(vazia);
    }

    const lida = await listarTabelasDaCategoria({ client: ctx.client }, id);
    const corpo: ListaTabelasMedidasDto = {
      leaf: true,
      categoryId: lida.categoryId,
      tabelas: lida.tabelas,
      totalCount: lida.totalCount,
      truncado: lida.truncado,
      removidas: lida.removidas,
      idsIlegiveis: lida.idsIlegiveis,
    };
    return NextResponse.json(corpo);
  } catch (err) {
    if (err instanceof ShopeeApiError && err.kind === SHOPEE_ERROR_KIND.other) {
      const motivo = classificarRecusaTabelaMedidas(err);
      if (motivo === MOTIVO_RECUSA_TABELA_MEDIDAS.categoriaInvalida) {
        console.warn('[shopee/tabela-medidas/lista] categoria recusada pela Shopee', {
          integracaoId: integracaoId.valor,
          id,
          motivo,
          codigo: codigoSeguro(err.code),
        });
        return NextResponse.json(
          {
            error: `A Shopee não aceita a categoria ${String(id)} para tabelas de medidas nesta loja — escolha outra categoria.`,
            code: 'SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA',
            categoryId: id,
          },
          { status: 404 },
        );
      }
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const res = await responder(req);
  // EVERY answer — a template made in Seller Centre a minute ago must appear,
  // and a cached 404 or 502 would outlive the state it describes.
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

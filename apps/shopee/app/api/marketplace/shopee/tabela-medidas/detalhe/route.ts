/**
 * `GET /api/marketplace/shopee/tabela-medidas/detalhe?integracaoId=&sizeChartId=`
 * (#1526, step 18) — ONE size-chart template, projected, for the `/medidas`
 * Shopee tab's preview grid. Depth: `lib/shopee/tabelaMedidas/README.md`.
 *
 * ## The ladder
 *
 * `verifyCaller(PERM.integracao.read)` → `integracaoId` (400) → `sizeChartId`
 * (400; `lerIdPositivoObrigatorio` — digits only, a positive safe integer, NOT
 * trimmed; `0` is the add/update DETACH sentinel and never a template) → the
 * conta's shop client → `lerTabelaDeMedidasShopee` → 200 `{ tabela }`.
 *
 * No category in the query, so NO leaf gate: a stored legacy entry on a
 * non-leaf category is still previewed by its id.
 *
 * `tabela` is `projetarTabelaShopee`'s output passed WHOLE under one key — the
 * schema both this route's test and `apps/web` parse it with lives in
 * `@delfrance/schemas` (#1369: one projection, never a web-side copy). Its
 * `sizeChartId` is the REQUESTED id, never Shopee's echo; a differing echo is
 * one `id-divergente` problema inside the 200, not an error.
 *
 * ## Errors
 *
 * - A Shopee refusal (`ShopeeApiError` of kind `other`) that
 *   `classificarRecusaTabelaMedidas` reads as `tabela-inexistente` ⇒ 404
 *   `SHOPEE_TABELA_MEDIDAS_INEXISTENTE` + `sizeChartId`, with OUR sentence
 *   telling the operator what to do: the template was deleted in Seller Centre
 *   after it was picked.
 * - ⚠️ Kind `other` ONLY — a dead grant (409) and a rate limit (502 + `kind`)
 *   keep `shopeeErrorResponse`'s answer even if they carried the sentence.
 * - `categoria-invalida` is the LIST route's answer, not this one's: it falls
 *   through to the mapper (502) with everything else. Anything that is not a
 *   Shopee error rethrows (rule 6).
 *
 * ⚠️ **Never cached** — `Cache-Control: no-store` on EVERY answer, errors
 * included. Zero Firestore writes.
 *
 * Logs: one line per 404 — ids, the motivo and the code through
 * `codigoSeguro`, never Shopee's sentence.
 */
import { NextResponse } from 'next/server';
import { SHOPEE_ERROR_KIND, ShopeeApiError } from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { codigoSeguro } from '@/lib/shopee/nfe/redacaoNfe';
import type { DetalheTabelaMedidasDto } from '@/lib/shopee/tabelaMedidas/dto';
import { lerTabelaDeMedidasShopee } from '@/lib/shopee/tabelaMedidas/lerTabelaMedidas';
import {
  MOTIVO_RECUSA_TABELA_MEDIDAS,
  classificarRecusaTabelaMedidas,
} from '@/lib/shopee/tabelaMedidas/recusaTabelaMedidas';
import { lerIdPositivoObrigatorio, lerIntegracaoId } from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function responder(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const sizeChartId = lerIdPositivoObrigatorio(params, 'sizeChartId');
  if (!sizeChartId.ok) return NextResponse.json({ error: sizeChartId.erro }, { status: 400 });

  const id = sizeChartId.valor;
  try {
    const client = (
      await loadShopeeContext(getAdminFirestore(), integracaoId.valor)
    ).createShopClient();
    const corpo: DetalheTabelaMedidasDto = {
      tabela: await lerTabelaDeMedidasShopee({ client }, id),
    };
    return NextResponse.json(corpo);
  } catch (err) {
    if (err instanceof ShopeeApiError && err.kind === SHOPEE_ERROR_KIND.other) {
      const motivo = classificarRecusaTabelaMedidas(err);
      if (motivo === MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente) {
        console.warn('[shopee/tabela-medidas/detalhe] tabela inexistente na Shopee', {
          integracaoId: integracaoId.valor,
          id,
          motivo,
          codigo: codigoSeguro(err.code),
        });
        return NextResponse.json(
          {
            error: `A tabela de medidas ${String(id)} não existe mais nesta loja da Shopee — escolha outra.`,
            code: 'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
            sizeChartId: id,
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
  // EVERY answer — a cached 200 would preview a chart edited in Seller Centre
  // since, and a cached 404 or 502 would outlive the state it describes.
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

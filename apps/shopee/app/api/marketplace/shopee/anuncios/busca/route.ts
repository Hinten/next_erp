import { NextResponse } from 'next/server';
import {
  SHOPEE_GET_ITEM_BASE_INFO_PATH,
  SHOPEE_ITEM_STATUS_WIRE,
  ShopeeApiError,
  ShopeeSchemaError,
  shopeeCodigoCanonico,
  type SearchItemParams,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  MODO_BUSCA_ANUNCIO_SHOPEE,
  buscaAnuncioShopeeTermoSchema,
  type RespostaBuscaAnunciosShopee,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { skuDoItemShopee } from '@/lib/shopee/produtos/resolveProduto';
import { lerIntegracaoId } from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TAMANHO_PAGINA = 20;

async function buscarIds(client: ShopeeClient, filtro: SearchItemParams) {
  try {
    const pagina = await client.searchItem(filtro);
    return {
      ids: [...new Set(pagina.item_id_list)].slice(0, TAMANHO_PAGINA),
      proximoCursor:
        pagina.next_offset && pagina.next_offset !== filtro.offset ? pagina.next_offset : null,
    };
  } catch (err) {
    if (err instanceof ShopeeApiError) {
      const codigo = shopeeCodigoCanonico(err.code);
      if (
        codigo === 'error_item_not_found' ||
        (codigo === 'error_param' &&
          err.providerMessage === 'The information you queried is not found.')
      ) {
        return { ids: [], proximoCursor: null };
      }
    }
    throw err;
  }
}

async function lerResultados(
  client: ShopeeClient,
  ids: readonly number[],
  sku: string | null,
): Promise<RespostaBuscaAnunciosShopee['resultados']> {
  if (ids.length === 0) return [];

  try {
    const { item_list: itens } = await client.getItemBaseInfo({ itemIds: ids });
    const porId = new Map(
      itens.filter((item) => item !== null).map((item) => [item.item_id, item]),
    );
    const resultados = ids.flatMap((itemId) => {
      const item = porId.get(itemId);
      if (
        !item ||
        item.item_status === SHOPEE_ITEM_STATUS_WIRE.sellerDelete ||
        item.item_status === SHOPEE_ITEM_STATUS_WIRE.shopeeDelete
      ) {
        return [];
      }
      const skuAtual = skuDoItemShopee(item);
      if (sku !== null && skuAtual !== sku) return [];
      return [{ itemId, nome: item.item_name, sku: skuAtual || null }];
    });
    if (resultados.length === 0 && itens.includes(null)) {
      throw new ShopeeSchemaError('A Shopee retornou dados de anúncio em um formato inválido.', {
        path: SHOPEE_GET_ITEM_BASE_INFO_PATH,
        httpStatus: 200,
        campos: ['item_list'],
      });
    }
    return resultados;
  } catch (err) {
    if (
      err instanceof ShopeeApiError &&
      shopeeCodigoCanonico(err.code) === 'error_item_not_found'
    ) {
      return [];
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });

  const modo = params.get('modo');
  const busca = buscaAnuncioShopeeTermoSchema.safeParse({ modo, termo: params.get('termo') });
  if (!busca.success) {
    const error =
      modo === MODO_BUSCA_ANUNCIO_SHOPEE.id
        ? 'Informe um ID de anúncio válido.'
        : 'Informe um nome ou SKU para buscar anúncios.';
    return NextResponse.json({ error }, { status: 400 });
  }

  const { data } = busca;
  const offset = params.get('cursor');
  if (offset !== null && (offset.length === 0 || data.modo === MODO_BUSCA_ANUNCIO_SHOPEE.id)) {
    return NextResponse.json({ error: 'Cursor de busca inválido.' }, { status: 400 });
  }

  try {
    const ctx = await loadShopeeContext(getAdminFirestore(), integracaoId.valor);
    const client = ctx.createShopClient();
    if (data.modo === MODO_BUSCA_ANUNCIO_SHOPEE.id) {
      const resultados = await lerResultados(client, [data.termo], null);
      return NextResponse.json({ resultados, proximoCursor: null });
    }

    const porSku = data.modo === MODO_BUSCA_ANUNCIO_SHOPEE.sku;
    const pagina = await buscarIds(client, {
      ...(porSku ? { itemSku: data.termo } : { itemName: data.termo }),
      offset: offset ?? undefined,
      pageSize: TAMANHO_PAGINA,
    });
    const resultados = await lerResultados(client, pagina.ids, porSku ? data.termo : null);
    return NextResponse.json({ resultados, proximoCursor: pagina.proximoCursor });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

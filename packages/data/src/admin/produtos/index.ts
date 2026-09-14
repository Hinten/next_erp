/**
 * Shared server-side produto resolution for marketplace order lines. The
 * channel-specific link rungs (ML's `produtoMercadoLivre`/`variacaoMercadoLivre`,
 * Shopee's `prodshopee`/`variashopee`) stay in their apps; only the SKU stage,
 * which is identical on every channel and whose guards are expensive to get
 * wrong, lives here.
 */
export {
  resolverProdutoPorSku,
  type ResolvedProdutoPorSku,
  type ResolverProdutoPorSkuArgs,
  type SkuMatchKind,
  type SkuMissKind,
} from './resolveProdutoPorSku';

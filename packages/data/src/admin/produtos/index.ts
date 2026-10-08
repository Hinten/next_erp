/**
 * Shared server-side produto resolution for marketplace order lines. The
 * channel-specific link rungs (ML's `produtoMercadoLivre`/`variacaoMercadoLivre`,
 * Shopee's `prodshopee`/`variashopee`) stay in their apps; only the SKU stage,
 * which is identical on every channel and whose guards are expensive to get
 * wrong, lives here — and with it `unidadeVendavelDaRaiz`, the stage's kit
 * guard + family hop, exported so Shopee's native-kit component resolution
 * (step 19) reaches the same sellable unit instead of a second copy of the rule.
 *
 * The same rule brought the `integracoesComProduto` maintenance here in #1519:
 * the denorm array, the two write tiers and the payload-only plan are
 * channel-neutral, while the link subcollections and survivor queries that feed
 * them are not. Each channel binds the plan with its own conta-ref reader.
 */
export {
  resolverProdutoPorSku,
  unidadeVendavelDaRaiz,
  type RaizResolvida,
  type ResolvedProdutoPorSku,
  type ResolverProdutoPorSkuArgs,
  type SkuMatchKind,
  type SkuMissKind,
} from './resolveProdutoPorSku';
export {
  adicionarConta,
  contaIdFromRef,
  contaRefForms,
  planLinkChange,
  removerContaSeOrfa,
  type SentinelasDeArray,
} from './integracoesComProduto';

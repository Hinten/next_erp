/**
 * A complete `produtoMercadoLivre` link doc for tests.
 *
 * **Test-only** — nothing in the app imports it, so it never reaches a bundle.
 * It exists because the link doc has 20 fields and four test files need one;
 * three hand-rolled copies had already started to drift on which fields they
 * bothered to set, which is how a test ends up asserting against a shape the
 * schema does not actually produce.
 */
import { ESTADO_PUBLICACAO_ML, type ProdutoMercadoLivreLink } from '@delfrance/schemas';

export function linkFixture(over: Partial<ProdutoMercadoLivreLink> = {}): ProdutoMercadoLivreLink {
  return {
    contaOuterRef: 'documents/integracao/conta-1',
    channels: ['marketplace'],
    estado: ESTADO_PUBLICACAO_ML.publicado,
    status: 'active',
    sub_status: null,
    id: 'MLB777',
    sku: null,
    descricao: null,
    site_id: 'MLB',
    title: 'Camiseta Básica',
    category_id: 'MLB31447',
    condition: 'new',
    listing_type_id: 'gold_special',
    crossdocking: null,
    freteGratis: false,
    precoPublicado: 79.9,
    tarifaFrete: null,
    comissao: null,
    isUserProductModel: false,
    video_id: null,
    attributes: null,
    errors: null,
    ultimaModificacao: 1_700_000_000_000,
    dataCadastro: 1_690_000_000_000,
    ...over,
  } as ProdutoMercadoLivreLink;
}

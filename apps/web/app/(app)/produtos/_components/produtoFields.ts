import type { FieldConfig } from '@delfrance/ui';
import type { Produto } from '@delfrance/schemas';

/**
 * Shared Produto ObjectView configuration, used by both the create (`novo`)
 * and edit (`[id]/editar`) screens so the tab layout and labels stay in sync.
 *
 * The product screen is large (Flutter parity: fotos, vídeos, variações,
 * estoque, preços, impostos, kit, anexos, marketplace). This config covers the
 * scalar fields (tabbed) plus the Fotos and Vídeos tabs; the remaining
 * variações/marketplace tabs land in follow-up PRs and stay hidden via
 * `PRODUTO_EXCLUDED_FIELDS` until then (the Flutter app keeps authoring them).
 */

/** Tab order for the Produto ObjectView. */
export const PRODUTO_SECTIONS: string[] = [
  'Dados gerais',
  'Dimensões e peso',
  'Configurações',
  'Fotos',
  'Vídeos',
  'Variações',
];

/**
 * Per-field labels + section (tab) assignment. Fields not listed here fall to
 * the first section unless excluded; everything we don't render yet is in
 * `PRODUTO_EXCLUDED_FIELDS`.
 */
export const produtoFieldOverrides: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados gerais' },
  sku: { label: 'SKU', section: 'Dados gerais' },
  gtin: { label: 'GTIN / EAN', section: 'Dados gerais' },
  codFornecedor: { label: 'Código no fornecedor', section: 'Dados gerais' },
  codPai: { label: 'Código do pai', section: 'Dados gerais' },
  publicado: { label: 'Publicado', section: 'Dados gerais' },

  pesoLiquidoKg: { label: 'Peso líquido (kg)', section: 'Dimensões e peso' },
  pesoBrutoKg: { label: 'Peso bruto (kg)', section: 'Dimensões e peso' },
  alturaCm: { label: 'Altura (cm)', section: 'Dimensões e peso' },
  larguraCm: { label: 'Largura (cm)', section: 'Dimensões e peso' },
  profundidadeCm: { label: 'Profundidade (cm)', section: 'Dimensões e peso' },
  crossdocking: {
    label: 'Crossdocking',
    hint: 'Prazo extra de postagem em dias',
    section: 'Dimensões e peso',
  },

  ehKit: { label: 'É kit', section: 'Configurações' },
  ehKitVirtual: { label: 'É kit virtual', section: 'Configurações' },
  ofereceFreteGratis: { label: 'Oferece frete grátis', section: 'Configurações' },
  permiteVendaSemEstoque: { label: 'Permite venda sem estoque', section: 'Configurações' },
};

/**
 * Fields hidden from the Produto ObjectView for now. Kit components and
 * marketplace bindings get dedicated tabs in later PRs; embeddings, references
 * and internal ordering stay server-managed or pass-through. (`fotos`,
 * `videos` and `variacoesUid` have their own tabs — see `PRODUTO_SECTIONS` —
 * so they're intentionally not listed. `grupoDeVariacoesUid` stays excluded:
 * the Variações tab manages it and the page's `deriveOnSave` persists it.)
 */
export const PRODUTO_EXCLUDED_FIELDS: string[] = [
  'nome_embedding',
  'anexos',
  'grupoDeVariacoesUid',
  'componentesKit',
  'componentesKitKeys',
  'marketplace',
  'marketplaceIds',
  'statusProdutosMarketplace',
  'integracoesComProduto',
  'fotosArquivosIds',
  'paiId',
  'ordem',
  'categoriaProdutoOuterRef',
];

/**
 * Create-mode defaults matching the Flutter constructor. `buildEmptyDefaults`
 * in ObjectView zeroes booleans to `false`; `publicado` defaults to `true`.
 */
export const PRODUTO_CREATE_DEFAULTS: Partial<Produto> = {
  publicado: true,
};

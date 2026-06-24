import type { FieldConfig } from '@delfrance/ui';
import type { Produto } from '@delfrance/schemas';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { skuRenderInput } from './SkuField';

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

/** Tab order for the Produto ObjectView — Variações before the media tabs. */
export const PRODUTO_SECTIONS: string[] = [
  'Dados gerais',
  'Descrição',
  'Dimensões e peso',
  'Configurações',
  'Kit',
  'Preço e custo',
  'Estoque',
  'Impostos',
  'Variações',
  'Fotos',
  'Vídeos',
  'Anexos',
];

/**
 * Per-field labels + section (tab) assignment. Fields not listed here fall to
 * the first section unless excluded; everything we don't render yet is in
 * `PRODUTO_EXCLUDED_FIELDS`.
 */
export const produtoFieldOverrides: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados gerais' },
  sku: { label: 'SKU', section: 'Dados gerais', renderInput: skuRenderInput },
  gtin: { label: 'GTIN / EAN', section: 'Dados gerais' },
  codFornecedor: { label: 'Código no fornecedor', section: 'Dados gerais' },
  codPai: { label: 'Código do pai', section: 'Dados gerais' },
  categoriaProdutoOuterRef: {
    label: 'Categoria',
    section: 'Dados gerais',
    // Emits the Flutter `documents/categorias/<id>` doc-path string.
    renderInput: refRenderInput(categoriaCollection, false, 'nome', undefined, true),
  },
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

  // `ehKit` / `ehKitVirtual` live on the Kit tab (matching the Flutter layout) so
  // the kit toggle sits right above its component manager.
  ehKit: { label: 'É kit', section: 'Kit' },
  ehKitVirtual: { label: 'É kit virtual', section: 'Kit' },
  ofereceFreteGratis: { label: 'Oferece frete grátis', section: 'Configurações' },
  permiteVendaSemEstoque: { label: 'Permite venda sem estoque', section: 'Configurações' },
  ehUsado: { label: 'Produto usado', section: 'Configurações' },

  custo: {
    label: 'Custo',
    hint: 'Alimenta o recálculo de preço pelas fórmulas da lista. Para kits, é calculado automaticamente a partir dos componentes na aba Kit.',
    section: 'Preço e custo',
  },
  // `precos` gets its renderInput (PrecoCustoManager) on each page — it
  // needs the page's listas snapshot and produtoId.

  // `extraData` is the aggregate page model's Descrição + Google Merchant block
  // (a TRANSIENT field — see `PRODUTO_TRANSIENT_FIELDS`). Its renderInput
  // (ExtraDataManager) is wired per page since it needs `produtoId`/`db`.
  extraData: { label: 'Descrição', section: 'Descrição' },

  // `estoques` is the aggregate page model's per-depósito stock (a TRANSIENT
  // field). Its renderInput (EstoqueManager) is wired per page since it needs
  // `produtoId`/`db`.
  estoques: { label: 'Estoque', section: 'Estoque' },

  // `impostos` is the aggregate page model's per-operação fiscal override (a
  // TRANSIENT field). Its renderInput (ImpostoManager) is wired per page since
  // it needs `produtoId`/`db`.
  impostos: { label: 'Impostos', section: 'Impostos' },

  // `componentesKit` is a produto DOC field (a map component-id → Kit) — rides
  // the normal save. Its renderInput (KitManager) is wired per page (needs `db`);
  // `componentesKitKeys` is the denorm derived in `deriveOnSave`, never rendered.
  componentesKit: { label: 'Componentes do kit', section: 'Kit' },
};

/**
 * Aggregate page-model fields that are validated + rendered but live in their
 * own documents, NOT on the produto doc — passed to `ObjectView.transientFields`
 * so they are stripped from the produto write and persisted atomically via the
 * page's `transactionWrites`. `id` is the produto id, present only for the
 * cross-document self-reference check; `impostos` lands with its own tab.
 */
export const PRODUTO_TRANSIENT_FIELDS: string[] = ['id', 'extraData', 'estoques', 'impostos'];

/**
 * Fields hidden from the Produto ObjectView for now. Kit components and
 * marketplace bindings get dedicated tabs in later PRs; embeddings, references
 * and internal ordering stay server-managed or pass-through. (`fotos`,
 * `videos`, `anexos` and `variacoesUid` have their own tabs — see `PRODUTO_SECTIONS` —
 * so they're intentionally not listed. `grupoDeVariacoesUid` stays excluded:
 * the Variações tab manages it and the page's `deriveOnSave` persists it.)
 */
export const PRODUTO_EXCLUDED_FIELDS: string[] = [
  'nome_embedding',
  'grupoDeVariacoesUid',
  // `componentesKit` renders in the Kit tab; `componentesKitKeys` is the denorm
  // the delete-guard queries — derived in `deriveOnSave`, never rendered.
  'componentesKitKeys',
  'marketplace',
  'marketplaceIds',
  'statusProdutosMarketplace',
  'integracoesComProduto',
  'fotosArquivosIds',
  'paiId',
  'ordem',
  // `id` is only a cross-document validation context (the produto doc id), never
  // rendered. (`extraData` → Descrição tab, `estoques` → Estoque tab, `impostos`
  // → Impostos tab.)
  'id',
];

/**
 * Create-mode defaults matching the Flutter constructor. `buildEmptyDefaults`
 * in ObjectView zeroes booleans to `false`; `publicado` defaults to `true`.
 */
export const PRODUTO_CREATE_DEFAULTS: Partial<Produto> = {
  publicado: true,
};

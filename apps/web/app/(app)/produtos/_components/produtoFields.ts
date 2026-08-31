import { z } from 'zod';
import type { FieldConfig } from '@delfrance/ui';
import { type Produto, produtoPageBaseSchema } from '@delfrance/schemas';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { skuRenderInput } from './SkuField';
import { dimensaoRenderInput, pesoRenderInput } from './PesoField';

/**
 * Shared Produto ObjectView configuration, used by both the create (`novo`)
 * and edit (`[id]/editar`) screens so the tab layout and labels stay in sync.
 *
 * The product screen is large (Flutter parity: fotos, vídeos, variações,
 * estoque, preços, impostos, kit, anexos, marketplace). This config covers the
 * scalar fields (tabbed) plus the Fotos and Vídeos tabs; the remaining
 * variações/marketplace tabs land in follow-up PRs and stay hidden via
 * `PRODUTO_EXCLUDED_FIELDS` until then (the migrated corpus carries them; this
 * app just does not edit them yet).
 */

/**
 * The Mercado Livre tab, named once so the section list, the schema anchor and
 * the page's `persistentSections` can never drift apart.
 */
export const SECTION_MERCADO_LIVRE = 'Mercado Livre';

/**
 * The two other tabs that register a flush closure the edit page calls in
 * `onAfterSave` — named once for the same reason as `SECTION_MERCADO_LIVRE`:
 * each has to appear in the section list, in a field's `section:` and in
 * `PRODUTO_PERSISTENT_SECTIONS`, and a typo in any one of them is silent.
 */
export const SECTION_VARIACOES = 'Variações';
export const SECTION_KIT = 'Kit';

/**
 * Tab order shared by every Produto screen, WITHOUT the Mercado Livre tab —
 * Variações before the media tabs.
 *
 * ⚠️ Mercado Livre is deliberately not in here: it must stay the LAST tab on
 * every produto screen, so each page appends `SECTION_MERCADO_LIVRE` itself
 * after whatever screen-specific tabs it adds. A page-specific tab
 * (`Modificações` on the edit screen) therefore slots in BETWEEN this list and
 * Mercado Livre — never after it. Appending to `PRODUTO_SECTIONS` instead is
 * what made the tab jump one position to the left the moment a produto was
 * saved.
 */
export const PRODUTO_SECTIONS_BASE: string[] = [
  'Dados gerais',
  'Descrição',
  'Dimensões e peso',
  'Configurações',
  SECTION_KIT,
  'Preço e custo',
  'Estoque',
  'Impostos',
  SECTION_VARIACOES,
  'Fotos',
  'Vídeos',
  'Anexos',
];

/**
 * The edit-only Modificações tab, named once for the same reason as
 * `SECTION_MERCADO_LIVRE`: the section list and the `modificacoes` field
 * override must name the identical string, and a typo in either silently
 * strands the tab (an empty panel, or a field grouped under a tab nobody
 * renders).
 */
export const SECTION_MODIFICACOES = 'Modificações';

/** Tab order for the create screen: the shared tabs, Mercado Livre last. */
export const PRODUTO_SECTIONS: string[] = [...PRODUTO_SECTIONS_BASE, SECTION_MERCADO_LIVRE];

/**
 * Tab order for the edit screen: the shared tabs, then the edit-only
 * Modificações tab, then Mercado Livre.
 *
 * ⚠️ Modificações slots in BEFORE Mercado Livre on purpose — Mercado Livre is
 * the last tab on the create screen too, and appending here would shift it one
 * position left the moment the produto is saved, which is exactly the bug this
 * pairing exists to prevent. Lives here beside `PRODUTO_SECTIONS` so the two
 * arms of the invariant sit in one file and `produtoFields.test.ts` can assert
 * both.
 */
export const PRODUTO_SECTIONS_EDITAR: string[] = [
  ...PRODUTO_SECTIONS_BASE,
  SECTION_MODIFICACOES,
  SECTION_MERCADO_LIVRE,
];

/**
 * What both produto pages hand to `<ObjectView schema={…}>`: the produto page
 * model plus the `mercadoLivre` UI anchor — a key whose only job is to give the
 * Mercado Livre tab a field descriptor (the tab is self-contained; nothing is
 * read from or written to the form value). Shared by both pages so the tab
 * exists in create mode too, where it renders a "salve o produto" message
 * instead of the editor.
 *
 * ⚠️ NOT `produtoPageSchema` — `@delfrance/schemas` already exports that name
 * for a DIFFERENT schema (`produtoPageBaseSchema.superRefine(refineProdutoPage)`:
 * the refined aggregate, with no `mercadoLivre` anchor), and both produto pages
 * import from both modules. Either is a plausible `schema=` value, so a wrong
 * auto-import would be silent: the refined one drops the ML tab's field
 * descriptor and the tab renders empty; this one drops the cross-field rules.
 */
export const produtoObjectViewSchema = produtoPageBaseSchema.extend({
  mercadoLivre: z.null().default(null),
});

/**
 * Sections whose content must survive a tab switch fully mounted — passed to
 * `ObjectView.persistentSections`. **Every tab that registers a flush closure
 * the edit page calls in `onAfterSave` belongs here**, because the default
 * `<Activity mode="hidden">` suspension tears down that subtree's effects (see
 * the docblock on `SectionTabs`) and takes the registration with them:
 *
 *  - **Mercado Livre** — its listing forms also hold unsaved edits and in-flight
 *    requests (see the docblock on `MercadoLivreTab`).
 *  - **Kit** — `KitVariacoesManager` nulls its ref on teardown, so a save from
 *    another tab hit `flushKitVariacoesRef.current?.(id)` on `null` and the
 *    staged `componentesKit` maps were silently never written.
 *  - **Variações** — `VariationManager` kept a closure over a snapshot whose
 *    listener had already been unsubscribed, so the flush rewrote `nome`/`sku`/
 *    `variacoesUid`/`ordem` from frozen data and a second save re-issued the
 *    whole batch.
 *
 * ⚠️ Persisting a section is NOT free, and the listener argument only covers
 * half of it. The snapshot side is genuinely free here — the edit page already
 * holds the same `paiId ==` children query and produto doc open for the whole
 * session, so neither adds a query shape (Estoque/Vídeos/Anexos would, which is
 * why the tabset as a whole is still not persistent). What is NOT free is
 * anything a persisted subtree does EAGERLY: the Kit panel also mounts
 * `KitManager`, whose `getDocFromServer` fan-out and `shouldDirty` form sync
 * would then run on every kit produto's edit-page load and arm the
 * unsaved-changes guard before the operator touched anything. That work stays
 * behind a `useSectionActive()` latch inside `KitManager`. Persist a section for
 * the registration; keep its expensive work gated on first open.
 *
 * ⚠️ Lives here, beside the section constants, because nothing in the type
 * system enforces the pairing: a page that renders a flush-registering tab in a
 * tabset WITHOUT listing it here still looks right, while silently restoring
 * the bugs above. `produtoFields.test.ts` is the backstop; one import beats one
 * omission.
 */
export const PRODUTO_PERSISTENT_SECTIONS: string[] = [
  SECTION_MERCADO_LIVRE,
  SECTION_KIT,
  SECTION_VARIACOES,
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
    renderInput: refRenderInput(categoriaCollection, false, 'nome'),
  },
  tabelaDeMedidasModaUid: {
    label: 'Tabela de Medidas (Moda)',
    section: 'Dados gerais',
    // Emits the Flutter `documents/tabMedi/<id>` doc-path string.
    renderInput: refRenderInput(tabelaDeMedidasCollection, false, 'nome'),
  },
  publicado: { label: 'Publicado', section: 'Dados gerais' },

  // For kits, peso is computed from the components (read-only) — mirrors `custo`.
  pesoLiquidoKg: {
    label: 'Peso líquido (kg)',
    section: 'Dimensões e peso',
    renderInput: pesoRenderInput,
  },
  pesoBrutoKg: {
    label: 'Peso bruto (kg)',
    section: 'Dimensões e peso',
    renderInput: pesoRenderInput,
  },
  // ...and so are the three box axes, since #1152 rolls them up too.
  alturaCm: {
    label: 'Altura (cm)',
    section: 'Dimensões e peso',
    renderInput: dimensaoRenderInput,
  },
  larguraCm: {
    label: 'Largura (cm)',
    section: 'Dimensões e peso',
    renderInput: dimensaoRenderInput,
  },
  profundidadeCm: {
    label: 'Profundidade (cm)',
    section: 'Dimensões e peso',
    renderInput: dimensaoRenderInput,
  },
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
  propagatePriceToChildren: {
    label: 'Propagar preço para as variações',
    hint: 'quando desligado, cada variação mantém o seu próprio preço',
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
export const PRODUTO_TRANSIENT_FIELDS: string[] = [
  'id',
  'extraData',
  'estoques',
  'impostos',
  // Pure UI anchor for the Mercado Livre tab — see `produtoObjectViewSchema`.
  'mercadoLivre',
];

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
  // System stamps — written by `saveRecord` / ObjectView, never form inputs.
  'timestamp',
  'ultimaModificacao',
  // `id` is only a cross-document validation context (the produto doc id), never
  // rendered. (`extraData` → Descrição tab, `estoques` → Estoque tab, `impostos`
  // → Impostos tab.)
  'id',
];

/**
 * Create-mode defaults matching the Flutter constructor (`models.dart:1320-1333`).
 * The dimensions/weight seed sensible shipping values (and `crossdocking` 0) so
 * freight quoting works out of the box on a fresh produto. The boolean flags —
 * including `publicado` — fall to `false` via ObjectView's `buildEmptyDefaults`,
 * so a new produto starts as a DRAFT, matching Flutter (`this.publicado=false`).
 * `propagatePriceToChildren` defaults to `true` to match the schema default and
 * legacy Flutter behavior where parent price changes cascade to variations.
 */
export const PRODUTO_CREATE_DEFAULTS: Partial<Produto> = {
  pesoLiquidoKg: 0.9,
  pesoBrutoKg: 1,
  alturaCm: 5,
  larguraCm: 10,
  profundidadeCm: 10,
  crossdocking: 0,
  propagatePriceToChildren: true,
};

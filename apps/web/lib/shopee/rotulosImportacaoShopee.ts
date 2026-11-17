/**
 * The Shopee mass-import dialog's labels (#1529 step 21-5), in ONE module, so
 * the dialog (`app/(app)/canais/shopee/_components/ImportarTodosShopeeDialog.tsx`)
 * and the copy that tells the operator which boxes to tick
 * (`./anuncioProduto.ts`: both import-remedy rows, `logistica-nao-confirmada`
 * from #2015 and `logistica-sem-valor-gravado` from #1911 P14b, CPY-4) read the same
 * strings. A copy that quotes «a label» typed out a second time is the #1369
 * drift shape: both read correct while disagreeing, and nothing fails when the
 * box is renamed.
 *
 * Display only. Each option's DEFAULT is `OPCOES_IMPORTACAO_SHOPEE_PADRAO` in
 * `@delfrance/schemas`, never restated here.
 */
import {
  SHOPEE_IMPORT_STATUS,
  type OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  type ShopeeImportStatus,
} from '@delfrance/schemas';

/** What each listing status a scan may ask for is called in «Status dos anúncios». Exhaustive by type. */
export const ROTULO_STATUS_IMPORTACAO_SHOPEE = {
  [SHOPEE_IMPORT_STATUS.normal]: 'Ativos',
  [SHOPEE_IMPORT_STATUS.unlist]: 'Inativos',
  [SHOPEE_IMPORT_STATUS.banned]: 'Banidos',
  [SHOPEE_IMPORT_STATUS.reviewing]: 'Em revisão',
} as const satisfies Record<ShopeeImportStatus, string>;

/**
 * Every option the dialog labels: each key of the defaults object except the
 * two `update_time` bounds, which ONE date-range input (`janela`) sets.
 */
type OpcaoComRotulo =
  | Exclude<keyof typeof OPCOES_IMPORTACAO_SHOPEE_PADRAO, 'updateTimeFromS' | 'updateTimeToS'>
  | 'janela';

/** Each option's label, as the dialog shows it. Exhaustive by type: a new option owes its label. */
export const ROTULO_OPCAO_IMPORTACAO_SHOPEE = {
  statuses: 'Status dos anúncios',
  importarEstoque: 'Importar estoque',
  sobrescreverEstoque: 'Sobrescrever estoque existente',
  importarPreco: 'Importar preço',
  sobrescreverPreco: 'Sobrescrever preço existente',
  importarFotos: 'Importar fotos',
  importarCategorias: 'Importar categorias',
  atualizarProdutoPai: 'Completar dados do produto pai',
  sobrescreverDadosProduto: 'Sobrescrever dados do produto (marca, dimensões, SKU)',
  atualizarCadastrados: 'Atualizar anúncios já cadastrados',
  janela: 'Janela de atualização (opcional)',
} as const satisfies Record<OpcaoComRotulo, string>;

/**
 * What «Importar fotos» does, shown under that box (#2099). The import only
 * APPENDS photos (an `arrayUnion` onto the produto's `fotos`), so it never
 * removes or replaces one. Its dedup is not a history: it skips a listing
 * picture only when an arquivo the produto CURRENTLY shows already caches that
 * `image_id` (apps/shopee `idsDeImagemJaImportados`,
 * `lib/shopee/produtos/fotosShopee.ts`), so a photo removed from the produto
 * comes back while the listing still has it. Never word it as "the photos this
 * conta has not brought yet": that history does not exist.
 *
 * A constant so the dialog test pins it verbatim and by reference. The import recipe in
 * `./anuncioProduto.ts` states the same behaviour in its own sentence.
 */
export const DESCRICAO_IMPORTAR_FOTOS_SHOPEE =
  'Acrescenta ao produto as fotos do anúncio; nunca remove nem substitui uma foto já ' +
  'cadastrada. Uma foto removida do produto volta se ainda estiver no anúncio.';

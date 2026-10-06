import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { fotoSchema } from './storage/foto';
import type { CollectionMetadata } from './types';

// Mirror `PERM.produto` from @delfrance/auth; duplicated locally to avoid a
// circular dep.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * TabelaDeMedidas — tabela de medidas (moda). Mirrors
 * `TabelaDeMedidas` em `.old/packages/moda/tabelaMedidas/lib/src/models.dart`.
 * Estruturas atreladas a marketplaces (Mercado Livre, Shopee) ficam
 * pass-through aqui; quem as lê passa pelo slice de cada canal
 * (`tabelaDeMedidasMercadoLivre.ts`, `tabelaDeMedidasShopee.ts`). Quem as
 * grava é este repo: o mapa Shopee, a aba Shopee de `/medidas` (step 18); o
 * mapa ML, a aba Mercado Livre e o sync de guias (`sizeChartSync.ts`). Não há
 * escritor Flutter — não existe dual run (root `CLAUDE.md` regra 8); o legado
 * chega só como DADO, e por isso os mapas toleram as formas do corpus.
 */
export const tabelaDeMedidasSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  codigo: z.string().max(255).nullable().describe('Código interno'),
  descricao: z.string().max(1000).nullable().describe('Descrição'),
  fotosArquivosIds: z.array(z.string()).nullable().optional(),
  // Mirrors `Produto.fotos` — the Flutter `Foto2` wire shape. `fotoSchema` is
  // `.passthrough()`, so any extra fields legacy `tabMedi` docs carry survive.
  fotos: z.array(fotoSchema).nullable().optional(),

  // Tabelas por integração — chave = integracao_id. Pass-through (cada
  // marketplace tem sua estrutura interna específica).
  tabelasDeMedidasMercadoLivre: z.record(z.string(), z.unknown()).nullable().optional(),
  // ⚠️ Per-conta value `z.unknown()` — the ML map's shape. The base schema
  // judges NO Shopee value: `lerEntradasShopeeDaConta` reads each conta's list
  // (and each element) one by one, and calls a non-list `lista-invalida`. Any
  // stricter per-key type made ONE odd value fail the whole base parse: every
  // reader of the doc (the ML publish/sync included) got the RAW doc with
  // defaults unapplied, and — since ObjectView's resolver validates every field —
  // every `/medidas` save of that tabela was blocked, for an edit the operator
  // could not make (the Shopee tab shows such a value read-only). Now the value
  // rides through every save verbatim. A loosening only ("never tighten in
  // place"). The MAP itself stays a record: a field that is not a plain object
  // (`campo-invalido`) still fails the base parse.
  tabelasMedidasShopee: z.record(z.string(), z.unknown()).nullable().optional(),

  // Pass the label through the builder (folded into its describe JSON) — a
  // chained `.describe('…')` would clobber the `{ kind:'datetime', unit:'ms' }`
  // metadata that TableView/ObjectView need to render these as date columns.
  dataCadastro: millisSinceEpoch('Data de cadastro').nullable().optional(),
  // ⚠️ `.default(null)`, never a bare `.optional()` — this is the list's sort
  // key and a classic `orderBy` excludes documents missing it. See
  // `defaultQuery.sortKeyPresence.test.ts`.
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().default(null),
});

export type TabelaDeMedidas = z.infer<typeof tabelaDeMedidasSchema>;

export const tabelaDeMedidasMeta: CollectionMetadata = {
  collectionPath: 'tabMedi',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
  // Default the list to most-recently-modified first (reuses the existing
  // `ultimaModificacao DESC` index, which is also the TableView update-monitor
  // index). The `nome ASC` index stays declared for the Nome-column sort + the
  // produto picker.
  defaultQuery: {
    orderBy: [{ field: 'ultimaModificacao', direction: 'desc' }],
    limit: 50,
    columns: ['nome', 'codigo', 'dataCadastro', 'ultimaModificacao'],
  },
};

export const tabelaDeMedidas = {
  schema: tabelaDeMedidasSchema,
  meta: tabelaDeMedidasMeta,
};

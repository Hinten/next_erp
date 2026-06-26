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
 * pass-through; Flutter ainda autora esses sub-objetos.
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
  tabelasMedidasShopee: z.record(z.string(), z.array(z.unknown())).nullable().optional(),

  dataCadastro: millisSinceEpoch().nullable().optional().describe('Data de cadastro'),
  ultimaModificacao: millisSinceEpoch().nullable().optional().describe('Última modificação'),
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
  },
};

export const tabelaDeMedidas = {
  schema: tabelaDeMedidasSchema,
  meta: tabelaDeMedidasMeta,
};

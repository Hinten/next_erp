import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
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
  fotos: z.array(z.unknown()).nullable().optional(),

  // Tabelas por integração — chave = integracao_id. Pass-through (cada
  // marketplace tem sua estrutura interna específica).
  tabelasDeMedidasMercadoLivre: z.record(z.string(), z.unknown()).nullable().optional(),
  tabelasMedidasShopee: z.record(z.string(), z.array(z.unknown())).nullable().optional(),

  dataCadastro: millisSinceEpoch().nullable().optional(),
  ultimaModificacao: millisSinceEpoch().nullable().optional(),
});

export type TabelaDeMedidas = z.infer<typeof tabelaDeMedidasSchema>;

export const tabelaDeMedidasMeta: CollectionMetadata = {
  collectionPath: 'tabMedi',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
  },
};

export const tabelaDeMedidas = {
  schema: tabelaDeMedidasSchema,
  meta: tabelaDeMedidasMeta,
};

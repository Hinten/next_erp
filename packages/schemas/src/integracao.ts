import { z } from 'zod';
import type { CollectionMetadata } from './types';

const PERM_INTEGRACAO_READ = 1n << 56n;
const PERM_INTEGRACAO_WRITE = 1n << 57n;
const PERM_INTEGRACAO_DELETE = 1n << 58n;

/**
 * INTEGRACAO_PEDIDO — int-coded marketplace channel id, mirroring
 * `packages/global/lib/src/constantes.dart`. Stored on disk as the
 * integer.
 */
export const integracaoTipoSchema = z.union([
  z.literal(0), // nenhuma
  z.literal(1), // mercadoLivre
  z.literal(2), // facebook
  z.literal(3), // lojaIntegrada
  z.literal(4), // magalu
  z.literal(5), // shopee
  z.literal(6), // whatsapp
  z.literal(7), // balcao
  z.literal(8), // amazon
]);
export type IntegracaoTipo = z.infer<typeof integracaoTipoSchema>;

export const INTEGRACAO_TIPO = {
  nenhuma: 0,
  mercadoLivre: 1,
  facebook: 2,
  lojaIntegrada: 3,
  magalu: 4,
  shopee: 5,
  whatsapp: 6,
  balcao: 7,
  amazon: 8,
} as const satisfies Record<string, IntegracaoTipo>;

export const INTEGRACAO_TIPO_LABELS: Record<IntegracaoTipo, string> = {
  0: 'Nenhuma',
  1: 'Mercado Livre',
  2: 'Facebook',
  3: 'Loja Integrada',
  4: 'Magalu',
  5: 'Shopee',
  6: 'WhatsApp',
  7: 'Balcão',
  8: 'Amazon',
};

/**
 * Map a Flutter INTEGRACAO_PEDIDO int to the plugin id used by
 * MarketplaceChannel implementations under packages/integrations/.
 */
export function pluginIdForTipo(tipo: IntegracaoTipo): string | null {
  switch (tipo) {
    case INTEGRACAO_TIPO.mercadoLivre: return 'mercado-livre';
    case INTEGRACAO_TIPO.shopee:       return 'shopee';
    case INTEGRACAO_TIPO.amazon:       return 'amazon-sp-api';
    case INTEGRACAO_TIPO.magalu:       return 'magalu';
    case INTEGRACAO_TIPO.lojaIntegrada: return 'loja-integrada';
    case INTEGRACAO_TIPO.facebook:     return 'facebook';
    case INTEGRACAO_TIPO.whatsapp:     return 'whatsapp-cloud-api';
    case INTEGRACAO_TIPO.balcao:
    case INTEGRACAO_TIPO.nenhuma:
    default:                            return null;
  }
}

/**
 * Integracao — collection `integracao`. Mirrors
 * `packages/canal_de_vendas/lib/src/models.dart`. Outer references
 * remain pass-through; the UI surfaces them as ids and resolves
 * lookups lazily.
 */
export const integracaoSchema = z.object({
  tipo: integracaoTipoSchema.default(INTEGRACAO_TIPO.nenhuma),
  padrao: z.boolean().default(false),
  nome: z.string().min(1).max(255),
  cpf_cnpj: z
    .string()
    .max(18)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional(),
  idCadIntTran: z.string().max(60).nullable().optional(),
  ativo: z.boolean().default(true),
  cor: z.number().int().nullable().optional(),
  modalidadeFreteImportacao: z.number().int().nullable().optional(),

  // Outer references — opaque pass-through.
  filialIntegracaoPedidoOuterRef: z.unknown(),
  tabelaNormalOuterRef: z.unknown(),
  tabelaPromocionalOuterRef: z.unknown().nullable().optional(),
  operacaoOuterRef: z.unknown().nullable().optional(),
  operacaoDevolucaoOuterRef: z.unknown().nullable().optional(),
  depositoOuterRef: z.unknown(),

  dataCadastro: z.string().datetime().nullable().optional(),
}).passthrough();

export type Integracao = z.infer<typeof integracaoSchema>;

export const integracaoMeta: CollectionMetadata = {
  collectionPath: 'integracao',
  permissions: {
    read: PERM_INTEGRACAO_READ,
    write: PERM_INTEGRACAO_WRITE,
    delete: PERM_INTEGRACAO_DELETE,
  },
};

export const integracao = { schema: integracaoSchema, meta: integracaoMeta };

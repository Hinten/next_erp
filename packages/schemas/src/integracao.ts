import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefSchema } from './shared/outerRef';
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
    case INTEGRACAO_TIPO.mercadoLivre:
      return 'mercado-livre';
    case INTEGRACAO_TIPO.shopee:
      return 'shopee';
    case INTEGRACAO_TIPO.amazon:
      return 'amazon-sp-api';
    case INTEGRACAO_TIPO.magalu:
      return 'magalu';
    case INTEGRACAO_TIPO.lojaIntegrada:
      return 'loja-integrada';
    case INTEGRACAO_TIPO.facebook:
      return 'facebook';
    case INTEGRACAO_TIPO.whatsapp:
      return 'whatsapp-cloud-api';
    case INTEGRACAO_TIPO.balcao:
    case INTEGRACAO_TIPO.nenhuma:
    default:
      return null;
  }
}

/**
 * Integracao — collection `integracao`. Mirrors
 * `packages/canal_de_vendas/lib/src/models.dart`. Outer references
 * remain pass-through; the UI surfaces them as ids and resolves
 * lookups lazily.
 */
export const integracaoSchema = z
  .object({
    tipo: integracaoTipoSchema.default(INTEGRACAO_TIPO.nenhuma),
    padrao: z.boolean().default(false),
    nome: z.string().min(1).max(255),
    cpf_cnpj: z.string().max(18).regex(/^\d*$/, 'apenas números').nullable().default(null),
    idCadIntTran: z.string().max(60).nullable().default(null),
    ativo: z.boolean().default(true),
    cor: z.number().int().nullable().default(null),
    modalidadeFreteImportacao: z.number().int().nullable().default(null),

    // Outer references — `documents/<col>/<id>` doc-path strings (Flutter ODM).
    // Nullable so a legacy integração without a given ref (e.g. a marketplace
    // channel with no filial) still reads/saves; the balcão form requires the
    // ones it needs at the field level.
    filialIntegracaoPedidoOuterRef: outerRefSchema.nullable().default(null),
    tabelaNormalOuterRef: outerRefSchema.nullable().default(null),
    tabelaPromocionalOuterRef: outerRefSchema.nullable().default(null),
    operacaoOuterRef: outerRefSchema.nullable().default(null),
    operacaoDevolucaoOuterRef: outerRefSchema.nullable().default(null),
    depositoOuterRef: outerRefSchema.nullable().default(null),

    dataCadastro: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type Integracao = z.infer<typeof integracaoSchema>;

export const integracaoMeta: CollectionMetadata = {
  collectionPath: 'integracao',
  permissions: {
    read: PERM_INTEGRACAO_READ,
    write: PERM_INTEGRACAO_WRITE,
    delete: PERM_INTEGRACAO_DELETE,
  },
  // Deleting a channel account frees its OAuth credential subcollection,
  // mirroring `int_frete` → `tokenMelEnv`.
  cascade: [{ path: 'integracao/{integracaoId}/credenciais', onDelete: 'cascade' }],
  // The `integracao` collection holds every channel type; each channel screen
  // (e.g. Balcão) lists a single `tipo` slice supplied via TableView's
  // `queryParams`.
  defaultQuery: {
    where: [{ field: 'tipo', param: true }],
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
  },
};

export const integracao = { schema: integracaoSchema, meta: integracaoMeta };

/* -------------------------------------------------------------------------- */
/*                    CredenciaisIntegracao (subcollection)                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-channel OAuth credential doc — `integracao/{integracaoId}/credenciais`.
 * One generic store for every marketplace channel (Mercado Livre, Amazon,
 * Shopee, Magalu). The OAuth-token dimension is uniform across channels; the
 * extras each channel returns (`token_type`, `scope`, `user_id`, `revoked`,
 * `created_at`, `isRefreshing`, …) ride along via `.passthrough()` with no
 * bespoke fields. Single-token semantics: the writer deletes older docs so at
 * most one lives.
 *
 * **Admin-only / default-deny** — these docs hold live `refresh_token`s, so
 * they follow the `certificadoSecreto` secret pattern, NOT the registered
 * `tokenMelEnv` one: this domain is deliberately left OUT of `ALL_DOMAINS`
 * (see the NOTE below), so rules-gen emits no match block and Firestore
 * default-denies every client read/write. Only the Admin SDK (apps/integrations
 * OAuth callback + refresh flow), which bypasses rules, reaches them — there is
 * no client consumer. The cascade from `integracao` runs server-side
 * (firebase-admin) and so still frees these on delete.
 *
 * The legacy Flutter app split this per channel
 * (`token6h`/`tokenDuravel`, `actokshopee`, `tokenoaut`, `tokenMagalu`); ML's
 * two tokens collapse here into one doc (`access_token` = the 6h token,
 * `refresh_token` = the durable one). The genuinely divergent per-channel
 * identity/config (`shop_id`, `tenant_id`, `selling_partner_id`, `brand`, and
 * Loja Integrada's static API key) is account-level data and lives on the
 * `integracao` doc instead — see #289, not here.
 */
export const credenciaisIntegracaoSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    /** Required ms since epoch (`now + expires_in`). Server-side only. */
    expirationDate: millisSinceEpoch(),
  })
  .passthrough();
export type CredenciaisIntegracao = z.infer<typeof credenciaisIntegracaoSchema>;

export const credenciaisIntegracaoMeta: CollectionMetadata = {
  collectionPath: 'integracao/{integracaoId}/credenciais',
  // No client domain grants these bits — placeholder values. This collection is
  // deliberately NOT registered in `ALL_DOMAINS`, so the rules generator emits
  // no match block for it and Firestore default-denies every client read/write.
  // Only the Admin SDK (apps/integrations), which bypasses rules, reaches the
  // OAuth tokens. Mirrors `certificadoSecretoMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally NOT exported as a `{ schema, meta }` DomainSchema and NOT
// added to `ALL_DOMAINS` — that would make the rules generator grant clients
// access to live refresh tokens. Admin-only = default-deny (see
// `credenciaisIntegracaoMeta`, mirroring `certificadoSecreto`). The admin
// collection handle consumes the path + schema directly; the server-side
// cascade on `integracao` delete frees the subcollection without a rules block.

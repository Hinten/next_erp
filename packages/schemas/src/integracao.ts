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

    /**
     * Shipping-modality code for imports, legacy `INTEGRACAO_FRETE` enum
     * (`packages/global/lib/src/constantes.dart`). Legacy serializes this enum
     * as a STRING (`'0'`–`'4'`, `'9'`), never a number — the previous
     * `z.number().int()` typing failed `parseRead` on real legacy docs (#465
     * finding).
     */
    modalidadeFreteImportacao: z.enum(['0', '1', '2', '3', '4', '9']).nullable().default(null),

    /**
     * The marketplace seller id this account maps to (Mercado Livre's numeric
     * `user_id`), denormalized onto the doc so an inbound webhook can resolve
     * its owning integração with a single equality query — the old
     * `ContaMercadoLivre.user_id` (int?, models.dart:199). Null for channels
     * that don't carry one. Stamped at OAuth exchange; the Flutter app already
     * writes it for accounts it connected (dual-run parity).
     */
    user_id: z.number().int().nullable().default(null),

    // NOTE: `ContaMercadoLivre.preferenciasProdutoMercadoLivre` (an embedded
    // object of 10 boolean import/overwrite toggles — importarCategorias,
    // importarNovosProdutos, importarEstoque, importarFotos, importarPreco,
    // atualizarProdutoMl, atualizarProdutoPai, sobrescreverEstoque,
    // sobrescreverFotos, sobrescreverPreco) is NEVER USED in the legacy
    // Flutter app per owner decision 2026-07-15. It is not modeled here and
    // will NOT be ported; any legacy doc that happens to carry it rides
    // `.passthrough()` untouched.

    // Per-channel flat account fields (parity audit #289) — one per
    // marketplace, nullable so every OTHER channel's docs still parse.
    /**
     * Shopee — `ContaShopee.shop_id` (int?), the connected shop's numeric id.
     */
    shop_id: z.number().int().nullable().default(null),
    /**
     * Shopee — `ContaShopee.main_account_id` (int?), the parent Shopee
     * account id a shop belongs to (multi-shop merchants).
     */
    main_account_id: z.number().int().nullable().default(null),
    /**
     * Shopee — `ContaShopee.tabelasAtacado` (`AtacadoShopee[]?`), wholesale
     * price-tier rules: each entry maps a `[min_count, max_count]` quantity
     * band to its own price table.
     */
    tabelasAtacado: z
      .array(
        z.object({
          listaDePrecoAtacadoOuterRef: outerRefSchema,
          min_count: z.number().int(),
          max_count: z.number().int(),
        }),
      )
      .nullable()
      .default(null),
    /**
     * Amazon — `ContaAmazon.selling_partner_id` (string?), the SP-API seller
     * id.
     */
    selling_partner_id: z.string().nullable().default(null),
    /**
     * Magalu — `ContaMagalu.tenant_id` (string?), the Magalu Open API tenant
     * id.
     */
    tenant_id: z.string().nullable().default(null),

    // NOTE: Loja Integrada's `ContaLojaIntegrada.token_id` (the per-account
    // static `chave_api`) is deliberately NOT modeled as a typed field here —
    // #356 tracks moving it into the admin-only `credenciais` store below
    // instead of a client-readable account field. A legacy doc that already
    // carries it rides `.passthrough()` untouched in the meantime.

    // Outer references — `documents/<col>/<id>` doc-path strings (Flutter ODM).
    // Nullable so a legacy integração without a given ref (e.g. a marketplace
    // channel with no filial) still reads/saves; the balcão form requires the
    // ones it needs at the field level.
    filialIntegracaoPedidoOuterRef: outerRefSchema.nullable().default(null),
    tabelaNormalOuterRef: outerRefSchema.nullable().default(null),
    tabelaPromocionalOuterRef: outerRefSchema.nullable().default(null),
    /**
     * Mercado Livre — Mercado-Shops-only price table refs
     * (`ContaMercadoLivre.tabelaMercadoShopsOuterRef` /
     * `.tabelaMercadoShopsPromocionalOuterRef`, models.dart). A SECOND price-
     * table pair distinct from `tabelaNormalOuterRef` / `tabelaPromocionalOuterRef`
     * above — these two apply only to the Mercado Shops storefront, not the
     * marketplace listing.
     */
    tabelaMercadoShopsOuterRef: outerRefSchema.nullable().default(null),
    tabelaMercadoShopsPromocionalOuterRef: outerRefSchema.nullable().default(null),
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
/*                      BrandShopee (subcollection)                           */
/* -------------------------------------------------------------------------- */

/**
 * Shopee brand cache — `integracao/{integracaoId}/brandshopee`. Mirrors the
 * legacy `BrandShopee` (`packages/canais_de_venda/shopee/lib/src/models.dart`:
 * `brand_id: int, original_brand_name: string, display_brand_name?: string`),
 * written client-side by the legacy Flutter app during dual-run. Loose
 * pass-through like the produto marketplace-link subcollections
 * (`produtoSubcollection` in `./produto/collection/subcollections.ts`) — the
 * Flutter wire shape is the source of truth and this is not validated field
 * by field here.
 */
export const brandShopeeSchema = z.object({}).passthrough();
export type BrandShopee = z.infer<typeof brandShopeeSchema>;

export const brandShopeeMeta: CollectionMetadata = {
  collectionPath: 'integracao/{integracaoId}/brandshopee',
  // MUST reuse these exact bits (not fresh ones): the rules claims map
  // derives the claim name from the permission bit, and Flutter Shopee users
  // already hold the `integracao` claim — a bespoke bit here would leave
  // them default-denied on their own brand cache.
  permissions: {
    read: PERM_INTEGRACAO_READ,
    write: PERM_INTEGRACAO_WRITE,
    delete: PERM_INTEGRACAO_DELETE,
  },
};

export const brandShopee = { schema: brandShopeeSchema, meta: brandShopeeMeta };

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
 * identity/config (`shop_id`, `tenant_id`, `selling_partner_id`) is
 * account-level data and lives as flat fields on the `integracao` doc
 * instead, not here; the Shopee brand cache lives in the
 * `integracao/{integracaoId}/brandshopee` subcollection (`brandShopeeSchema`
 * below). Loja Integrada's static API key (`token_id`) is the one
 * exception left to do: it is not yet ported to a typed field anywhere, and
 * #356 tracks moving it into THIS admin-only store rather than the
 * client-readable `integracao` doc.
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

/* -------------------------------------------------------------------------- */
/*        TokenDuravel (subcollection) — Mercado Livre dual-run parity         */
/* -------------------------------------------------------------------------- */

/**
 * Mercado Livre durable OAuth credential — `integracao/{integracaoId}/tokenDuravel`.
 * This is the OLD Flutter `TokenDuravel` wire shape, used during the migration so
 * the new app and the still-running Flutter app share the same credential (same
 * ML application). A tracked follow-up moves ML onto the encrypted `credenciais`
 * store above and drops this once the Flutter app is retired.
 *
 * Wire notes: `expires_in` is the **absolute** expiry as **int millis since
 * epoch** (Flutter's `dateTimeToJson`), NOT a seconds-duration. `expired` is a
 * rotation flag Flutter writes with `includeIfNull:false`, so it may be absent.
 *
 * Admin-only / default-deny, exactly like `credenciais` — it holds a live
 * `refresh_token`, so it is NOT registered in `ALL_DOMAINS` and rules-gen emits
 * no block for it. Only the Admin SDK (apps/mercado-livre) reaches it; the
 * Flutter client uses its own production ruleset.
 */
export const tokenDuravelSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    token_type: z.string().default('bearer'),
    scope: z.string().default(''),
    /** Absolute expiry, ms since epoch (Flutter `dateTimeToJson`). */
    expires_in: millisSinceEpoch(),
    user_id: z.number().int().nullable().default(null),
    /** `true` once Flutter/the app rotates this token; may be absent. */
    expired: z.boolean().nullable().optional(),
  })
  .passthrough();
export type TokenDuravel = z.infer<typeof tokenDuravelSchema>;

export const tokenDuravelMeta: CollectionMetadata = {
  collectionPath: 'integracao/{integracaoId}/tokenDuravel',
  // Admin-only / default-deny — placeholder bits; NOT in `ALL_DOMAINS`.
  permissions: { read: 0n, write: 0n, delete: 0n },
};

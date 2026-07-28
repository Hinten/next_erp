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
 * WhatsApp business-hours entry — legacy `Horario_Whatsapp`
 * (`packages/canais_de_venda/whatsapp/lib/src/models.dart`): a single
 * open/close pair. Both are `DateTime`, required (never null) in the Dart
 * model — modeled here with the numeric-epoch standard (`millisSinceEpoch`).
 */
export const horarioWhatsappSchema = z.object({
  abertura: millisSinceEpoch(),
  fechamento: millisSinceEpoch(),
});
export type HorarioWhatsapp = z.infer<typeof horarioWhatsappSchema>;

/* -------------------------------------------------------------------------- */
/*        Horario_Whatsapp abertura/fechamento wire codec (LEGACY-EXACT)       */
/* -------------------------------------------------------------------------- */

/**
 * `Horario_Whatsapp.abertura` / `.fechamento` are NOT calendar instants — they
 * encode a **wall-clock time of day** (hour + minute), and the exact wire value
 * has to stay byte-compatible with the still-running legacy Flutter app that
 * shares these `integracao` docs. Read/write it ONLY through this codec.
 *
 * ── Legacy contract (source of truth) ──────────────────────────────────────
 * The legacy app anchors the time at **year 0, January 1, in the operator's
 * LOCAL timezone**, then flattens it to `millisecondsSinceEpoch` — a huge
 * NEGATIVE int, since year 0 precedes the Unix epoch by ~1970 years.
 *
 *   WRITE  (`.old/lib/whatsapp/pages/conta.dart:1011,1048`):
 *     `DateTime(0, 1, 1, hour, minute).millisecondsSinceEpoch`
 *     — `DateTime(...)` is Dart's LOCAL-timezone constructor; month/day are
 *       1-based (month 1 = January).
 *
 *   READ, UI display  (`.old/lib/whatsapp/pages/conta.dart:1009,1014`):
 *     `TimeOfDay.fromDateTime(DateTime.fromMillisecondsSinceEpoch(ms))`
 *     — `.fromMillisecondsSinceEpoch` defaults to LOCAL, so `.hour`/`.minute`
 *       hand back the SAME wall clock that was typed. The editor round-trip is
 *       therefore **local → local**: what the operator enters is what the
 *       legacy screen shows.
 *
 *   READ, business-hours check  (`.old/packages/canais_de_venda/whatsapp/lib/
 *     src/models.dart:288-308`, `Periodo_Whatsapp.compareHoje`):
 *     `aberturaLocalDateTime.toUtc().hour` / `.toUtc().minute`
 *     — this SECOND reader converts to UTC first, so for an operator at UTC-3
 *       an 08:00 stored time is compared as 11:00. That is a **legacy quirk**
 *       (the open/close comparison is skewed by the UTC offset, and even by the
 *       year-0 LMT sub-minute offset). We reproduce the WRITE + UI-READ contract
 *       exactly; the wire value is the invariant. The #529 `estaAberto` port
 *       decides how to treat compareHoje — and MUST decode via this codec, then
 *       apply whatever UTC/local interpretation it settles on, never re-derive
 *       the ms by hand.
 *
 * ── Worked example (America/Sao_Paulo, LMT −03:06:28 at year 0) ─────────────
 *   encodeHorarioMs(8, 0)  → year0-Jan1-08:00 LOCAL → ms = −62_167_179_212_000
 *   decodeHorarioMs(−62_167_179_212_000) → { hour: 8, minute: 0 }   (UI shows 08:00)
 *   the same instant via Dart's compareHoje `.toUtc().hour` → 11 (:06 — the quirk)
 * Under a UTC clock the anchor is exactly year0-Jan1-00:00Z = −62_167_219_200_000,
 * so encodeHorarioMs(8, 0) === −62_167_190_400_000 (see the golden-vector test).
 *
 * ── JS pitfalls these helpers deliberately avoid ───────────────────────────
 *  - `new Date(year, …)` maps a 0–99 year to `1900 + year`. We build at a safe
 *    year first, then `setFullYear(0, 0, 1)` to force the TRUE year 0 / January
 *    (JS month 0) / day 1 while keeping the local time-of-day. This reproduces
 *    Dart's `DateTime(0, 1, 1, …)` byte-for-byte.
 *  - Decoding MUST use the LOCAL accessors (`getHours`/`getMinutes`) to match
 *    the legacy UI — NEVER `getUTCHours`/`getUTCMinutes`. Reading it back in UTC
 *    (as an earlier revision did, pairing `Date.UTC(1970, …)` with a UTC read)
 *    stores a wholly different value than legacy and is unreadable in BOTH
 *    directions — the wire-corruption bug this codec fixes.
 */
export function encodeHorarioMs(hour: number, minute: number): number {
  const d = new Date(2000, 0, 1, hour, minute, 0, 0);
  // Force the true year 0 (Jan/1), dodging the `new Date` 0–99 → 1900+year
  // quirk; keeps the local time-of-day set above.
  d.setFullYear(0, 0, 1);
  return d.getTime();
}

/**
 * Inverse of {@link encodeHorarioMs}: read the stored ms back as a LOCAL
 * wall-clock `{ hour, minute }` (the legacy UI's interpretation). See that
 * function's doc comment for the full contract and the year-0/local anchoring.
 */
export function decodeHorarioMs(ms: number): { hour: number; minute: number } {
  const d = new Date(ms);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

/**
 * WhatsApp weekly business-hours period — legacy `Periodo_Whatsapp` (same
 * file, lines ~209-337): one optional `Horario_Whatsapp` per weekday. Every
 * key is `.nullish()` — none of the seven `@JsonKey` weekday fields set
 * `includeIfNull: false` (unlike the top-level `horario_funcionamento` /
 * `mensagem_*` fields on `Conta_Whatsapp`), so a day may be absent OR
 * explicit `null` on the wire; `toJson` (`_toJsonHorario`) only emits the
 * populated days.
 */
export const periodoWhatsappSchema = z.object({
  domingo: horarioWhatsappSchema.nullish(),
  segunda: horarioWhatsappSchema.nullish(),
  terca: horarioWhatsappSchema.nullish(),
  quarta: horarioWhatsappSchema.nullish(),
  quinta: horarioWhatsappSchema.nullish(),
  sexta: horarioWhatsappSchema.nullish(),
  sabado: horarioWhatsappSchema.nullish(),
});
export type PeriodoWhatsapp = z.infer<typeof periodoWhatsappSchema>;

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

    /**
     * WhatsApp — `Conta_Whatsapp.wa_id` (string?), legacy source
     * `packages/canais_de_venda/whatsapp/lib/src/models.dart`. NOTE: despite
     * the name, the legacy inbound webhook pipeline resolves an account by
     * `wa_id == metadata.phone_number_id` (the WhatsApp Cloud API webhook
     * payload field) — so this carries the PHONE NUMBER ID, not the
     * WhatsApp Business Account ID. Do not "fix" this; #527's inbound
     * resolution depends on matching legacy exactly.
     */
    wa_id: z.string().nullable().default(null),
    /**
     * WhatsApp — `Conta_Whatsapp.phoneNumberId` (string?), the phone number
     * id from the WhatsApp Business Cloud API (Meta Graph). Distinct field
     * from `wa_id` above only in name — legacy populates both with the same
     * value; kept as two separate fields for wire parity.
     */
    phoneNumberId: z.string().nullable().default(null),
    /**
     * WhatsApp — the true WhatsApp Business Account id (WABA id). Distinct from
     * `wa_id` above: despite its name, `wa_id` carries the webhook payload's
     * `metadata.phone_number_id` (used ONLY for inbound account resolution) and
     * is NEVER a WABA id. `waba_id` is the account-level Graph node id, used
     * ONLY for account-level Graph calls — e.g. `GET /{waba_id}/subscribed_apps`
     * (the webhook-subscription health check). Null until an operator fills it
     * in; nullable like every other per-channel field so non-WhatsApp docs parse.
     */
    waba_id: z.string().nullable().default(null),
    /**
     * WhatsApp — `Conta_Whatsapp.numero` (string, required in legacy), the
     * connected phone number. Nullable here like every other per-channel
     * field so non-WhatsApp `integracao` docs still parse.
     */
    numero: z.string().nullable().default(null),
    /**
     * WhatsApp — `Conta_Whatsapp.verificado` (bool?, legacy default
     * `false`): whether the number completed the Cloud API verification
     * flow.
     */
    verificado: z.boolean().nullable().default(false),
    /**
     * WhatsApp — `Conta_Whatsapp.mensagem_automatica` (string?, max 255):
     * daily auto-reply sent during business hours (`horario_funcionamento`).
     */
    mensagem_automatica: z.string().max(255).nullable().default(null),
    /**
     * WhatsApp — `Conta_Whatsapp.mensagem_inatividade` (string?, max 255):
     * daily auto-reply sent OUTSIDE business hours.
     */
    mensagem_inatividade: z.string().max(255).nullable().default(null),
    /**
     * WhatsApp — `Conta_Whatsapp.horario_funcionamento`
     * (`List<Periodo_Whatsapp>?`): the weekly business-hours schedule.
     * Legacy (de)serializes it as a JSON array via
     * `_fromJsonListPeriodo`/`_toJsonListPeriodo`, one `Periodo_Whatsapp`
     * entry per array item.
     */
    horario_funcionamento: z.array(periodoWhatsappSchema).nullable().default(null),

    // NOTE: `Conta_Whatsapp.permanent_token` is deliberately NOT modeled here
    // (this is a client-readable doc) — it lives in the admin-only
    // `credenciaisWhatsapp` subcollection defined below (mirrors the
    // `credenciais` OAuth-token pattern). Legacy stored the two-step
    // registration `pin` in plaintext ON this client-readable account doc; we
    // deliberately do NOT — the 6-digit `pin` lives ONLY in the admin-only
    // `credenciaisWhatsapp.pin` field (below), alongside the permanent token.
    // The PIN/SMS number-registration sub-flow
    // (`RegistrarPinDialog`/`VerificarCodigoDialog`) is now ported — see the
    // apps/whatsapp verificacao/registro routes.

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
    // The legacy `tabelaMercadoShopsOuterRef` / `tabelaMercadoShopsPromocionalOuterRef`
    // pair is deliberately NOT modeled: Mercado Shops was discontinued by ML on
    // 2025-12-31, and neither app ever consumed the refs. Legacy docs still
    // carrying them ride `.passthrough()` untouched (dual-run safe).
    operacaoOuterRef: outerRefSchema.nullable().default(null),
    operacaoDevolucaoOuterRef: outerRefSchema.nullable().default(null),
    depositoOuterRef: outerRefSchema.nullable().default(null),

    // System stamps — `dataCadastro` create-only (nullish coalesce) and
    // `ultimaModificacao` on every write; both stamped by `saveRecord`.
    dataCadastro: millisSinceEpoch().nullable().default(null),
    ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
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
  // mirroring `int_frete` → `tokenMelEnv`. WhatsApp's permanent-token store
  // (`credenciaisWhatsapp`) is a separate subcollection (distinct schema —
  // not an OAuth token) and cascades the same way.
  cascade: [
    { path: 'integracao/{integracaoId}/credenciais', onDelete: 'cascade' },
    { path: 'integracao/{integracaoId}/credenciaisWhatsapp', onDelete: 'cascade' },
  ],
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
 * identity/config (`shop_id` / `main_account_id` / `tabelasAtacado`,
 * `selling_partner_id`, `tenant_id`, the Mercado Shops table refs) is
 * account-level data and lives as flat fields on the `integracao` doc
 * instead, not here — see `integracaoSchema`; the Shopee brand cache lives in
 * the `integracao/{integracaoId}/brandshopee` subcollection
 * (`brandShopeeSchema`, defined earlier in this file). Loja Integrada's
 * static API key (`token_id`) is the one
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

/* -------------------------------------------------------------------------- */
/*                  CredenciaisWhatsapp (subcollection)                       */
/* -------------------------------------------------------------------------- */

/**
 * WhatsApp permanent-token store — `integracao/{integracaoId}/credenciaisWhatsapp`.
 * Legacy `Conta_Whatsapp.permanent_token` (a long-lived Meta Graph API token —
 * WhatsApp Cloud API has no OAuth refresh flow, unlike the marketplace
 * channels) is secret and must never live on the client-readable `integracao`
 * doc, so it is split out here, mirroring the `credenciais` OAuth store above.
 *
 * **Admin-only / default-deny** — same rationale as `credenciaisIntegracao`:
 * deliberately left OUT of `ALL_DOMAINS` (see the NOTE below) so rules-gen
 * emits no match block and Firestore default-denies every client read/write.
 * Only the Admin SDK (the inbound webhook pipeline resolving accounts by
 * `wa_id`, #527; the outbound sender, #529) reaches it. The cascade from
 * `integracao` runs server-side (firebase-admin) and so still frees this
 * subcollection on delete.
 *
 * `phoneNumberId`/`wa_id` are denormalized here too (redundant with the flat
 * `integracao` fields) so server-side code resolving a credential doc never
 * needs a second, client-readable read to know which number it belongs to.
 *
 * SECURITY: the 6-digit two-step `pin` lives here ONLY — never on the
 * client-readable `integracao` doc (legacy stored it there in plaintext; we do
 * not). It is admin-only (this whole subcollection is default-deny) and is used
 * to RE-REGISTER the number: once two-step verification is enabled on a number,
 * Meta requires the SAME pin to register it again, so it must be persisted
 * alongside the permanent token that authorizes the call.
 */
export const credenciaisWhatsappSchema = z
  .object({
    permanent_token: z.string().min(1),
    phoneNumberId: z.string().nullable().default(null),
    wa_id: z.string().nullable().default(null),
    /**
     * The 6-digit two-step registration PIN (re-register capability): Meta
     * requires the SAME pin to re-register a number once 2FA is set. Stored
     * here (admin-only) alongside `permanent_token`, never on the account doc.
     */
    pin: z
      .string()
      .regex(/^\d{6}$/)
      .nullable()
      .default(null),
    createdAt: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();
export type CredenciaisWhatsapp = z.infer<typeof credenciaisWhatsappSchema>;

export const credenciaisWhatsappMeta: CollectionMetadata = {
  collectionPath: 'integracao/{integracaoId}/credenciaisWhatsapp',
  // No client domain grants these bits — placeholder values. This collection
  // is deliberately NOT registered in `ALL_DOMAINS`, so the rules generator
  // emits no match block for it and Firestore default-denies every client
  // read/write. Only the Admin SDK reaches the permanent token. Mirrors
  // `credenciaisIntegracaoMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally NOT exported as a `{ schema, meta }` DomainSchema and NOT
// added to `ALL_DOMAINS` — that would make the rules generator grant clients
// access to a live permanent token. Admin-only = default-deny (see
// `credenciaisWhatsappMeta`, mirroring `credenciaisIntegracaoMeta`). The admin
// collection handle consumes the path + schema directly; the server-side
// cascade on `integracao` delete frees the subcollection without a rules block.

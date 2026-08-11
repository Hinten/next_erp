import { z } from 'zod';
import { millisSinceEpoch } from '../../shared/datetime';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schemas for the Mercado Livre listing link docs —
 * `produtos/{id}/produtoMercadoLivre/{docId}` and
 * `produtos/{id}/variacaoMercadoLivre/{docId}` — in the EXACT old Flutter wire
 * shape (`ProdutoMercadoLivre` / `VariacoesML`, models.dart 761–1684 +
 * models.g.dart): dual-run coexistence means the Flutter app keeps reading the
 * docs the new app writes.
 *
 * These are deliberately NOT DomainSchemas and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domains in `subcollections.ts` already cover the
 * Firestore rules (client reads, parent produto permissions); these typed
 * shapes exist for the Admin-SDK writer (apps/mercado-livre publish flow),
 * which bypasses rules but must not drift from the Flutter wire format.
 *
 * Wire notes (from the generated Dart serializers):
 *  - `estado` is a short string code, 1–2 chars (`ESTADO_PUBLICACAO` @JsonValue);
 *  - `channels` is a plain string array (`['marketplace']`, `['mshops']`, or both);
 *  - every `*OuterRef` is a doc-path STRING in the `documents/<col>/<id>`
 *    form (`pathWithDocuments` — what `OuterRefField.toJson` stores AND what
 *    the deployed Flutter backend compares by exact equality in its queries);
 *  - `attributes` are EMBEDDED arrays (the legacy nested `attributesML`
 *    subcollection was dead code — never written);
 *  - dates serialize as int millis; `errors` is written even when null
 *    (`includeIfNull: true`);
 *  - doc ids are Firestore auto-ids (the ML item id lives in the `id` FIELD,
 *    null until the first successful publish).
 */

/** Old `ESTADO_PUBLICACAO` short string codes, 1–2 chars (models.dart 605–695). */
export const estadoPublicacaoMlSchema = z.enum(['r', 'a', 'ep', 'v', 'p', 'pa', 'c', 'E', 'am']);
export type EstadoPublicacaoMl = z.infer<typeof estadoPublicacaoMlSchema>;

/**
 * Named members of {@link estadoPublicacaoMlSchema}; names from
 * {@link ESTADO_PUBLICACAO_ML_LABELS}. The wire values are 1–2 char legacy codes
 * — `'p'` is publicado but `'pa'` is pausado, and `'E'` is the only uppercase one
 * — so the constant is the only spelling that survives a second reading.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const ESTADO_PUBLICACAO_ML = {
  rascunho: 'r',
  aguardando: 'a',
  emProcessamento: 'ep',
  emRevisao: 'v',
  publicado: 'p',
  pausado: 'pa',
  cancelado: 'c',
  erro: 'E',
  aguardandoMigracao: 'am',
} as const satisfies Record<string, EstadoPublicacaoMl>;

export const ESTADO_PUBLICACAO_ML_LABELS: Record<EstadoPublicacaoMl, string> = {
  r: 'Rascunho',
  a: 'Aguardando',
  ep: 'Em processamento',
  v: 'Em revisão',
  p: 'Publicado',
  pa: 'Pausado',
  c: 'Cancelado',
  E: 'Erro',
  am: 'Aguardando migração',
};

/** One embedded listing attribute (old `AttributesMLNew` wire shape). */
export const mlAttributeWireSchema = z
  .object({
    id: z.string().min(1),
    value_id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    value_name: z.string().nullable().optional(),
    attribute_group_id: z.string().nullable().optional(),
    attribute_group_name: z.string().nullable().optional(),
    unit_id: z.string().nullable().optional(),
  })
  .passthrough();
export type MlAttributeWire = z.infer<typeof mlAttributeWireSchema>;

/** `produtos/{id}/produtoMercadoLivre/{docId}` — the listing link doc. */
export const produtoMercadoLivreLinkSchema = z
  .object({
    /** Canonical `documents/integracao/<id>` path to the owning integracao. */
    contaOuterRef: outerRefSchema,
    channels: z.array(z.string()).default(['marketplace']),
    estado: estadoPublicacaoMlSchema.default('r'),

    /**
     * Raw ML listing `status` (`active`/`paused`/`closed`/…) and `sub_status`
     * (`deleted`/`suspended`/`freezed`/`out_of_stock`/…), stamped on import +
     * the `items` status-sync (#440). `estado` is the derived short code; these
     * keep the raw values so a product-maintenance bot can filter by ML status.
     * Additive/nullable — the Flutter reader ignores them (no rules change).
     */
    status: z.string().nullable().default(null),
    sub_status: z.array(z.string()).nullable().default(null),

    /** ML item id — null until the first successful publish. */
    id: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    // ML plain-text descriptions run to ~50k; the old 10000 cap was a Flutter
    // FORM validator the deployed backend never enforced, so a re-import/re-publish
    // that spreads an existing Flutter link must not fail strict-write validation
    // on a long stored descricao (dual-run). Match the real ML limit.
    descricao: z.string().max(50000).nullable().default(null),

    site_id: z.string().default('MLB'),
    title: z.string().min(1),
    category_id: z.string().nullable().default(null),
    condition: z.enum(['new', 'used']).default('new'),
    listing_type_id: z.string().nullable().default(null),

    crossdocking: z.number().int().min(0).nullable().default(null),
    freteGratis: z.boolean().default(false),
    precoPublicado: z.number().nullable().default(null),
    tarifaFrete: z.number().nullable().default(null),
    comissao: z.number().nullable().default(null),

    isUserProductModel: z.boolean().default(false),
    video_id: z.string().nullable().default(null),
    attributes: z.array(mlAttributeWireSchema).nullable().default(null),

    /** Publish errors — Flutter writes this key even when null. */
    errors: z.array(z.string()).nullable().default(null),

    ultimaModificacao: millisSinceEpoch().nullable().default(null),
    dataCadastro: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();
export type ProdutoMercadoLivreLink = z.infer<typeof produtoMercadoLivreLinkSchema>;

/**
 * `produtos/{childId}/variacaoMercadoLivre/{docId}` — a variation link doc,
 * saved UNDER the variation child produto (old `VariacoesML`).
 */
export const variacaoMercadoLivreLinkSchema = z
  .object({
    /** ML variation id (legacy model) — null until published. */
    id: z.number().int().nullable().default(null),
    /** ML item id (User-Products model) — each variation is its own item. */
    itemId: z.string().nullable().default(null),
    /**
     * Canonical `documents/integracao/<id>` path to the owning integracao —
     * the same denorm the PARENT link has carried all along (#920).
     *
     * NOT in the Flutter wire shape: `VariacoesML` never had it, so the conta
     * was only reachable by dereferencing `produtoMercadoLivreOuterRef` and
     * reading the parent link's own `contaOuterRef`. That hop is a second read
     * on every event and it fails outright once the parent link is gone —
     * `pruneMigratedSource` deletes parent and child links in ONE batch — which
     * makes it unusable as the sole conta source for a link-driven trigger.
     *
     * `.nullable()` because rows imported from the legacy project arrive
     * without it; `tools/migrations/src/2026-08-ml-integracoes-com-produto`
     * backfills them from the parent link, and only then may
     * `onVariacaoMercadoLivreLinkChanged`'s fallback hop be deleted.
     */
    contaOuterRef: outerRefSchema.nullable().default(null),
    /** Canonical `documents/produtos/<childId>` path to the variation child. */
    produtoVariacaoOuterRef: outerRefSchema,
    /** Canonical `documents/produtos/<id>/produtoMercadoLivre/<docId>` path. */
    produtoMercadoLivreOuterRef: outerRefSchema,
    sku: z.string().nullable().default(null),
    attributes: z.array(mlAttributeWireSchema).nullable().default(null),
  })
  .passthrough();
export type VariacaoMercadoLivreLink = z.infer<typeof variacaoMercadoLivreLinkSchema>;

/**
 * Does this PARENT link doc represent a listing the produto's conta still holds?
 *
 * This is the membership predicate behind `produtos.integracoesComProduto` — the
 * anchor pre-filter both ML sweeps start from (`bulkEstoquePlan.fetchStockFamilies`
 * S1, `precoPlan.fetchPrecoPage`). It reproduces the semantics the old
 * `marketplace` array carried, so moving maintenance into a trigger (#920) is not
 * also a behaviour change: an entry only ever appeared after a publish/import
 * returned an ML item id, and `removeMarketplaceEntry` dropped it on cancel.
 *
 * ⚠️ Cancelling does NOT delete the link doc — `itemsStatusSync` merges
 * `estado: 'c'` and the doc survives with its `id` intact. A trigger keyed on
 * document deletion would therefore never remove anything and the array would go
 * append-only, which is exactly the failure #431's lock 2 describes. Hence the
 * `estado` term.
 *
 * Deliberately loose input: callers hold raw `event.data.*.data()` payloads and
 * migration snapshots, never parsed schemas.
 */
export function linkHasLiveListing(link: Record<string, unknown> | null | undefined): boolean {
  if (link == null) return false;
  if (typeof link.id !== 'string' || link.id.length === 0) return false;
  return link.estado !== ESTADO_PUBLICACAO_ML.cancelado;
}

/**
 * Does this VARIATION link doc represent a listing? Existence plus an ML
 * identifier — `id` in the legacy `variations[]` model, `itemId` in the
 * User-Products one, where each member child is its own item.
 *
 * ⚠️ `estado` is deliberately NOT consulted, and the asymmetry with
 * {@link linkHasLiveListing} is the point: `estado` lives only on the parent
 * link, so honouring it here would force the parent trigger to fan out to every
 * child on every estado transition — for a field NO new-app reader consumes on
 * children (both sweeps filter `paiId == null`). It also matches the behaviour
 * being replaced: `updateParentDenorm` only ever touched the link's own produto,
 * so a cancel dropped the conta from the parent and left the children alone.
 *
 * The legacy `id` is an int, but tolerate a stringified one — Flutter-written
 * rows predate the typed schema.
 */
export function variacaoLinkHasListing(link: Record<string, unknown> | null | undefined): boolean {
  if (link == null) return false;
  if (typeof link.id === 'number' && Number.isFinite(link.id)) return true;
  if (typeof link.id === 'string' && link.id.length > 0) return true;
  return typeof link.itemId === 'string' && link.itemId.length > 0;
}

import { z } from 'zod';
import { millisSinceEpoch } from '../../shared/datetime';

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
 *  - `contaOuterRef` is a doc-path STRING to the integracao;
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
    /** Doc-path string to the owning integracao (old `contaOuterRef`). */
    contaOuterRef: z.string().min(1),
    channels: z.array(z.string()).default(['marketplace']),
    estado: estadoPublicacaoMlSchema.default('r'),

    /** ML item id — null until the first successful publish. */
    id: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    descricao: z.string().max(10000).nullable().default(null),

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
    /** Doc-path string to the variation child produto. */
    produtoVariacaoOuterRef: z.string().min(1),
    /** Doc-path string to the parent's produtoMercadoLivre link doc. */
    produtoMercadoLivreOuterRef: z.string().min(1),
    sku: z.string().nullable().default(null),
    attributes: z.array(mlAttributeWireSchema).nullable().default(null),
  })
  .passthrough();
export type VariacaoMercadoLivreLink = z.infer<typeof variacaoMercadoLivreLinkSchema>;

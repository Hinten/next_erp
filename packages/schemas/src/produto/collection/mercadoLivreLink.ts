import { z } from 'zod';
import { millisSinceEpoch } from '../../shared/datetime';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schemas for the Mercado Livre listing link docs —
 * `produtos/{id}/produtoMercadoLivre/{docId}` and
 * `produtos/{id}/variacaoMercadoLivre/{docId}` — in the EXACT old Flutter wire
 * shape (`ProdutoMercadoLivre` / `VariacoesML`, models.dart 761–1684 +
 * models.g.dart): the migrated corpus is stored in exactly this shape, so it
 * has to be read and written that way.
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

/**
 * Blocking-ness of ONE Mercado Livre validation cause. ML's docs are explicit
 * (`pt_br/validacoes`): `error` aborts the call and needs the seller to change
 * the payload, while `warning` is informative — ML already applied the
 * correction itself and the call may still have succeeded.
 *
 * ⚠️ A single 400 body MIXES both. Honouring the distinction is what keeps the
 * editor from painting a field red for something ML fixed on its own (a
 * normalized attribute value, an auto-added AGE_GROUP, mandatory ME2 adoption).
 */
export const mlCausaTipoSchema = z.enum(['error', 'warning']);
export type MlCausaTipo = z.infer<typeof mlCausaTipoSchema>;

/** Named members of {@link mlCausaTipoSchema} (`delfrance/prefer-schema-enum`). */
export const ML_CAUSA_TIPO = {
  erro: 'error',
  aviso: 'warning',
} as const satisfies Record<string, MlCausaTipo>;

/**
 * One entry of Mercado Livre's `cause[]` on a rejected item write, parsed and
 * already resolved to the control that can fix it.
 *
 * The wire shape is documented — `{department, cause_id, type, code,
 * references[], message}` (ML developers site, *Guia para produtos →
 * Validações*). It is NOT universal: a 403 carries no `cause` at all and other
 * endpoints spell it `causes`, so the parser
 * (`apps/mercado-livre/lib/marketplace/core/publishFalhas.ts`) is deliberately
 * tolerant and this schema keeps every field optional but `mensagem`.
 */
export const mlCausaSchema = z
  .object({
    /** ML `code` — the dotted validation code (`item.attributes.missing_required`). */
    code: z.string().nullable().default(null),
    /** ML `cause_id`. */
    causaId: z.number().int().nullable().default(null),
    tipo: mlCausaTipoSchema.nullable().default(null),
    /** ML `department` — which ML area raised the validation. */
    departamento: z.string().nullable().default(null),
    /** ML `message`, verbatim and untranslated. */
    mensagem: z.string(),
    /** ML `references[]`, verbatim (`item.attributes[0]`, `shipping.modes`). */
    referencias: z.array(z.string()).default([]),
    /**
     * The listing-form controls `referencias` resolved to — see
     * {@link ML_CAUSA_CAMPO} and {@link campoAtributo} for the vocabulary.
     *
     * ⚠️ Resolved on the SERVER, at the moment of failure, because an ML
     * reference can be POSITIONAL (`item.attributes[3]`) and the index counts
     * the payload we sent — which carries the derived attributes (`WEIGHT`,
     * `SELLER_PACKAGE_*`, `SIZE_GRID_ID`, `SELLER_SKU`) that `publishCore`
     * strips before the editor ever sees them. Index 3 in the payload is not
     * index 3 in the form, and only the publisher holds the payload.
     *
     * Empty is the SAFE default, not a failure: a cause nothing maps to is
     * rendered above the form instead of pinned to the wrong control.
     */
    campos: z.array(z.string()).default([]),
  })
  .passthrough();
export type MlCausa = z.infer<typeof mlCausaSchema>;

/**
 * The fixed listing-form keys {@link mlCausaSchema}'s `campos` can carry.
 * Attribute rows are dynamic — see {@link campoAtributo}.
 */
export const ML_CAUSA_CAMPO = {
  title: 'title',
  descricao: 'descricao',
  categoryId: 'category_id',
  listingTypeId: 'listing_type_id',
} as const;

/**
 * An attribute-grid row key. Deliberately the SAME spelling `fieldForPath`
 * already produces in `apps/web/lib/mercado-livre/publishIssues.ts`, so the
 * pre-flight (422) and ML-rejection paths address one control vocabulary.
 */
export function campoAtributo(id: string): string {
  return `attributes.${id}`;
}

/**
 * One active Mercado Livre MODERATION on a listing — why ML paused, penalised or
 * removed it, and what (if anything) fixes it.
 *
 * The wire shape is `GET /moderations/last_moderation/{item_id}-ITM` (ML
 * developers site, *Moderações → Gerenciar moderações*), whose entries carry
 * `{name, id, date_created, evidences[], wordings[]}`. The mapper
 * (`apps/mercado-livre/lib/marketplace/anuncios/moderacoes.ts`) is deliberately tolerant:
 * ML's own docs spell the evidence key BOTH `evidences` and `evidence` on
 * different pages, and several documented responses carry no `wordings` at all.
 *
 * ⚠️ This is NOT {@link mlCausaSchema} and must not be folded into it. A causa is
 * a PAYLOAD validation failure ML answered a write with; a moderação is a POLICY
 * verdict ML reached on its own, it can sit on a listing that is still `active`,
 * and its two texts are addressed to a human rather than to a form control.
 */
export const mlModeracaoSchema = z
  .object({
    /** ML `name` — the filter that fired (`POOR_QUALITY_THUMBNAIL`, `DENYLIST`). */
    nome: z.string().nullable().default(null),
    /**
     * ML `date_created`, VERBATIM.
     *
     * ⚠️ Deliberately a string, never a parsed instant. ML sends TWO formats for
     * this one field — `2021-04-14T10:47:05.270-0400` (offset-bearing) and
     * `2022-10-25 15:57:46.0` (space-separated, NO zone) — so any single parse is
     * wrong for the other, and a zone-less value read on a server whose ambient
     * timezone differs answers hours out (`delfrance/no-lossy-date-parse`,
     * `delfrance/no-ambient-timezone`). Presentation formats it, or does not.
     */
    dataCriacao: z.string().nullable().default(null),
    /**
     * `wordings[type=REASON].value` — WHY the listing was moderated, in the
     * account's language.
     *
     * ⚠️ NULL means "ML moderated this and supplied no text", NOT "no
     * moderation". It is not the same null as {@link mlModeracaoSchema.shape.remedio}:
     * that one says a fix does not exist, this one says the explanation is
     * missing while {@link mlModeracaoSchema.shape.nome} still names the filter
     * that fired. A reader must render the `nome`/`secoes` it does have rather
     * than treat the entry as empty.
     *
     * Nullable rather than required because the alternative was worse: dropping
     * such an entry stores `moderacoes: []`, which on disk is byte-identical to
     * a healthy listing and to ML's 404 — recording "not moderated" about a
     * listing ML just told us IS moderated. That is exactly the state the 404
     * narrow and the transient rethrow exist to prevent, and it must not be
     * reintroduced here. ⚠️ Do NOT fall back to `nome` to fill this: a raw
     * `POOR_QUALITY_THUMBNAIL` shown where the operator expects ML's prose reads
     * as a translated reason and is not one.
     *
     * An entry with NEITHER `motivo` nor `nome` genuinely says nothing and is
     * dropped by the mapper — the schema does not refine that, so the mapper is
     * the gate.
     */
    motivo: z.string().nullable().default(null),
    /**
     * `wordings[type=REMEDY].value` — HOW to fix it.
     *
     * ⚠️ NULL means UNRECOVERABLE, not "unknown". ML's docs are explicit that a
     * removed listing (`under_review` + `forbidden`, e.g. `DENYLIST`) returns a
     * REASON and no REMEDY *because there is no way back*. A reader must not
     * offer a fix here — inventing one sends the operator to edit a listing that
     * can never be reactivated.
     */
    remedio: z.string().nullable().default(null),
    /** `evidences[].section_name` — `pictures` | `title` | `category` | `item`. */
    secoes: z.array(z.string()).default([]),
    /** `evidences[].text_matched` — the offending value (a picture id, a phrase). */
    evidencias: z.array(z.string()).default([]),
  })
  .passthrough();
export type MlModeracao = z.infer<typeof mlModeracaoSchema>;

/**
 * The `sub_status` values that mean "ML has a moderation on this listing".
 *
 * Assembled from the status/substatus/tag table in *Gerenciar moderações* plus
 * the two companion pages, *Moderações com pausa* and *Moderações de imagens*:
 *
 *  | status         | sub_status / tag                      |
 *  |----------------|---------------------------------------|
 *  | `under_review` | waiting_for_patch · forbidden · held  |
 *  |                | pending_documentation · suspended     |
 *  |                | suspended_for_prevention · warning    |
 *  |                | picture_downloading_pending           |
 *  | `paused`       | moderation_penalty                    |
 *  |                | picture_download_pending              |
 *  | `active`       | poor_quality_thumbnail · moderation_penalty |
 *  | `closed`       | moderation_penalty                    |
 *
 * ⚠️ Both `picture_download_pending` and `picture_downloading_pending` are here
 * on purpose. They are not a typo of one another — ML's pages use the first for
 * the `paused` case and the second for the `under_review` one, and normalising
 * them to a single spelling would miss whichever page is right.
 *
 * ⚠️ `active` earns a place in this table, which is what makes moderation a poor
 * fit for `errors`: a `poor_quality_thumbnail` listing is LIVE and sendable, so
 * the stock re-arm gate would have cleared the diagnosis on the same write that
 * produced it.
 *
 * ⚠️ A `ReadonlySet<string>`, deliberately NOT a `z.enum`. `sub_status` is
 * `z.string()` precisely so an ML value we have not catalogued still parses (see
 * the field below), and {@link precisaConsultarModeracao}'s `under_review` arm
 * exists to catch exactly those. An enum here would reject the unknown value on
 * the way in and defeat both.
 */
const MODERATION_SUB_STATUS: ReadonlySet<string> = new Set([
  'moderation_penalty',
  'poor_quality_thumbnail',
  'picture_download_pending',
  'picture_downloading_pending',
  'waiting_for_patch',
  'forbidden',
  'held',
  'pending_documentation',
  'suspended',
  'suspended_for_prevention',
  'warning',
]);

/**
 * Does ML's own reading of this listing say a moderation exists?
 *
 * `under_review` qualifies on the STATUS alone: ML's docs put every one of its
 * substatuses in the moderation table, and a listing under review with a
 * sub_status we have not catalogued is exactly the case where the operator most
 * needs the reason. Everything else has to name a moderation sub_status.
 *
 * ⚠️ **Pure and total — no clock, no network, no Firestore.** That is what lets
 * it live here and be shared, and it is load-bearing in two directions:
 *
 *  - **Server** (`apps/mercado-livre`): being a predicate rather than "always
 *    fetch" is what keeps the `items` stream affordable — it fires for every
 *    change to every listing a seller owns, and a healthy one must keep costing
 *    the single `GET /items/{id}` it costs today. It is also the reason the
 *    CLEARING half of the `moderacoes` invariant is free on every path: a
 *    `false` here means any stored reason is stale, with no ML call to prove it.
 *  - **Client** (`apps/web`): it separates "ML reports a moderation nobody
 *    fetched" (`moderacoes == null` AND this predicate) from a link whose field
 *    was simply never populated — a legacy row, or one a publish/stock/price
 *    send created. Without it, `null` alone would warn on healthy listings.
 *
 * It lived in `apps/mercado-livre/lib/marketplace/anuncios/moderacoes.ts` until
 * apps/web needed it too. It cannot go back: apps/web has no dependency edge to
 * that app, and none is possible — sharing in this repo goes through packages.
 */
export function precisaConsultarModeracao(
  status: string | null | undefined,
  subStatus: readonly string[] | null | undefined,
): boolean {
  if (status === 'under_review') return true;
  return (subStatus ?? []).some((s) => MODERATION_SUB_STATUS.has(s));
}

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
     * Additive/nullable: the migrated corpus simply lacks the keys and nothing
     * outside this repo reads these docs. No rules change — the generated
     * ruleset covers this collection through the parent produto's permissions.
     */
    status: z.string().nullable().default(null),
    sub_status: z.array(z.string()).nullable().default(null),

    /**
     * ML item id — null until the first successful publish.
     *
     * ⚠️ Under {@link isUserProductModel} this is `familyId ?? itemId`, NOT
     * reliably a family id. Both writers fall back to the item when ML omits
     * `family_id` (publish, import), and the UPtin takeover sets the flag on an
     * existing link WITHOUT touching this field — so a migrated listing keeps the
     * `MLB…` it already had. A reader that assumes one shape hands the other to
     * the wrong ML endpoint, which answers 400, not 404; `resolveAnuncioUrl` in
     * apps/mercado-livre is the worked example.
     */
    id: z.string().nullable().default(null),

    /**
     * ML's `user_product_id` (`MLBU…`) for this listing — the STOCK identity on
     * a multiorigin (`warehouse_management`) conta, where `PUT /items`
     * `available_quantity` is ignored and stock moves through
     * `PUT /user-products/{id}/stock/type/seller_warehouse` (#706).
     *
     * ⚠️ Distinct from {@link id} above, which is `familyId ?? itemId` under
     * User Products. A User Product describes a product at VARIATION level, so a
     * family's members each have their own — the parent link's value is only
     * meaningful for a listing with no children.
     *
     * Nullable and self-healing: it is stamped wherever the fetched ML item is
     * already in hand (import, publish, the items status-sync), and the stock
     * send resolves it lazily with the `getItem` it already has a seam for, then
     * folds the answer into the writeback it was going to make anyway. So a link
     * predating #706 costs one extra ML read ONCE, and no backfill.
     *
     * ⚠️ Null on every legacy `variations[]` child — ML variation objects carry
     * no `user_product_id`, only UP members (each its own item) do.
     */
    userProductId: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    // ML plain-text descriptions run to ~50k; the old 10000 cap was a Flutter
    // FORM validator the deployed backend never enforced, so a re-import/re-publish
    // that spreads a migrated link must not fail strict-write validation on a
    // long stored descricao. Match the real ML limit.
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

    /**
     * Structured detail behind {@link errors} — ML's `cause[]` parsed and
     * resolved to form controls. Additive and nullable, handled exactly like
     * `status`/`sub_status` above: the migrated corpus carries neither key, so
     * our reader takes the `null` default. `errors` keeps its `string[]` wire
     * type because that is the shape already stored in the corpus.
     *
     * ⚠️ Cleared EVERYWHERE `errors` is cleared (publish success, the stock
     * writeback, `itemsStatusSync`, `reverificarAnuncio`, import). A surviving
     * entry paints a red field on a listing that is already healthy — which is
     * worse than no detail at all, because it is indistinguishable from a real
     * rejection.
     */
    causas: z.array(mlCausaSchema).nullable().default(null),

    /**
     * ML's ACTIVE moderations on this listing — the policy verdict behind a
     * `pausado`/`em revisão` the operator would otherwise see with no
     * explanation at all (#1087). Additive/nullable, invisible to the Flutter
     * reader exactly like `status`/`sub_status`/`causas` above.
     *
     * ⚠️ It does NOT ride the `errors`/`causas` clearing rule, and the difference
     * is the reason it is a separate field. Those two are cleared only once
     * `podeEnviarEstoque(...).enviar` — deliberately, so a `closed`/`under_review`
     * listing KEEPS its diagnosis. A moderação needs the opposite on both sides:
     * it must SURVIVE on a listing ML still calls `active` (that is exactly the
     * `poor_quality_thumbnail` case — live, but losing exposure), and it must
     * VANISH the moment ML stops reporting one, even mid-review. Sharing `errors`
     * would have wiped the first case on the very write that set it.
     *
     * ⚠️ The invariant that replaces that rule: `moderacoes` is written in the
     * SAME patch as the `status`/`sub_status` it explains — never on its own,
     * never left behind by a writer that moved the status. A reason outliving the
     * state it explains is what that prevents, and it matters because a stale
     * moderação on a healthy listing is indistinguishable from a real one.
     *
     * ⚠️ It holds UNCONDITIONALLY in the direction that produces that bug. Every
     * writer can tell from the item's own `status`/`sub_status` whether ML is
     * reporting a moderation at all (`precisaConsultarModeracao`, a pure
     * predicate), so a listing ML calls healthy is written `[]` with no ML call —
     * the stale reason is cleared for free, on every path, including the mass
     * import that deliberately skips the lookup.
     *
     * ⚠️ It is QUALIFIED in the other direction, and the qualification is the
     * third value: `null` means **"never asked"**, distinct from `[]` = "asked,
     * ML reported none". A writer that could not or would not ask about a
     * genuinely moderated listing omits the key rather than inventing `[]`, so
     * the stored value stands. Both cases are the importer's: the mass path
     * (`lerModeracoes: false`) and a `/moderations` call that failed. Both
     * self-heal through the `items` webhook or "Reverificar anúncio". Collapsing
     * `null` into `[]` would record "not moderated" about a listing nobody asked
     * about — on disk byte-identical to a healthy one, which is the exact state
     * the 404-is-data narrow and the transient rethrow exist to prevent.
     * `applyMemberStatusAndFold` relies on the same three-valued contract.
     *
     * ⚠️ **Only ML's own answer may touch this field — never a caller's success.**
     * Two groups qualify (#1252). A writer that ASKED — `itemsStatusSync`,
     * `reverificarAnuncio`, the importer — may write any value. A writer that
     * merely holds a fresh `status`/`sub_status` may write `[]` and nothing
     * else, because {@link precisaConsultarModeracao} is pure: when it reports
     * no moderation, that IS ML's verdict, obtained for free. That is publish,
     * the UP member publish, the stock send — on both its success writeback and
     * its terminal-4xx verification path — and the price send, which otherwise
     * omit the key.
     * It is NOT in `clearFalha()`, and that omission is deliberate: `errors`/`causas` record
     * OUR failed write, which a later success invalidates, but a moderação is
     * ML's verdict and nothing we do lifts it. The stock writeback calls
     * `clearFalha()` after a successful `PUT /items` — and a
     * `poor_quality_thumbnail` listing is `active` and takes stock updates WHILE
     * moderated, so clearing there would erase a live, still-true reason and
     * show a clean listing that is really still penalised. Hiding a real problem
     * is worse than the bug this field fixes.
     *
     * ⚠️ An ARRAY, not a nested object, and not only because ML returns one:
     * `mergeIfExists` is `update()`-backed and `assertFlatUpdatePatch` throws a
     * `TypeError` on a nested plain object in a patch. Arrays pass.
     */
    moderacoes: z.array(mlModeracaoSchema).nullable().default(null),

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
     * ML's `user_product_id` (`MLBU…`) for THIS member — the stock identity on a
     * multiorigin (`warehouse_management`) conta (#706). See the parent link's
     * field of the same name for the protocol.
     *
     * ⚠️ Null on a legacy `variations[]` child and it will stay null: an ML
     * variation object carries no `user_product_id`, only a UP member (which is
     * its own item) does — exactly like {@link itemId} beside it. The stock send
     * treats a null as "resolve it from ML, or skip this listing and say so",
     * never as "send zero".
     */
    userProductId: z.string().nullable().default(null),
    /**
     * Does THIS member's ML item carry the parent-sku custom characteristic
     * (`ML_ATTR_SKU_PAI_NOME`)? #1400.
     *
     * ⚠️ It records a fact about ONE ML item, not a preference, and it lives on
     * the MEMBER rather than on the família's parent link for two reasons that
     * are really the same reason — the parent link is written once, at the end,
     * from a value read at the beginning:
     *
     *  - a fan-out that fails on member 2 has already created member 1 WITH the
     *    characteristic. `writeMemberLink` persists each member the moment ML
     *    confirms it, so the fact survives the failure and the retry sends the
     *    characteristic to the remaining members instead of creating them
     *    without it beside a sibling that has it — a família SPLIT that no later
     *    publish could repair;
     *  - a parent-level flag would be a read-modify-write across every ML round
     *    trip, so a concurrent publish that read `false` first could store it
     *    over a `true` (root `CLAUDE.md` rule 7). Here the value is decided by
     *    what THIS call just sent for THIS member, so there is nothing to lose a
     *    race with — tier 0, not a guard.
     *
     * ⚠️ Written `true` only; never `false` on an update. The characteristic's
     * NAME feeds ML's family-id hash, so its presence must be uniform across a
     * família and nothing can strip it from an item that has it — the key is
     * OMITTED when this publish did not send it, leaving whatever is stored
     * standing, the same three-valued discipline `moderacoes` uses. A member
     * created without it takes the schema default here.
     */
    skuPaiAtributo: z.boolean().default(false),
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

    /**
     * Raw ML `status` / `sub_status` for THIS member's own item, as last observed
     * by publish, import or the `items` status-sync.
     *
     * Under User Products each member is its own ML item with its own lifecycle,
     * but ML exposes no family-level status — so the family's `estado` on the
     * PARENT link can only be a summary folded from these. Without them the fold
     * would have to `GET /items/{id}` once per member on every notification.
     * Null means never observed, which is NOT the same as closed: a null must
     * never be able to push a family to `cancelado`.
     *
     * ⚠️ Still no `estado` here, and the asymmetry with the parent link is the
     * same one {@link variacaoLinkHasListing} documents — these are raw
     * observations, not a membership signal, so `variacaoLinkHasListing` ignores
     * them and `onVariacaoMercadoLivreLinkChanged` gains no fan-out.
     *
     * Additive/nullable, and the generated ruleset covers this collection through
     * the loose pass-through domain in `subcollections.ts` (gated by the parent
     * produto's permissions), so no rules change — same as the parent's pair.
     */
    status: z.string().nullable().default(null),
    sub_status: z.array(z.string()).nullable().default(null),

    /**
     * ML's active moderations on THIS member's own item, recorded beside the
     * raw status they explain and for the same reason (#1087).
     *
     * Under User Products a moderação is per ITEM, so it lands here first and the
     * PARENT link takes the fold's WINNER — the same member whose status won.
     * Storing it per member is what keeps that fold free: `foldFamilyStatus` reads
     * the siblings' stored values and never has to `GET` a moderation per member.
     *
     * ⚠️ Same rule as the parent's copy, third value included: written in the
     * SAME patch as this member's `status`/`sub_status`, never on its own — `[]`
     * when ML was asked and reported none, and `null` ("never asked") omitting
     * the key so whatever was stored stands.
     *
     * ⚠️ A LEGACY `variations[]` member never gets one, exactly as it never gets
     * a `status`. It is not a listing of its own — it has no ML item id, no
     * lifecycle and therefore nothing for ML to moderate — so every writer of a
     * legacy member link (the importer, #707's phantom prune) leaves whatever was
     * stored alone rather than writing `[]`. Only the User-Products branch, where
     * a member IS its own item, ever populates this.
     */
    moderacoes: z.array(mlModeracaoSchema).nullable().default(null),
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

/**
 * Split a `produtoMercadoLivreOuterRef` into the parent produto + link doc ids.
 * Tolerates both the canonical `documents/produtos/<id>/produtoMercadoLivre/<docId>`
 * and a bare `produtos/...`; returns null for anything else, including a ref
 * whose third segment is not the literal `produtoMercadoLivre` leaf.
 *
 * ⚠️ This is the ANCHOR resolver, and that is what makes it worth sharing.
 * A variation link doc lives under the variation CHILD produto, but every
 * catalog query filters `paiId == null` — so a reader that resolves an ML
 * identifier through `variacaoMercadoLivre` and stops at the doc's own parent
 * has resolved a produto the list will then silently drop. This ref points at
 * the family anchor's link doc, so parsing it yields the anchor with no extra
 * read.
 *
 * ⚠️ `.nullable()` on the field: rows imported from the legacy project arrive
 * without it (`tools/migrations/src/2026-08-ml-integracoes-com-produto`
 * backfills them). A caller that must not miss those needs a `paiId` fallback.
 *
 * ⚠️ It lives HERE, beside the schema, rather than in whichever app needed it
 * first: the readers now span `apps/mercado-livre` (Admin SDK) and `apps/web`
 * (client SDK), and a copy per deployable is exactly how `integracao.cor`
 * drifted into two incompatible encodings (#1264/#1267). `apps/mercado-livre`
 * still carries private copies in `core/linkRefs.ts`, `import.ts`,
 * `importMigration.ts` and `orderProdutoResolve.ts` — byte-identical, and
 * collapsing them onto this export stays the mechanical follow-up it was
 * already deemed at `linkRefs.ts`.
 */
export function parseProdutoMercadoLivreOuterRef(
  ref: unknown,
): { produtoId: string; linkId: string } | null {
  if (typeof ref !== 'string') return null;
  const segs = ref.split('/').filter(Boolean);
  const i = segs.indexOf('produtos');
  if (i === -1 || i + 3 >= segs.length) return null;
  if (segs[i + 2] !== 'produtoMercadoLivre') return null;
  return { produtoId: segs[i + 1]!, linkId: segs[i + 3]! };
}

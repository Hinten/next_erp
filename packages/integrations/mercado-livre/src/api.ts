import { z } from 'zod';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreLabelUnavailableError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from './errors';
import { DEFAULT_API_BASE_URL } from './oauth';
import { registrarFormatoDoEnvio } from './shipmentFields';
import {
  type MlActiveChartDomains,
  type MlBillingInfo,
  type MlCatalogDomain,
  type MlCategory,
  type MlCategoryAttribute,
  type MlCategoryListingType,
  type MlClaim,
  type MlAnswerResult,
  type MlPackMessages,
  type MlQuestion,
  type MlClaimMessage,
  type MlClaimAttachmentUpload,
  type MlExpectedResolution,
  type MlPartialRefundOffers,
  type MlClaimReason,
  type MlClaimSearch,
  type MlDomainDiscovery,
  type MlItem,
  type MlItemsMultiget,
  type MlItemDescription,
  type MlItemPrices,
  type MlListingPrices,
  type MlMigrationLiveListing,
  type MlMissedFeeds,
  type MlModeration,
  type MlOrder,
  type MlOrderSearch,
  type MlPack,
  type MlPayment,
  type MlPictureUpload,
  type MlSellerItemsScan,
  type MlSellerShippingSchedule,
  type MlShipment,
  type MlShipmentInvoice,
  type MlShipmentOrder,
  type MlShipmentPayment,
  type MlShipmentSla,
  type MlSiteCategory,
  type MlSizeChartApi,
  type MlSizeChartDeleteResponse,
  type MlTechnicalSpecs,
  type MlTestUser,
  type MlUser,
  type MlUserProductFamily,
  type MlUserProductItemsSearch,
  type MlUserProductStock,
  STOCK_LOCATION_TYPE,
  activeChartDomainsSchema,
  catalogDomainSchema,
  categoryAttributesSchema,
  categoryListingTypesSchema,
  categorySchema,
  domainDiscoverySchema,
  itemDescriptionSchema,
  itemPricesSchema,
  itemSchema,
  ML_MULTIGET_MAX_IDS,
  itemsMultigetSchema,
  listingPricesSchema,
  migrationLiveListingSchema,
  mlBillingInfoSchema,
  mlClaimMessagesSchema,
  mlClaimAttachmentUploadSchema,
  mlExpectedResolutionsSchema,
  mlModerationsSchema,
  mlPartialRefundOffersSchema,
  mlClaimReasonSchema,
  mlClaimSchema,
  mlAnswerResultSchema,
  mlPackMessagesSchema,
  mlQuestionSchema,
  mlClaimSearchSchema,
  mlMissedFeedsSchema,
  mlPaymentSchema,
  mlSellerShippingScheduleSchema,
  mlShipmentInvoiceSchema,
  mlShipmentOrdersSchema,
  mlShipmentPaymentsSchema,
  mlShipmentSchema,
  mlShipmentSlaSchema,
  orderSchema,
  orderSearchSchema,
  packSchema,
  pictureUploadSchema,
  sellerItemsScanSchema,
  siteCategoriesSchema,
  sizeChartApiSchema,
  sizeChartDeleteResponseSchema,
  technicalSpecsSchema,
  testUserSchema,
  tokenErrorSchema,
  userProductFamilySchema,
  userProductItemsSearchSchema,
  userProductStockSchema,
  userSchema,
} from './types';

const DEFAULT_USER_AGENT = '@delfrance/erp-next';
const DEFAULT_MAX_RETRIES = 3;

export interface MercadoLivreApiConfig {
  /**
   * Returns a live (non-expired) access token. Token refresh is the caller's
   * concern (the app-side token store) — this client just sends what it's given.
   */
  readonly getAccessToken: () => Promise<string>;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Extra attempts on a **network** failure (fetch throw). Default 3. */
  readonly maxRetries?: number;
  /** Backoff (ms) before a network retry (attempt N, 1-based). Default 2^N·250ms; tests pass `() => 0`. */
  readonly retryDelayMs?: (attempt: number) => number;
}

interface RequestOpts {
  readonly query?: Record<string, string | number | undefined>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

/** Image bytes for `uploadPicture` (the server fetches them from Storage). */
export interface PictureFile {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** Raw label bytes from `getShipmentLabels` (a ZIP for both pdf and zpl2). */
export interface MlShipmentLabelResult {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

/**
 * Raw file bytes from either attachment endpoint — `downloadClaimAttachment`
 * (claims) or `downloadPostSaleAttachment` (post-sale messages).
 */
export interface MlAttachmentDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

/**
 * A `GET /orders/{id}` answer plus whether ML returned a COMPLETE
 * representation (HTTP 200) or a partial one (HTTP 206 Partial Content).
 * `complete: false` also covers any other 2xx we can't positively call
 * complete — the flag is only ever trusted in the affirmative.
 */
export interface MlOrderResponse {
  order: MlOrder;
  complete: boolean;
}

export interface MercadoLivreApi {
  getMe(): Promise<MlUser>;
  getUser(id: number | string): Promise<MlUser>;
  /**
   * `POST /users/test_user` — mint a Mercado Livre **test user** on `siteId`.
   *
   * ML has no sandbox; this is the substitute. The caller's token must belong to
   * the real account that owns the ML application, and that account is capped at
   * **10 test users** with no endpoint that lists them and no password recovery.
   *
   * ⚠️ The response contains a **password shown exactly once**. This method
   * deliberately bypasses the shared `parseOk` so no failure path can echo it —
   * see {@link testUserSchema}. Persist the result before doing anything else.
   */
  criarUsuarioTeste(siteId: string): Promise<MlTestUser>;
  getItem(id: string): Promise<MlItem>;
  /**
   * `GET /items?ids=<csv>&attributes=<csv>` — ML's **Multiget**: up to
   * {@link ML_MULTIGET_MAX_IDS} items in one request, each entry carrying its own
   * status code (see {@link itemsMultigetSchema} for why `code` must be read).
   *
   * `attributes` trims the response to the named fields. Omit it for whole items
   * — but prefer naming them: this exists to make a bulk check affordable, and an
   * unfiltered multiget of 20 full listings is a large body for two fields.
   *
   * ⚠️ Passing more than {@link ML_MULTIGET_MAX_IDS} ids throws `MercadoLivreError`
   * BEFORE the request. ML itself does not error on an over-long multiget — it
   * TRUNCATES, so the answer silently describes a prefix — and a caller deciding
   * what to close or delete from that difference would act on a set it only
   * partly verified. "Chunk at the call site" was a convention held in this
   * comment; the refusal makes it a property of the seam. Chunk at
   * {@link ML_MULTIGET_MAX_IDS}.
   */
  getItemsByIds(ids: readonly string[], attributes?: readonly string[]): Promise<MlItemsMultiget>;
  /**
   * `GET /moderations/last_moderation/{referenceId}` — the ACTIVE moderation(s)
   * on one element, with ML's own REASON and REMEDY texts (#1087).
   *
   * ⚠️ `referenceId` is `{element_id}-{element_type}`, NOT a bare item id — for a
   * listing that is `` `${itemId}-ITM` `` ({@link ML_MODERATION_ELEMENT}). The ML
   * docs derive it straight from an `/items` notification, which is what makes
   * this callable from the status-sync with no extra lookup. Passing a bare item
   * id is a silent miss, not an error.
   *
   * ⚠️ A **404 means "not moderated"** — the ordinary answer for a healthy
   * listing, and data rather than a failure. Callers must narrow it
   * (`err instanceof MercadoLivreHttpError && err.status === 404`) and treat it
   * as an empty result; anything else is transient and must rethrow.
   */
  getLastModeration(referenceId: string): Promise<MlModeration[]>;
  /** `GET /items/{id}/prices` — the listing's price set, consulted on the `items_prices` webhook topic (Step 11). */
  getPrices(itemId: string): Promise<MlItemPrices>;
  getOrder(id: number | string): Promise<MlOrder>;
  /**
   * `GET /orders/{id}` with the response's completeness exposed. ML answers
   * **`206 Partial Content`** for an order it can only partly materialize, and a
   * partial body simply OMITS fields rather than nulling them. Only a caller
   * that must tell "ML said this field is null" from "ML didn't say" needs this
   * — today that is the `orderML` mirror refresh (#793); everything else should
   * use the plain `getOrder`.
   */
  getOrderResponse(id: number | string): Promise<MlOrderResponse>;
  getPack(id: number | string): Promise<MlPack>;
  searchOrders(params: {
    seller: number | string;
    [key: string]: string | number | undefined;
  }): Promise<MlOrderSearch>;

  /** `GET /collections/{paymentId}` — a Mercado Pago payment tied to an ML order (order import, Step 9). */
  getPayment(paymentId: number | string): Promise<MlPayment>;
  /** `GET /shipments/{shipmentId}` — a shipment tied to an ML order (order import, Step 9). */
  getShipment(shipmentId: number | string): Promise<MlShipment>;
  /**
   * `GET /shipments/{shipmentId}/payments` — the shipping-cost payments for a
   * shipment. **The endpoint returns a bare JSON array**, not a `results`
   * envelope (order import, Step 9).
   */
  getShipmentPayments(shipmentId: number | string): Promise<MlShipmentPayment[]>;
  /**
   * `GET /shipments/{shipmentId}/orders` — the orders covered by a shipment and,
   * per (order, listing, variation) row, the units the buyer requested.
   * **Returns a bare JSON array**, not a `results` envelope, and requires the
   * `X-New-Domain: true` header.
   *
   * Feeds the shipment↔pedido item cross-check (`applyFreteStep`, #669); see
   * `mlShipmentOrderSchema` for why this resource rather than the legacy
   * `/shipments/{id}/items`. A documented `204 No Content` parses to `[]`, which
   * callers must read as "ML told us nothing", NOT as "the shipment is empty".
   */
  getShipmentOrders(shipmentId: number | string): Promise<MlShipmentOrder[]>;
  /**
   * `GET /shipments/{shipmentId}/sla` — the dispatch deadline for a shipment
   * (order import, Step 9). Deliberately does NOT send `x-format-new` (#957):
   * ML's documented example for this resource omits it and the response is
   * unchanged by it, so sending it would be speculative.
   */
  getShipmentSla(shipmentId: number | string): Promise<MlShipmentSla>;
  /**
   * `POST /shipments/{shipmentId}/invoice_data?siteId=MLB` — uploads the signed
   * `nfeProc` XML raw (Content-Type `application/xml`, Authorization Bearer
   * header — NOT the legacy query-string token). Unlocks the label: substatus
   * `invoice_pending` → `ready_to_print` (Step 12, issue #739).
   */
  sendShipmentInvoiceData(shipmentId: number | string, xml: string): Promise<MlShipmentInvoice>;
  /** `GET /shipments/{shipmentId}/invoice_data?siteId=MLB` — the saved invoice for a shipment (diagnosis/smoke). */
  getShipmentInvoiceData(shipmentId: number | string): Promise<MlShipmentInvoice>;
  /**
   * `GET /shipment_labels?shipment_ids=&response_type=` — the shipment label
   * as raw ZIP bytes (both formats come zipped: pdf → a PDF inside, zpl2 → a
   * `.txt` of ZPL). A 400 with a `failed_shipments` body throws
   * `MercadoLivreLabelUnavailableError` carrying the ML message so the caller
   * can react to `invoice_pending` (upload the NF-e first).
   */
  getShipmentLabels(shipmentId: string, format: 'pdf' | 'zpl2'): Promise<MlShipmentLabelResult>;
  /**
   * `GET /users/{sellerId}/shipping/schedule/{logisticType}` — the seller's
   * weekly dispatch-window schedule, used to compute the next valid dispatch
   * slot when the shipment SLA call fails (order import, Step 9).
   */
  getSellerShippingSchedule(
    sellerId: number | string,
    logisticType: string,
  ): Promise<MlSellerShippingSchedule>;
  /**
   * `GET /orders/{orderId}/billing_info` — buyer fiscal data for NF-e
   * emission. Sent with header `x-version: 2` (order import, Step 9).
   */
  getOrderBillingInfo(orderId: number | string): Promise<MlBillingInfo>;

  /**
   * `GET /sites/MLB/user-products-families/{familyId}` — sibling User-Product
   * ids of a family (User-Products model family fan-out, #521).
   */
  getUserProductFamily(familyId: string): Promise<MlUserProductFamily>;
  /**
   * `GET /users/{sellerId}/items/search?user_product_id=<csv>` — resolves a
   * batch of User-Product ids to their MLB item ids (#521 family fan-out).
   *
   * ⚠️ Without `page` this returns ML's DEFAULT first page, and the response
   * gives no way to tell that from a complete answer unless you read
   * `paging.total`. A caller that needs completeness — the publish orphan sweep
   * decides what to CLOSE from this — must pass an explicit `limit`/`offset` and
   * check `paging` (see `resolveFamilyItemIds`).
   *
   * `status` is ML's own listing-state filter on this endpoint (*Busca de itens*
   * → "Por estado"), narrowing the answer to e.g. the `active` members of a
   * family. ⚠️ A caller must still tolerate an EMPTY result when it passes one:
   * ML combining two filters is not something this repo can exercise (no
   * sandbox), so a filtered search that comes back empty means "no such member
   * OR the filter was not honoured", and the only safe reading is to retry
   * unfiltered (`resolveAnuncioUrl`).
   */
  searchItemsByUserProduct(
    sellerId: number,
    userProductIds: readonly string[],
    page?: { limit?: number; offset?: number; status?: string },
  ): Promise<MlUserProductItemsSearch>;
  /**
   * `GET /user-products/{userProductId}/stock` — the per-location stock of a
   * User Product, **plus the `x-version` header** (#706).
   *
   * ⚠️ The header is not an optimisation, it is the write protocol: a
   * `PUT …/stock/type/{type}` without `x-version` is a **400**, and with a stale
   * one a **409**. That is why this is the only reader in the client that
   * returns headers — the version is half the answer.
   *
   * `version` is `null` only if ML omits the header, which the docs say cannot
   * happen; the caller must treat that as "cannot write", never as "no version
   * needed".
   *
   * ⚠️ A UP with no initialised stock answers `stock-locations not found`
   * (a `MercadoLivreHttpError`), NOT an empty `locations` array.
   */
  getUserProductStock(
    userProductId: string,
  ): Promise<{ stock: MlUserProductStock; version: string | null }>;
  /**
   * `PUT /user-products/{userProductId}/stock/type/seller_warehouse` — the ONLY
   * way to move stock on a multiorigin (`warehouse_management`) account (#706).
   * `PUT /items` `available_quantity` is silently ignored there, frequently
   * answering 200 OK.
   *
   * `version` is the `x-version` from {@link getUserProductStock}; a stale one
   * raises `MercadoLivreHttpError` **409**, which the caller answers by
   * re-reading and retrying — see `isVersionConflict`.
   *
   * ⚠️ `locations` REPLACES the `seller_warehouse` set, so a caller must echo
   * back every location the read returned, changing only the quantities it
   * owns. Sending a subset is how you zero a warehouse you did not mean to
   * touch.
   *
   * ⚠️ A seller holding `warehouse_management` WITHOUT `multiwarehouse` manages
   * exactly one depósito, and ML answers 400 ("seller with a single warehouse
   * cannot update stock across multiple network nodes") to a request spanning
   * more than one `network_node_id`.
   *
   * Returns the response `x-version` like {@link getUserProductStock} does. A
   * successful write earns a NEW version, and handing it back is what lets a
   * caller write the same UP twice without paying a second `GET` on a
   * rate-limited endpoint family. `version` is null if ML omits the header.
   *
   * ⚠️ `stock` is **nullable**, and that is not defensiveness for its own sake:
   * `parseOk` feeds the schema `null` when the body is empty, so parsing this
   * response as a bare object would turn a bare-ack answer (204, or 200 with no
   * body) into a `MercadoLivreValidationError` — reporting a write that LANDED
   * as a failure. Whether ML echoes the resource here is not documented, and the
   * wrong guess is expensive: the caller would latch the listing with a
   * `lastError` that never clears while the quantity on ML is in fact correct.
   */
  putUserProductSellerWarehouseStock(
    userProductId: string,
    version: string,
    locations: ReadonlyArray<{ store_id: string; network_node_id: string; quantity: number }>,
  ): Promise<{ stock: MlUserProductStock | null; version: string | null }>;
  /**
   * `GET /items/{id}/migration_live_listing` — the new User-Products items a
   * legacy `variations[]` listing was migrated to (User-Products migration,
   * #441).
   */
  getMigrationLiveListing(itemId: string): Promise<MlMigrationLiveListing>;
  /**
   * `GET /users/{sellerId}/items/search?search_type=scan[&scroll_id=]` — one
   * page of the seller's full listing set (mass import scan, #621). Pass the
   * previous page's `scroll_id` to continue; omit/`null` to start a new scan.
   */
  scanSellerItems(sellerId: number, scrollId?: string | null): Promise<MlSellerItemsScan>;

  /** `POST /items` — first publish. Build the body with `buildItemPayload`. */
  createItem(payload: Record<string, unknown>): Promise<MlItem>;
  /** `PUT /items/{id}` — update / status transitions (`{ status: 'paused' }`…). */
  updateItem(id: string, payload: Record<string, unknown>): Promise<MlItem>;
  getItemDescription(id: string): Promise<MlItemDescription>;
  /**
   * `POST /items/{id}/description` (create) or, with `replace`, the
   * `PUT …/description?api_version=2` variant that swaps an existing one.
   */
  setItemDescription(
    id: string,
    plainText: string,
    opts?: { replace?: boolean },
  ): Promise<MlItemDescription>;
  /** `GET /sites/MLB/domain_discovery/search?q=` — category suggestion. */
  suggestCategories(query: string, limit?: number): Promise<MlDomainDiscovery>;
  getCategory(id: string): Promise<MlCategory>;
  getCategoryAttributes(id: string): Promise<MlCategoryAttribute[]>;
  /** `GET /sites/MLB/categories` — the roots of the category tree. */
  listSiteCategories(): Promise<MlSiteCategory[]>;
  /**
   * `GET /categories/{id}/listing_types` — the types available for a LEAF
   * category. ML serves nothing useful for a non-leaf, so callers gate on
   * `children_categories` being empty first.
   */
  getCategoryListingTypes(categoryId: string): Promise<MlCategoryListingType[]>;
  /**
   * `GET /sites/MLB/listing_prices` — fee preview for a price + listing type,
   * the source of the link doc's `comissao`.
   */
  getListingPrices(input: {
    price: number;
    listingTypeId: string;
    categoryId?: string | null;
  }): Promise<MlListingPrices>;
  /** `POST /pictures/items/upload` (multipart) — returns the ML picture id. */
  uploadPicture(file: PictureFile): Promise<MlPictureUpload>;

  /** `GET /domains/{id}/technical_specs` — full domain spec (grids incluídas). */
  getDomainTechnicalSpecs(domainId: string): Promise<MlTechnicalSpecs>;
  /**
   * `POST /domains/{id}/technical_specs?section=grids` — the concrete grid
   * columns for the chosen template attributes (GENDER/BRAND/filters). The
   * body mirrors the old app: `{ attributes: [...] }`.
   */
  getGridTechnicalSpecs(
    domainId: string,
    attributes: Array<Record<string, unknown>>,
  ): Promise<MlTechnicalSpecs>;
  /** `POST /catalog/charts` — create a seller size chart (full chart back). */
  createSizeChart(payload: Record<string, unknown>): Promise<MlSizeChartApi>;
  /** `GET /catalog/charts/{id}` — one chart, incl. `chart_status` while a deletion is pending. */
  getSizeChart(chartId: string): Promise<MlSizeChartApi>;
  /**
   * `DELETE /catalog/charts/{id}` — REQUEST the chart's removal. ML acks 200 and
   * then checks asynchronously (up to 24h) that no listing still links it;
   * a chart still in use is silently kept. Poll `getSizeChart` for the verdict.
   */
  deleteSizeChart(chartId: string): Promise<MlSizeChartDeleteResponse>;
  /** `PUT /catalog/charts/{id}` — rename (`{names: {MLB: nome}}`). */
  updateSizeChartName(chartId: string, names: Record<string, string>): Promise<MlSizeChartApi>;
  /** `POST /catalog/charts/{id}/rows` — add a row (full chart back). */
  addSizeChartRow(chartId: string, row: Record<string, unknown>): Promise<MlSizeChartApi>;
  /** `PUT /catalog/charts/{id}/rows/{rowId}` — update a row (FULL row id `'<chart>:<n>'`). */
  updateSizeChartRow(
    chartId: string,
    rowId: string,
    row: Record<string, unknown>,
  ): Promise<MlSizeChartApi>;
  /** `GET /catalog/charts/{site}/configurations/active_domains` — server-side only. */
  getActiveChartDomains(): Promise<MlActiveChartDomains>;
  /** `GET /catalog_domains/{id}` — domain label for pickers. */
  getCatalogDomain(domainId: string): Promise<MlCatalogDomain>;

  /**
   * `GET /questions/{questionId}?api_version=4` — one pre-sale question (#532).
   *
   * `api_version=4` is NOT optional: without it ML returns the legacy shape,
   * which omits `buyer_id` and nests the asker differently. The importer keys
   * the contact on that id, so the older shape would silently lose it.
   */
  getQuestion(questionId: number): Promise<MlQuestion>;

  /**
   * `POST /answers` — answer a question (#533). Body `{ question_id, text }`.
   *
   * ⚠️ SINGLE-SHOT and PUBLIC. Once it lands the question flips to `ANSWERED`
   * and the answer is visible on the listing; there is no edit and no retract.
   * Callers must re-check the status against LIVE ML immediately before
   * calling, never against a stored copy.
   *
   * ML caps an answer at 2000 characters.
   */
  answerQuestion(questionId: number, text: string): Promise<MlAnswerResult>;

  /** `DELETE /questions/{id}` — remove a question from the listing (#533). */
  deleteQuestion(questionId: number): Promise<void>;

  /**
   * `POST /users/{sellerId}/questions_blacklist` — stop a buyer from asking
   * further questions on this seller's listings (#533).
   */
  blockUserFromQuestions(sellerId: number, buyerId: number): Promise<void>;

  /**
   * `POST /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale` — reply on
   * a post-sale thread (#533).
   *
   * ⚠️ `to.user_id` is the thread’s **counterparty**, which is the site’s
   * messaging AGENT on a thread ML has migrated to the 02/02/2026 architecture
   * and the **real buyer id** on one it has not. The rollout is progressive, so
   * neither is right unconditionally — the caller derives it from the thread
   * (`postSaleRecipientUserId`). Getting it wrong fails asymmetrically: the agent
   * on a legacy thread is a hard `400 … does not belong to pack`, the buyer on a
   * migrated one is a **200** that reaches nobody.
   *
   * ML also caps the body at the thread’s own `seller_max_message_length`, which
   * the caller reads from a prior GET.
   */
  sendPackMessage(
    packId: string,
    sellerId: string,
    body: { text: string; toUserId: number; attachments?: readonly string[] },
  ): Promise<void>;

  /**
   * `GET /messages/{messageId}?tag=post_sale` — ONE post-sale message, used to
   * resolve a `messages` notification's bare id to the pack it belongs to
   * (#532).
   *
   * ⚠️ `mark_as_read=false` is deliberate. The plain GET MARKS THE THREAD READ
   * as a side effect, and an importer must not silently clear the buyer's
   * unread state — that is an operator decision, and ML surfaces unread
   * counts the seller relies on.
   */
  getMessage(messageId: string): Promise<MlPackMessages>;

  /**
   * `GET /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale` — a pack's
   * whole thread, WITH the `conversation_status` that says whether we can
   * still reply (#532). Same `mark_as_read=false` reasoning as above.
   *
   * When a pack id is absent ML accepts the ORDER id in the same position,
   * keeping the `/packs/` path — that fallback is the caller's to apply.
   */
  /**
   * `GET /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale&mark_as_read=false`
   * — ONE page of a post-sale thread, plus `conversation_status` and the live
   * `seller_max_message_length`.
   *
   * ⚠️ **Paginated, with a default page of 10.** Callers that need the whole
   * thread must loop on `paging.total`; a bare call returns the first ten
   * messages and nothing says so.
   *
   * ⚠️ `mark_as_read=false` is not optional. The plain GET marks the thread
   * read as a side effect, and an importer must not clear the unread state the
   * seller relies on.
   */
  getPackMessages(
    packId: string,
    sellerId: string,
    paginacao?: { limit?: number; offset?: number },
  ): Promise<MlPackMessages>;

  /** `GET /post-purchase/v1/claims/{claimId}` — one claim (claims import, Step 14). */
  getClaim(claimId: number): Promise<MlClaim>;
  /**
   * `GET /post-purchase/v1/claims/{claimId}/messages` — the claim's message
   * thread. **The endpoint returns a bare JSON array**, not a `results`
   * envelope (claims import, Step 14).
   */
  getClaimMessages(claimId: number): Promise<MlClaimMessage[]>;
  /**
   * `GET /post-purchase/v1/claims/reasons/{reasonId}` — the human-readable
   * claim reason. The legacy client needed a token-in-header special case for
   * exactly this endpoint (api.dart:1501 `tokenOnHeader: true`) — moot here
   * because `request()` ALWAYS sends the Bearer header.
   */
  getClaimReason(reasonId: string): Promise<MlClaimReason>;

  /* ---------------------- Claim respond + resolve (#768) ---------------- */

  /**
   * `POST /post-purchase/v1/claims/{id}/actions/send-message`.
   *
   * ⚠️ `receiverRole` is not cosmetic. Once a mediation is open ML routes the
   * seller's messages through the mediator and a message aimed at the
   * complainant is refused — derive it from the available action rather than
   * guessing (`receiverRoleDaAcao`).
   *
   * ⚠️ `attachments` must be OMITTED, not empty: ML validates the keys it is
   * given, so `[]` invites a 422 for nothing.
   */
  sendClaimMessage(
    claimId: number,
    body: { receiverRole: string; message: string; attachments?: readonly string[] },
  ): Promise<void>;

  /**
   * `POST /post-purchase/v1/claims/{id}/attachments` — multipart, returns the
   * key a message then references.
   *
   * ⚠️ 5 MB, JPG/PNG/PDF, filename ≤125 chars of `[a-zA-Z0-9_\-.]` — and the
   * key EXPIRES in 48h if no message claims it (see `ML_CLAIM_ANEXO`).
   */
  uploadClaimAttachment(
    claimId: number,
    file: { data: Uint8Array; filename: string; contentType: string },
  ): Promise<MlClaimAttachmentUpload>;

  /** `POST …/actions/open-dispute` — escalate to a Mercado Livre mediator. */
  openClaimDispute(claimId: number): Promise<MlClaim>;

  /** `POST …/expected-resolutions/refund` — refund the buyer in full; closes the claim. */
  refundClaim(claimId: number): Promise<MlExpectedResolution[]>;

  /** `POST …/expected-resolutions/allow-return` — accept the product back. */
  allowClaimReturn(claimId: number): Promise<MlExpectedResolution[]>;

  /**
   * `GET …/partial-refund/available-offers` — the ONLY percentages ML accepts.
   * Read this before offering one; see {@link partialRefundClaim}.
   */
  getClaimPartialRefundOffers(claimId: number): Promise<MlPartialRefundOffers>;

  /**
   * `POST …/expected-resolutions/partial-refund` with `{ percentage }`.
   *
   * ⚠️ The percentage MUST come from `getClaimPartialRefundOffers`. ML answers
   * `400 "Percentage not found 35.0"` for anything else, refuses 100% here
   * (that is the full-refund endpoint), and silently defaults to 50% if none
   * is sent at all — which would refund half the order by omission.
   */
  partialRefundClaim(claimId: number, percentage: number): Promise<MlExpectedResolution[]>;
  /**
   * `GET …/claims/{id}/expected-resolutions` — what each party WANTS out of the
   * claim, and whether it is `pending` / `accepted` / `rejected`.
   *
   * ⚠️ Read-side counterpart of the four resolution POSTs, and the one an
   * operator needs FIRST: choosing between refund, partial refund and
   * allow-return without knowing what the buyer asked for is guessing. The
   * POSTs already return this same array as their write result.
   */
  getClaimExpectedResolutions(claimId: number): Promise<MlExpectedResolution[]>;

  /** `GET /post-purchase/v1/claims/search` — paged claims; only provided params are sent. */
  searchClaims(params: {
    status?: string;
    stage?: string;
    limit?: number;
    offset?: number;
  }): Promise<MlClaimSearch>;
  /**
   * `GET /post-purchase/v1/claims/{claimId}/attachments/{filename}/download` —
   * a claim-message attachment as raw bytes (legacy `getAttachment`,
   * api.dart:1533-1539). The `filename` ML issues is the download key.
   */
  downloadClaimAttachment(claimId: number, filename: string): Promise<MlAttachmentDownload>;
  /**
   * `GET /messages/attachments/{id}?tag=post_sale&site_id=MLB` — a post-sale
   * message attachment as raw bytes.
   *
   * ⚠️ NOT symmetric with the claims endpoint, in three ways that each cost a
   * round trip to discover:
   *  - `site_id` is a REQUIRED query param here (omitting it is a documented
   *    400, `Invalid site_id`); the claims endpoint has no such param.
   *  - the id is the attachment's opaque `filename` from
   *    `message_attachments[]` (`<userId>_<uuid>.<ext>`), never
   *    `original_filename`.
   *  - ML documents NO 404 for this route — only 400 and 500 — so a
   *    permanently missing file arrives as a 500. The caller classifies any
   *    non-2xx as deterministic and skips; see `orderMessageAttachments.ts`.
   */
  downloadPostSaleAttachment(attachmentId: string): Promise<MlAttachmentDownload>;

  /**
   * `GET /missed_feeds?app_id=&limit=&offset=[&topic=]` (#812) — the
   * notifications Mercado Livre gave up delivering to our callback. An entry is
   * filed only after ML's **8th retry (~1h)** failed to get a 200, and is
   * retained **2 days**.
   *
   * ⚠️ There is **no time filter** and **no consume/ack**: reading does not
   * remove an entry, so the same one reappears until it expires. The caller
   * must therefore be idempotent, and must NOT keep a `sent`-based cursor —
   * an entry filed after a run would sit permanently below such a cursor.
   *
   * `topic` is ML's documented filter. It is exposed for diagnostics but the
   * sweep deliberately does not use it: it cannot reduce the number of entries
   * that must be read, only split them across one request per topic.
   */
  getMissedFeeds(params: {
    appId: string;
    topic?: string;
    limit?: number;
    offset?: number;
  }): Promise<MlMissedFeeds>;
}

export function createMercadoLivreApi(config: MercadoLivreApiConfig): MercadoLivreApi {
  const baseUrl = config.baseUrl ?? DEFAULT_API_BASE_URL;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = config.retryDelayMs ?? ((attempt: number) => 2 ** attempt * 250);

  function buildUrl(path: string, query?: RequestOpts['query']): string {
    const url = new URL(path, baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Fetch with the network-retry policy shared by EVERY endpoint (JSON and
   * multipart alike): only a fetch throw (no response — genuine network
   * failure) retries, with backoff; any HTTP response, 429/5xx included, is
   * returned as-is — retrying a non-idempotent write could double-execute.
   * Re-sending the same body object across attempts is safe for both string
   * and FormData bodies (fetch serializes per request).
   */
  async function fetchWithNetworkRetry(
    url: string,
    init: RequestInit,
    networkMessage: string,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      try {
        return await fetchImpl(url, init);
      } catch (err) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(backoff(attempt));
          continue;
        }
        throw new MercadoLivreNetworkError(
          `${networkMessage}: ${err instanceof Error ? err.message : 'fetch falhou'}`,
          err,
        );
      }
    }
  }

  async function requestWithStatus<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const url = buildUrl(path, opts.query);
    // Fetch the token once; it stays valid across the (few, quick) retries.
    const token = await config.getAccessToken();

    const res = await fetchWithNetworkRetry(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      'Falha de rede ao contatar o Mercado Livre',
    );

    // 2xx (incl. 206 Partial Content, valid for orders) → parse + validate.
    if (res.ok)
      return { data: await parseOk(res, schema), status: res.status, headers: res.headers };
    throw await toHttpError(res);
  }

  /** `requestWithStatus` for the (overwhelming) majority of callers, which only
   * ever need the body. Reach for `requestWithStatus` when 200-vs-206 changes
   * what the caller does (the order mirror, `getOrderResponse`) or when a
   * RESPONSE HEADER is part of the answer (`x-version`, `getUserProductStock`). */
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<T> {
    const { data } = await requestWithStatus(method, path, schema, opts);
    return data;
  }

  /**
   * A write whose RESPONSE BODY carries nothing the caller needs — ML answers
   * these with a bare 200/201, an empty body, or a confirmation string.
   *
   * Still goes through the full auth/retry/error mapping: a 401 becomes a
   * reauth error and a non-2xx becomes `MercadoLivreHttpError`, which is what
   * lets the routes tell an operator WHY a send was refused.
   */
  async function requestVoid(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<void> {
    await requestWithStatus(method, path, z.unknown(), body === undefined ? {} : { body });
  }

  /**
   * Multipart upload — same auth/retry/error mapping as `request`, no JSON body.
   *
   * Generic over the endpoint because claims upload attachments through the
   * identical machinery at a different path (#768).
   */
  async function uploadMultipart<T>(
    path: string,
    file: { data: Uint8Array; filename: string; contentType: string },
    schema: z.ZodType<T>,
    mensagemDeRede: string,
  ): Promise<T> {
    const token = await config.getAccessToken();
    const form = new FormData();
    // Uint8Array → ArrayBuffer slice so the Blob owns plain bytes.
    const bytes = file.data.buffer.slice(
      file.data.byteOffset,
      file.data.byteOffset + file.data.byteLength,
    ) as ArrayBuffer;
    form.append('file', new Blob([bytes], { type: file.contentType }), file.filename);

    const res = await fetchWithNetworkRetry(
      buildUrl(path),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
          // NOTE: no Content-Type — fetch sets the multipart boundary itself.
        },
        body: form,
      },
      mensagemDeRede,
    );
    if (res.ok) return parseOk(res, schema);
    throw await toHttpError(res);
  }

  function uploadPicture(file: PictureFile): Promise<MlPictureUpload> {
    return uploadMultipart(
      '/pictures/items/upload',
      file,
      pictureUploadSchema,
      'Falha de rede ao enviar imagem ao Mercado Livre',
    );
  }

  /**
   * Raw-XML upload — same auth/retry/error mapping as `request`, but the body
   * bypasses it on purpose: `request` JSON-stringifies every body, and this
   * endpoint takes the signed XML verbatim.
   */
  async function sendShipmentInvoiceData(
    shipmentId: number | string,
    xml: string,
  ): Promise<MlShipmentInvoice> {
    const token = await config.getAccessToken();
    const res = await fetchWithNetworkRetry(
      buildUrl(`/shipments/${shipmentId}/invoice_data`, { siteId: 'MLB' }),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
          'Content-Type': 'application/xml',
        },
        body: xml,
      },
      'Falha de rede ao enviar a NF-e ao Mercado Livre',
    );
    if (res.ok) return parseOk(res, mlShipmentInvoiceSchema);
    throw await toHttpError(res);
  }

  /**
   * Binary download — same auth/retry mapping as `request`, but the 2xx body
   * is raw bytes, not JSON. The token rides the Bearer header — NEVER the
   * legacy `access_token` query param (deprecated by ML). A 400 whose body is
   * not the `failed_shipments` shape falls through to the standard HTTP error.
   */
  async function getShipmentLabels(
    shipmentId: string,
    format: 'pdf' | 'zpl2',
  ): Promise<MlShipmentLabelResult> {
    const token = await config.getAccessToken();
    const res = await fetchWithNetworkRetry(
      buildUrl('/shipment_labels', { shipment_ids: shipmentId, response_type: format }),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
        },
      },
      'Falha de rede ao obter a etiqueta do Mercado Livre',
    );
    if (!res.ok) {
      if (res.status === 400) {
        const text = await res.text();
        const mlMessage = extractFailedShipmentMessage(text);
        if (mlMessage !== null) {
          throw new MercadoLivreLabelUnavailableError(
            `Etiqueta indisponível no Mercado Livre: ${mlMessage}`,
            mlMessage,
          );
        }
        throw httpErrorFromBody(res, text);
      }
      throw await toHttpError(res);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Legacy guard: ML has returned 2xx with an empty body — that is a failed
    // label, not a printable one.
    if (bytes.length === 0) {
      throw new MercadoLivreLabelUnavailableError(
        'O Mercado Livre retornou uma etiqueta vazia.',
        '',
      );
    }
    return { bytes, contentType: res.headers.get('content-type') };
  }

  /**
   * Binary download — same auth/retry/error mapping as `getShipmentLabels`,
   * for claim-message attachments. The token rides the Bearer header — NEVER
   * the legacy `access_token` query param. Mirrors the label empty-body guard:
   * a 2xx with no bytes is thrown as an HTTP error (carrying the 2xx status so
   * the caller can tell "empty body" from a genuine non-2xx) instead of handing
   * the importer a zero-byte file to upload.
   */
  /**
   * The shared half of both attachment downloads: Bearer auth, network retry,
   * error mapping and the empty-body guard. ONE implementation on purpose —
   * the guard is the part most easily got wrong, and a 2xx-with-no-bytes is
   * thrown as an HTTP error CARRYING the 2xx status so the caller can tell
   * "empty body" from a genuine non-2xx, instead of being handed a zero-byte
   * file to upload.
   */
  async function downloadAnexo(url: string): Promise<MlAttachmentDownload> {
    const token = await config.getAccessToken();
    const res = await fetchWithNetworkRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
        },
      },
      'Falha de rede ao baixar o anexo do Mercado Livre',
    );
    if (!res.ok) throw await toHttpError(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) {
      throw new MercadoLivreHttpError('O Mercado Livre retornou um anexo vazio.', res.status, null);
    }
    return { bytes, contentType: res.headers.get('content-type') };
  }

  /**
   * Binary download for claim-message attachments. The token rides the Bearer
   * header — NEVER the legacy `access_token` query param.
   */
  function downloadClaimAttachment(
    claimId: number,
    filename: string,
  ): Promise<MlAttachmentDownload> {
    return downloadAnexo(
      buildUrl(
        `/post-purchase/v1/claims/${claimId}/attachments/${encodeURIComponent(filename)}/download`,
      ),
    );
  }

  /**
   * Binary download for post-sale MESSAGE attachments.
   *
   * ⚠️ `site_id` is REQUIRED — ML answers a documented 400 (`Invalid site_id`)
   * without it. `MLB` is hardcoded to match the two `siteId: 'MLB'` call sites
   * above; this backend serves one site.
   */
  function downloadPostSaleAttachment(attachmentId: string): Promise<MlAttachmentDownload> {
    return downloadAnexo(
      buildUrl(`/messages/attachments/${encodeURIComponent(attachmentId)}`, {
        tag: 'post_sale',
        site_id: 'MLB',
      }),
    );
  }

  return {
    getMe: () => request('GET', '/users/me', userSchema),
    criarUsuarioTeste: async (siteId: string) => {
      // Same auth + network-retry policy as `request`, but the success branch
      // never reaches `parseOk`: see `parseTestUser` below.
      const token = await config.getAccessToken();
      const res = await fetchWithNetworkRetry(
        buildUrl('/users/test_user'),
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': userAgent,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ site_id: siteId }),
        },
        'Falha de rede ao criar usuário de teste no Mercado Livre',
      );
      // A FAILED mint carries no password, so the shared error mapping is safe
      // here — it is only the 2xx body that must never be echoed.
      if (!res.ok) throw await toHttpError(res);
      return parseTestUser(await res.text());
    },
    getUser: (id) => request('GET', `/users/${id}`, userSchema),
    getItem: (id) =>
      request('GET', `/items/${id}`, itemSchema, { query: { include_attributes: 'all' } }),
    // `-L` in ML's documented curl: this resource REDIRECTS, and `fetch` follows
    // redirects by default, so nothing extra is needed here — noted because the
    // docs make a point of the flag and its absence looks like an omission.
    getLastModeration: (referenceId) =>
      request('GET', `/moderations/last_moderation/${referenceId}`, mlModerationsSchema),
    // `async` so the refusal below REJECTS rather than throwing synchronously:
    // the signature promises a `Promise`, and a caller writing
    // `getItemsByIds(x).catch(…)` would otherwise take an uncaught exception at
    // the call site instead. The one caller `await`s inside a `try`, which hides
    // the difference — which is exactly why it is worth not depending on.
    getItemsByIds: async (ids, attributes) => {
      // Refuse locally rather than let ML answer for a prefix. A silent prefix is
      // the failure nobody notices, and the one caller reads this to decide what
      // to CLOSE — see `sweepRemovedMembers`.
      if (ids.length > ML_MULTIGET_MAX_IDS) {
        throw new MercadoLivreError(
          `multiget aceita no máximo ${String(ML_MULTIGET_MAX_IDS)} ids (recebeu ${String(ids.length)})`,
        );
      }
      return request('GET', '/items', itemsMultigetSchema, {
        query: {
          ids: ids.join(','),
          ...(attributes != null && attributes.length > 0
            ? { attributes: attributes.join(',') }
            : {}),
        },
      });
    },
    getPrices: (itemId) => request('GET', `/items/${itemId}/prices`, itemPricesSchema),
    getOrder: (id) => request('GET', `/orders/${id}`, orderSchema),
    getOrderResponse: async (id) => {
      const { data, status } = await requestWithStatus('GET', `/orders/${id}`, orderSchema);
      return { order: data, complete: status === 200 };
    },
    getPack: (id) => request('GET', `/packs/${id}`, packSchema),
    searchOrders: (params) =>
      request('GET', '/orders/search', orderSearchSchema, { query: params }),

    getPayment: (paymentId) => request('GET', `/collections/${paymentId}`, mlPaymentSchema),
    getShipment: async (shipmentId) => {
      const shipment = await request('GET', `/shipments/${shipmentId}`, mlShipmentSchema, {
        // Mandatory on shipments requests as of 2025-10-12, and it selects the
        // body `mlShipmentSchema` types — see that schema for what moved (#957).
        headers: { 'x-format-new': 'true' },
      });
      // The single choke point every shipment passes through, so this is where
      // the "is ML still serving the legacy body?" observation belongs. It is
      // what lets the compat fallbacks be deleted on evidence rather than on a
      // guess — see `registrarFormatoDoEnvio`.
      registrarFormatoDoEnvio(shipment);
      return shipment;
    },
    getShipmentPayments: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/payments`, mlShipmentPaymentsSchema, {
        // Same mandate; this resource's body is unchanged by it (ML's own curl
        // example for it carries the header).
        headers: { 'x-format-new': 'true' },
      }),
    getShipmentOrders: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/orders`, mlShipmentOrdersSchema, {
        // Mandatory on this resource per the ML docs — without it the call 404s.
        headers: { 'X-New-Domain': 'true' },
      }),
    getShipmentSla: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/sla`, mlShipmentSlaSchema),
    sendShipmentInvoiceData,
    getShipmentInvoiceData: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/invoice_data`, mlShipmentInvoiceSchema, {
        query: { siteId: 'MLB' },
      }),
    getShipmentLabels,
    getSellerShippingSchedule: (sellerId, logisticType) =>
      request(
        'GET',
        `/users/${sellerId}/shipping/schedule/${logisticType}`,
        mlSellerShippingScheduleSchema,
      ),
    getOrderBillingInfo: (orderId) =>
      request('GET', `/orders/${orderId}/billing_info`, mlBillingInfoSchema, {
        headers: { 'x-version': '2' },
      }),

    getUserProductFamily: (familyId) =>
      request('GET', `/sites/MLB/user-products-families/${familyId}`, userProductFamilySchema),
    searchItemsByUserProduct: (sellerId, userProductIds, page) =>
      request('GET', `/users/${sellerId}/items/search`, userProductItemsSearchSchema, {
        query: {
          user_product_id: userProductIds.join(','),
          // Explicit, so a caller that needs COMPLETENESS can tell a short page
          // from ML's silent default (`resolveFamilyItemIds`). Omitted entirely
          // when the caller does not care, keeping the legacy request shape.
          ...(page?.limit != null ? { limit: String(page.limit) } : {}),
          ...(page?.offset != null ? { offset: String(page.offset) } : {}),
          // Same rule: absent unless asked for, so the existing callers'
          // request shape is byte-identical.
          ...(page?.status != null ? { status: page.status } : {}),
        },
      }),
    getUserProductStock: async (userProductId) => {
      const { data, headers } = await requestWithStatus(
        'GET',
        `/user-products/${userProductId}/stock`,
        userProductStockSchema,
      );
      return { stock: data, version: headers.get('x-version') };
    },
    putUserProductSellerWarehouseStock: async (userProductId, version, locations) => {
      const { data, headers } = await requestWithStatus(
        'PUT',
        `/user-products/${userProductId}/stock/type/${STOCK_LOCATION_TYPE.sellerWarehouse}`,
        // `.nullable()`, NOT the bare object: `parseOk` feeds the schema `null`
        // for an empty body, so a bare-ack answer would raise
        // `MercadoLivreValidationError` for a write that LANDED — see the
        // interface docblock.
        userProductStockSchema.nullable(),
        { headers: { 'x-version': version }, body: { locations } },
      );
      return { stock: data, version: headers.get('x-version') };
    },
    getMigrationLiveListing: (itemId) =>
      request('GET', `/items/${itemId}/migration_live_listing`, migrationLiveListingSchema),
    scanSellerItems: (sellerId, scrollId) =>
      request('GET', `/users/${sellerId}/items/search`, sellerItemsScanSchema, {
        query: { search_type: 'scan', ...(scrollId ? { scroll_id: scrollId } : {}) },
      }),

    createItem: (payload) => request('POST', '/items', itemSchema, { body: payload }),
    updateItem: (id, payload) => request('PUT', `/items/${id}`, itemSchema, { body: payload }),
    getItemDescription: (id) => request('GET', `/items/${id}/description`, itemDescriptionSchema),
    setItemDescription: (id, plainText, opts) =>
      opts?.replace
        ? request('PUT', `/items/${id}/description`, itemDescriptionSchema, {
            body: { plain_text: plainText },
            query: { api_version: 2 },
          })
        : request('POST', `/items/${id}/description`, itemDescriptionSchema, {
            body: { plain_text: plainText },
          }),
    suggestCategories: (query, limit) =>
      request('GET', '/sites/MLB/domain_discovery/search', domainDiscoverySchema, {
        query: { q: query, limit },
      }),
    getCategory: (id) => request('GET', `/categories/${id}`, categorySchema),
    getCategoryAttributes: (id) =>
      request('GET', `/categories/${id}/attributes`, categoryAttributesSchema),
    listSiteCategories: () => request('GET', '/sites/MLB/categories', siteCategoriesSchema),
    getCategoryListingTypes: (categoryId) =>
      request('GET', `/categories/${categoryId}/listing_types`, categoryListingTypesSchema),
    getListingPrices: (input) =>
      request('GET', '/sites/MLB/listing_prices', listingPricesSchema, {
        query: {
          price: input.price,
          listing_type_id: input.listingTypeId,
          ...(input.categoryId != null ? { category_id: input.categoryId } : {}),
        },
      }),
    uploadPicture,

    getDomainTechnicalSpecs: (domainId) =>
      request('GET', `/domains/${domainId}/technical_specs`, technicalSpecsSchema),
    getGridTechnicalSpecs: (domainId, attributes) =>
      request('POST', `/domains/${domainId}/technical_specs`, technicalSpecsSchema, {
        query: { section: 'grids' },
        body: { attributes },
      }),
    createSizeChart: (payload) =>
      request('POST', '/catalog/charts', sizeChartApiSchema, { body: payload }),
    getSizeChart: (chartId) => request('GET', `/catalog/charts/${chartId}`, sizeChartApiSchema),
    deleteSizeChart: (chartId) =>
      request('DELETE', `/catalog/charts/${chartId}`, sizeChartDeleteResponseSchema),
    updateSizeChartName: (chartId, names) =>
      request('PUT', `/catalog/charts/${chartId}`, sizeChartApiSchema, { body: { names } }),
    addSizeChartRow: (chartId, row) =>
      request('POST', `/catalog/charts/${chartId}/rows`, sizeChartApiSchema, { body: row }),
    updateSizeChartRow: (chartId, rowId, row) =>
      request('PUT', `/catalog/charts/${chartId}/rows/${rowId}`, sizeChartApiSchema, {
        body: row,
      }),
    getActiveChartDomains: () =>
      request('GET', '/catalog/charts/MLB/configurations/active_domains', activeChartDomainsSchema),
    getCatalogDomain: (domainId) =>
      request('GET', `/catalog_domains/${domainId}`, catalogDomainSchema),

    getMessage: (messageId) =>
      request(
        'GET',
        `/messages/${encodeURIComponent(messageId)}?tag=post_sale&mark_as_read=false`,
        mlPackMessagesSchema,
      ),
    getPackMessages: (packId, sellerId, paginacao) => {
      // ML rejects a non-positive `limit` with a 400, so only send what the
      // caller actually asked for.
      const extra =
        (paginacao?.limit != null && paginacao.limit > 0
          ? `&limit=${String(paginacao.limit)}`
          : '') +
        (paginacao?.offset != null && paginacao.offset > 0
          ? `&offset=${String(paginacao.offset)}`
          : '');
      return request(
        'GET',
        `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}` +
          '?tag=post_sale&mark_as_read=false' +
          extra,
        mlPackMessagesSchema,
      );
    },
    answerQuestion: (questionId, text) =>
      request('POST', '/answers', mlAnswerResultSchema, {
        body: { question_id: questionId, text },
      }),
    deleteQuestion: async (questionId) => {
      await requestVoid('DELETE', `/questions/${questionId}`);
    },
    blockUserFromQuestions: async (sellerId, buyerId) => {
      await requestVoid('POST', `/users/${sellerId}/questions_blacklist`, {
        user_id: buyerId,
      });
    },
    sendPackMessage: async (packId, sellerId, body) => {
      await requestVoid(
        'POST',
        `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}` +
          '?tag=post_sale',
        {
          // ⚠️ BOTH ids go out as STRINGS, matching ML's own documented body.
          // The agent id is the one that must not be mistyped — sending it as a
          // number has been observed to work, but the reference is explicit and
          // this is not a place to be clever.
          from: { user_id: sellerId },
          to: { user_id: String(body.toUserId) },
          text: body.text,
          ...(body.attachments && body.attachments.length > 0
            ? { attachments: [...body.attachments] }
            : {}),
        },
      );
    },
    getQuestion: (questionId) =>
      request('GET', `/questions/${questionId}?api_version=4`, mlQuestionSchema),
    getClaim: (claimId) => request('GET', `/post-purchase/v1/claims/${claimId}`, mlClaimSchema),
    getClaimMessages: (claimId) =>
      request('GET', `/post-purchase/v1/claims/${claimId}/messages`, mlClaimMessagesSchema),
    sendClaimMessage: async (claimId, body) => {
      await requestVoid('POST', `/post-purchase/v1/claims/${claimId}/actions/send-message`, {
        receiver_role: body.receiverRole,
        message: body.message,
        // Omitted when empty — ML validates the keys it is handed.
        ...(body.attachments && body.attachments.length > 0
          ? { attachments: [...body.attachments] }
          : {}),
      });
    },
    uploadClaimAttachment: (claimId, file) =>
      uploadMultipart(
        `/post-purchase/v1/claims/${claimId}/attachments`,
        file,
        mlClaimAttachmentUploadSchema,
        'Falha de rede ao enviar anexo da reclamação ao Mercado Livre',
      ),
    openClaimDispute: (claimId) =>
      request('POST', `/post-purchase/v1/claims/${claimId}/actions/open-dispute`, mlClaimSchema, {
        body: {},
      }),
    refundClaim: (claimId) =>
      request(
        'POST',
        `/post-purchase/v1/claims/${claimId}/expected-resolutions/refund`,
        mlExpectedResolutionsSchema,
        { body: {} },
      ),
    allowClaimReturn: (claimId) =>
      request(
        'POST',
        `/post-purchase/v1/claims/${claimId}/expected-resolutions/allow-return`,
        mlExpectedResolutionsSchema,
        { body: {} },
      ),
    getClaimPartialRefundOffers: (claimId) =>
      request(
        'GET',
        `/post-purchase/v1/claims/${claimId}/partial-refund/available-offers`,
        mlPartialRefundOffersSchema,
      ),
    partialRefundClaim: (claimId, percentage) =>
      request(
        'POST',
        `/post-purchase/v1/claims/${claimId}/expected-resolutions/partial-refund`,
        mlExpectedResolutionsSchema,
        { body: { percentage } },
      ),
    getClaimExpectedResolutions: (claimId) =>
      request(
        'GET',
        `/post-purchase/v1/claims/${claimId}/expected-resolutions`,
        mlExpectedResolutionsSchema,
      ),
    getClaimReason: (reasonId) =>
      request('GET', `/post-purchase/v1/claims/reasons/${reasonId}`, mlClaimReasonSchema),
    searchClaims: (params) =>
      request('GET', '/post-purchase/v1/claims/search', mlClaimSearchSchema, { query: params }),
    downloadClaimAttachment,
    downloadPostSaleAttachment,

    // `buildUrl` drops every `undefined` query value, so an omitted `topic` /
    // `limit` / `offset` simply does not reach the URL — do NOT add `?? 0`
    // defaults here, that would pin ML's own defaults to ours.
    getMissedFeeds: ({ appId, topic, limit, offset }) =>
      request('GET', '/missed_feeds', mlMissedFeedsSchema, {
        query: { app_id: appId, topic, limit, offset },
      }),
  };
}

/**
 * `parseOk` for the ONE response that carries a password.
 *
 * ⚠️ The vector this closes is the **non-JSON branch**: `parseOk` puts the RAW
 * BODY into `MercadoLivreValidationError`, so an ML error page — or a 200 whose
 * body drifted — hands the credential to whatever logs the throw. That is the
 * shape of #1015, where a Zod failure on the OAuth exchange turned out to be
 * carrying the token response.
 *
 * The schema-mismatch branch was **measured, not assumed**: Zod 4 serializes
 * `code`/`path`/`expected`/`message` and no input value, for a wrong type, a
 * missing key, a `too_small`, or a non-object root — and `.passthrough()` keeps
 * `unrecognized_keys` (which would name keys, never values) from firing at all.
 * So `result.error.issues` is not itself a leak today. Reporting field names
 * instead is defence-in-depth — Zod's issue contents are not a stability
 * contract, and the message reads better — not a fix for a live bug.
 */
function parseTestUser(text: string): MlTestUser {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new MercadoLivreValidationError(
      'Resposta não-JSON do Mercado Livre ao criar usuário de teste.',
      // Deliberately NOT `text`: that is the whole point of this function.
      null,
    );
  }
  const result = testUserSchema.safeParse(body);
  if (!result.success) {
    const campos = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(raiz)'))];
    throw new MercadoLivreValidationError(
      `Resposta inesperada do Mercado Livre ao criar usuário de teste. Campos inválidos: ${campos.join(', ')}.`,
      campos,
    );
  }
  return result.data;
}

async function parseOk<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new MercadoLivreValidationError('Resposta não-JSON do Mercado Livre.', text);
      }
      throw err;
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // ⚠️ The field names go in the MESSAGE, not only in `issues` — mirroring
    // `parseTestUser` above. `issues` reaches a log line and nothing else: the
    // notification pipeline persists `err.message` ALONE into the failures doc
    // (`persistFailure`, pipeline.ts:215) and the sweep marks with `err.message`
    // too (pipeline.ts:368). So the durable record of a parked notification —
    // precisely the artifact that was useless in #1087, saying only "formato
    // inesperado" while a quoted `order_id` stopped a payment importing — carries
    // whatever is in this string and nothing more.
    //
    // Paths are field names and carry no value, which is what makes this safe;
    // the raw body must never end up here (see the non-JSON branch above, #1015).
    const campos = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(raiz)'))];
    throw new MercadoLivreValidationError(
      `Resposta do Mercado Livre em formato inesperado. Campos inválidos: ${campos.join(', ')}.`,
      result.error.issues,
    );
  }
  return result.data;
}

async function toHttpError(res: Response): Promise<Error> {
  return httpErrorFromBody(res, await res.text());
}

/** `toHttpError` for a body that was already consumed (the label 400 branch). */
function httpErrorFromBody(res: Response, text: string): Error {
  let body: unknown = text.length > 0 ? text : null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // leave `body` as the raw text
    }
  }
  const parsed = tokenErrorSchema.safeParse(body);
  const message = parsed.success
    ? (parsed.data.message ?? parsed.data.error_description ?? parsed.data.error)
    : undefined;

  // 401 = the access token was rejected → the account must reconnect.
  if (res.status === 401) {
    return new MercadoLivreReauthRequiredError(
      'refresh_failed',
      message ?? 'Token do Mercado Livre inválido. Reconecte a conta.',
    );
  }
  return new MercadoLivreHttpError(
    `ML ${res.status}: ${message ?? res.statusText}`,
    res.status,
    body,
    parseRetryAfterSec(res.headers.get('retry-after')),
  );
}

/** The 400 body `shipment_labels` sends when a label cannot be emitted (yet). */
const failedShipmentsSchema = z
  .object({
    failed_shipments: z.array(z.object({ message: z.string() }).passthrough()).min(1),
  })
  .passthrough();

/**
 * `failed_shipments[0].message` from a 400 body, or null when the body is not
 * that shape. The message is kept in FULL — the caller substring-matches
 * `invoice_pending` on it (legacy parity, utils.dart).
 */
function extractFailedShipmentMessage(text: string): string | null {
  if (text.length === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  const parsed = failedShipmentsSchema.safeParse(body);
  return parsed.success ? parsed.data.failed_shipments[0]!.message : null;
}

/**
 * `Retry-After` in whole seconds. Only the delta-seconds form is honoured —
 * the HTTP-date form (and any junk) parses to null and the caller falls back
 * to its default pause.
 */
function parseRetryAfterSec(raw: string | null): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

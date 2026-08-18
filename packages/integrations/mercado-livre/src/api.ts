import { z } from 'zod';
import {
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
  type MlClaimMessage,
  type MlClaimReason,
  type MlClaimSearch,
  type MlDomainDiscovery,
  type MlItem,
  type MlItemDescription,
  type MlItemPrices,
  type MlListingPrices,
  type MlMigrationLiveListing,
  type MlMissedFeeds,
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
  type MlUser,
  type MlUserProductFamily,
  type MlUserProductItemsSearch,
  activeChartDomainsSchema,
  catalogDomainSchema,
  categoryAttributesSchema,
  categoryListingTypesSchema,
  categorySchema,
  domainDiscoverySchema,
  itemDescriptionSchema,
  itemPricesSchema,
  itemSchema,
  listingPricesSchema,
  migrationLiveListingSchema,
  mlBillingInfoSchema,
  mlClaimMessagesSchema,
  mlClaimReasonSchema,
  mlClaimSchema,
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
  tokenErrorSchema,
  userProductFamilySchema,
  userProductItemsSearchSchema,
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

/** Raw file bytes from `downloadClaimAttachment` (claims import, Step 14). */
export interface MlClaimAttachmentDownload {
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
  getItem(id: string): Promise<MlItem>;
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
   */
  searchItemsByUserProduct(
    sellerId: number,
    userProductIds: readonly string[],
    page?: { limit?: number; offset?: number },
  ): Promise<MlUserProductItemsSearch>;
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
  downloadClaimAttachment(claimId: number, filename: string): Promise<MlClaimAttachmentDownload>;

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
  ): Promise<{ data: T; status: number }> {
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
    if (res.ok) return { data: await parseOk(res, schema), status: res.status };
    throw await toHttpError(res);
  }

  /** `requestWithStatus` for the (overwhelming) majority of callers, which only
   * ever need the body. Reach for `requestWithStatus` when 200-vs-206 changes
   * what the caller does — today only the order mirror, see `getOrderResponse`. */
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<T> {
    const { data } = await requestWithStatus(method, path, schema, opts);
    return data;
  }

  /** Multipart upload — same auth/retry/error mapping as `request`, no JSON body. */
  async function uploadPicture(file: PictureFile): Promise<MlPictureUpload> {
    const token = await config.getAccessToken();
    const form = new FormData();
    // Uint8Array → ArrayBuffer slice so the Blob owns plain bytes.
    const bytes = file.data.buffer.slice(
      file.data.byteOffset,
      file.data.byteOffset + file.data.byteLength,
    ) as ArrayBuffer;
    form.append('file', new Blob([bytes], { type: file.contentType }), file.filename);

    const res = await fetchWithNetworkRetry(
      buildUrl('/pictures/items/upload'),
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
      'Falha de rede ao enviar imagem ao Mercado Livre',
    );
    if (res.ok) return parseOk(res, pictureUploadSchema);
    throw await toHttpError(res);
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
  async function downloadClaimAttachment(
    claimId: number,
    filename: string,
  ): Promise<MlClaimAttachmentDownload> {
    const token = await config.getAccessToken();
    const res = await fetchWithNetworkRetry(
      buildUrl(
        `/post-purchase/v1/claims/${claimId}/attachments/${encodeURIComponent(filename)}/download`,
      ),
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

  return {
    getMe: () => request('GET', '/users/me', userSchema),
    getUser: (id) => request('GET', `/users/${id}`, userSchema),
    getItem: (id) =>
      request('GET', `/items/${id}`, itemSchema, { query: { include_attributes: 'all' } }),
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
        },
      }),
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

    getClaim: (claimId) => request('GET', `/post-purchase/v1/claims/${claimId}`, mlClaimSchema),
    getClaimMessages: (claimId) =>
      request('GET', `/post-purchase/v1/claims/${claimId}/messages`, mlClaimMessagesSchema),
    getClaimReason: (reasonId) =>
      request('GET', `/post-purchase/v1/claims/reasons/${reasonId}`, mlClaimReasonSchema),
    searchClaims: (params) =>
      request('GET', '/post-purchase/v1/claims/search', mlClaimSearchSchema, { query: params }),
    downloadClaimAttachment,

    // `buildUrl` drops every `undefined` query value, so an omitted `topic` /
    // `limit` / `offset` simply does not reach the URL — do NOT add `?? 0`
    // defaults here, that would pin ML's own defaults to ours.
    getMissedFeeds: ({ appId, topic, limit, offset }) =>
      request('GET', '/missed_feeds', mlMissedFeedsSchema, {
        query: { app_id: appId, topic, limit, offset },
      }),
  };
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
    throw new MercadoLivreValidationError(
      'Resposta do Mercado Livre em formato inesperado.',
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

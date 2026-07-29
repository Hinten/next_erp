import { z } from 'zod';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from './errors';
import { DEFAULT_API_BASE_URL } from './oauth';
import {
  type MlActiveChartDomains,
  type MlBillingInfo,
  type MlCatalogDomain,
  type MlCategory,
  type MlCategoryAttribute,
  type MlDomainDiscovery,
  type MlItem,
  type MlItemDescription,
  type MlItemPrices,
  type MlMigrationLiveListing,
  type MlOrder,
  type MlOrderSearch,
  type MlPack,
  type MlPayment,
  type MlPictureUpload,
  type MlSellerItemsScan,
  type MlSellerShippingSchedule,
  type MlShipment,
  type MlShipmentInvoice,
  type MlShipmentPayment,
  type MlShipmentSla,
  type MlSizeChartApi,
  type MlTechnicalSpecs,
  type MlUser,
  type MlUserProductFamily,
  type MlUserProductItemsSearch,
  activeChartDomainsSchema,
  catalogDomainSchema,
  categoryAttributesSchema,
  categorySchema,
  domainDiscoverySchema,
  itemDescriptionSchema,
  itemPricesSchema,
  itemSchema,
  migrationLiveListingSchema,
  mlBillingInfoSchema,
  mlPaymentSchema,
  mlSellerShippingScheduleSchema,
  mlShipmentInvoiceSchema,
  mlShipmentPaymentsSchema,
  mlShipmentSchema,
  mlShipmentSlaSchema,
  orderSchema,
  orderSearchSchema,
  packSchema,
  pictureUploadSchema,
  sellerItemsScanSchema,
  sizeChartApiSchema,
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

export interface MercadoLivreApi {
  getMe(): Promise<MlUser>;
  getUser(id: number | string): Promise<MlUser>;
  getItem(id: string): Promise<MlItem>;
  /** `GET /items/{id}/prices` — the listing's price set, consulted on the `items_prices` webhook topic (Step 11). */
  getPrices(itemId: string): Promise<MlItemPrices>;
  getOrder(id: number | string): Promise<MlOrder>;
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
  /** `GET /shipments/{shipmentId}/sla` — the dispatch deadline for a shipment (order import, Step 9). */
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
   */
  searchItemsByUserProduct(
    sellerId: number,
    userProductIds: readonly string[],
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

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<T> {
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
    if (res.ok) return parseOk(res, schema);
    throw await toHttpError(res);
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

  return {
    getMe: () => request('GET', '/users/me', userSchema),
    getUser: (id) => request('GET', `/users/${id}`, userSchema),
    getItem: (id) =>
      request('GET', `/items/${id}`, itemSchema, { query: { include_attributes: 'all' } }),
    getPrices: (itemId) => request('GET', `/items/${itemId}/prices`, itemPricesSchema),
    getOrder: (id) => request('GET', `/orders/${id}`, orderSchema),
    getPack: (id) => request('GET', `/packs/${id}`, packSchema),
    searchOrders: (params) =>
      request('GET', '/orders/search', orderSearchSchema, { query: params }),

    getPayment: (paymentId) => request('GET', `/collections/${paymentId}`, mlPaymentSchema),
    getShipment: (shipmentId) => request('GET', `/shipments/${shipmentId}`, mlShipmentSchema),
    getShipmentPayments: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/payments`, mlShipmentPaymentsSchema),
    getShipmentSla: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/sla`, mlShipmentSlaSchema),
    sendShipmentInvoiceData,
    getShipmentInvoiceData: (shipmentId) =>
      request('GET', `/shipments/${shipmentId}/invoice_data`, mlShipmentInvoiceSchema, {
        query: { siteId: 'MLB' },
      }),
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
    searchItemsByUserProduct: (sellerId, userProductIds) =>
      request('GET', `/users/${sellerId}/items/search`, userProductItemsSearchSchema, {
        query: { user_product_id: userProductIds.join(',') },
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
  const text = await res.text();
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

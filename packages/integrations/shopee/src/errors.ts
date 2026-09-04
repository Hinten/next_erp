/**
 * Typed error hierarchy for the Shopee Open Platform integration, plus the one
 * place Shopee's `error` code strings are classified.
 *
 * Every `catch` in this package narrows on one of these (or on a platform class
 * such as `SyntaxError`) and rethrows anything else — repo rule 6. Callers
 * branch on `instanceof` to map to HTTP responses, to a reconnect prompt, or to
 * a retry decision.
 *
 * ## Why classification lives here and not in `api.ts`
 *
 * Both `api.ts` (business calls) and `oauth.ts` (the two token endpoints) have
 * to read the same code strings, and they disagree about exactly one of them
 * (`error_auth`). A single table with an explicit `surface` parameter is the
 * only shape in which that disagreement is written down once instead of drifting
 * between two modules.
 *
 * ⚠️ Shopee does NOT signal failure with an HTTP status. `error === ''` is the
 * success signal and a failing call is routinely HTTP 200, so nothing here may
 * be keyed on `httpStatus`; it is carried for diagnostics only.
 */

/**
 * What a caller is supposed to DO about a Shopee failure.
 *
 * ⚠️ `'other'` is a real verdict, not "unclassified". Anything not on the table
 * below is deliberately mapped to it, so a code Shopee adds tomorrow surfaces as
 * a plain failure rather than being guessed onto the re-auth or retry ladder.
 */
export type ShopeeErrorKind = 'reauth' | 'burst' | 'daily' | 'transient' | 'other';

export const SHOPEE_ERROR_KIND = {
  /** The stored authorization is dead — the seller must consent again. */
  reauth: 'reauth',
  /** Short-window rate limit; back off and retry. */
  burst: 'burst',
  /** Daily quota, resets 00:00 UTC+8; do NOT retry before then. */
  daily: 'daily',
  /** Shopee's own server/network hiccup; safe to retry. */
  transient: 'transient',
  /** Everything else, including every code this table does not know. */
  other: 'other',
} as const satisfies Record<string, ShopeeErrorKind>;

/**
 * Which family of endpoints produced the code.
 *
 * ⚠️ Load-bearing for exactly one code — see {@link SHOPEE_AMBIGUOUS_AUTH_CODE}.
 */
export type ShopeeSurface = 'auth' | 'business';

export const SHOPEE_SURFACE = {
  /** `/api/v2/auth/*` — the token exchange and the refresh. */
  auth: 'auth',
  /** Every other operation (shop, product, order …). */
  business: 'business',
} as const satisfies Record<string, ShopeeSurface>;

/* -------------------------------------------------------------------------- */
/*                                 The classes                                */
/* -------------------------------------------------------------------------- */

/** Base class for every error this package raises. */
export class ShopeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeError';
  }
}

/** OUR misconfiguration — a bad host override, an impossible page size, a subject with no id. */
export class ShopeeConfigError extends ShopeeError {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeConfigError';
  }
}

/** `fetch` threw: DNS, TLS, connection reset, abort. There is no response. */
export class ShopeeNetworkError extends ShopeeError {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ShopeeNetworkError';
  }
}

/**
 * A non-2xx whose body is NOT a Shopee envelope.
 *
 * ⚠️ An expected condition rather than an anomaly: once the app's IP whitelist
 * is enabled (P2 of the master plan) a call from an undeclared address is
 * rejected at Shopee's EDGE, which answers HTML or an empty body — the request
 * never reaches the API that would have produced `{ error: … }`. Telling that
 * apart from a real API failure is the reason this class exists.
 */
export class ShopeeHttpError extends ShopeeError {
  readonly httpStatus: number;
  readonly path: string;

  constructor(message: string, init: { readonly httpStatus: number; readonly path: string }) {
    super(message);
    this.name = 'ShopeeHttpError';
    this.httpStatus = init.httpStatus;
    this.path = init.path;
  }
}

export interface ShopeeApiErrorInit {
  /** Shopee's own `error` string, verbatim. */
  readonly code: string;
  readonly kind: ShopeeErrorKind;
  /** Diagnostics only — a failing Shopee call is routinely HTTP 200. */
  readonly httpStatus: number;
  readonly path: string;
  readonly requestId?: string | null;
  readonly warning?: string | null;
}

/** Shopee answered with a non-empty `error` in the envelope. */
export class ShopeeApiError extends ShopeeError {
  readonly code: string;
  readonly kind: ShopeeErrorKind;
  readonly httpStatus: number;
  readonly path: string;
  readonly requestId: string | null;
  readonly warning: string | null;

  constructor(message: string, init: ShopeeApiErrorInit) {
    super(message);
    this.name = 'ShopeeApiError';
    this.code = init.code;
    this.kind = init.kind;
    this.httpStatus = init.httpStatus;
    this.path = init.path;
    this.requestId = init.requestId ?? null;
    this.warning = init.warning ?? null;
  }
}

/** The authorization is gone. A retry cannot fix it; the seller must consent again. */
export class ShopeeReauthRequiredError extends ShopeeApiError {
  constructor(message: string, init: ShopeeApiErrorInit) {
    super(message, init);
    this.name = 'ShopeeReauthRequiredError';
  }
}

/**
 * A rate limit, with the two Shopee classes kept apart.
 *
 * ⚠️ `declare`, not a plain redeclaration. The repo targets ES2022, so
 * `useDefineForClassFields` is on and a real field declaration here would be
 * DEFINED (as `undefined`) after `super()` had already assigned the base value —
 * the narrowing would compile and then read back `undefined` at runtime.
 * `declare` is type-only and emits nothing. There is a regression test.
 *
 * ⚠️ And it carries NO `override`, although `noImplicitOverride` is on: TS
 * rejects the combination outright (TS1243), because a `declare` member emits
 * nothing and therefore overrides nothing at runtime. The plan called for
 * `declare override`; that does not compile.
 */
export class ShopeeRateLimitError extends ShopeeApiError {
  declare readonly kind: 'burst' | 'daily';
  /** From the `Retry-After` header, when Shopee sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    init: Omit<ShopeeApiErrorInit, 'kind'> & {
      readonly kind: 'burst' | 'daily';
      readonly retryAfterSeconds?: number | null;
    },
  ) {
    super(message, init);
    this.name = 'ShopeeRateLimitError';
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/**
 * The body did not match the schema that describes it — or a 2xx carried no JSON
 * at all.
 *
 * ⚠️ `campos` carries field PATHS and never values, and the message is built from
 * those paths alone. A Shopee token response IS a credential, so a body reaching
 * a log line would be the #1015 leak shape.
 */
export class ShopeeSchemaError extends ShopeeError {
  readonly campos: string[];
  readonly httpStatus: number;
  readonly path: string;

  constructor(
    message: string,
    init: {
      readonly campos?: readonly string[];
      readonly httpStatus: number;
      readonly path: string;
    },
  ) {
    super(message);
    this.name = 'ShopeeSchemaError';
    this.campos = [...(init.campos ?? [])];
    this.httpStatus = init.httpStatus;
    this.path = init.path;
  }
}

/* -------------------------------------------------------------------------- */
/*                               Classification                               */
/* -------------------------------------------------------------------------- */

/**
 * The one code whose meaning depends on WHICH endpoint returned it.
 *
 * ⚠️ On the auth endpoints Shopee's own sample is
 * `error_auth: "Invalid refresh_token."` — terminal, the seller must reconnect.
 * On a business call the same string means *Invalid sign*: a signing or clock
 * bug on OUR side. Classifying that as `reauth` would disconnect a perfectly
 * healthy conta on every mis-signed call, and the disconnect would look like a
 * Shopee problem.
 */
export const SHOPEE_AMBIGUOUS_AUTH_CODE = 'error_auth';

/**
 * Shopee's documented `error` strings, exact spellings, closed set. Anything not
 * here is `'other'` — never "not on the ladder".
 *
 * ⚠️ `invalid_main_acount_id` is spelled that way BY SHOPEE (one `c` short of
 * "account"). The typo is the wire value; "correcting" it here would silently
 * stop matching. A near-miss test pins both spellings.
 *
 * Merchant/supplier variants of the reauth codes are deliberately absent: no doc
 * page names them, and inventing a spelling is how a guard stops firing. Add one
 * here the day a page — or a live call — shows it.
 *
 * ⚠️ A `Map`, not a plain object, and not for style. Shopee's `error` is an
 * arbitrary provider string: `KIND_BY_CODE['constructor']` on an object literal
 * answers `Object.prototype.constructor` — a truthy FUNCTION that sails past
 * `?? 'other'` and is then returned as the kind. A `Map` has no prototype chain
 * to inherit through. A test pins it.
 */
const KIND_BY_CODE = new Map<string, ShopeeErrorKind>(
  Object.entries({
    // --- the authorization is dead -----------------------------------------
    refresh_token_expired: SHOPEE_ERROR_KIND.reauth,
    shop_access_expired: SHOPEE_ERROR_KIND.reauth,
    shop_no_linked: SHOPEE_ERROR_KIND.reauth,
    shop_banned: SHOPEE_ERROR_KIND.reauth,
    error_shop_refresh_token: SHOPEE_ERROR_KIND.reauth,
    // --- throttling --------------------------------------------------------
    error_rate_limit: SHOPEE_ERROR_KIND.burst,
    error_limit: SHOPEE_ERROR_KIND.daily,
    // --- Shopee's side, retryable ------------------------------------------
    error_server: SHOPEE_ERROR_KIND.transient,
    error_network: SHOPEE_ERROR_KIND.transient,
    // --- ours, and NOT a reason to disconnect anything ----------------------
    // `error_sign` is a signing/clock defect; a retry sends the same bad sign.
    error_sign: SHOPEE_ERROR_KIND.other,
    error_param: SHOPEE_ERROR_KIND.other,
    error_data: SHOPEE_ERROR_KIND.other,
    // The three consent-callback failures. `'other'`, not `reauth`: during a
    // callback there is no stored conta to re-authorize — the consent the
    // operator just completed is the thing that failed, and the route names it.
    invalid_code: SHOPEE_ERROR_KIND.other,
    invalid_shop_id: SHOPEE_ERROR_KIND.other,
    invalid_main_acount_id: SHOPEE_ERROR_KIND.other,
  } satisfies Record<string, ShopeeErrorKind>),
);

/** Shopee's `error` string → what to do about it, on this surface. */
export function classifyShopeeError(code: string, surface: ShopeeSurface): ShopeeErrorKind {
  if (code === SHOPEE_AMBIGUOUS_AUTH_CODE) {
    return surface === SHOPEE_SURFACE.auth ? SHOPEE_ERROR_KIND.reauth : SHOPEE_ERROR_KIND.other;
  }
  return KIND_BY_CODE.get(code) ?? SHOPEE_ERROR_KIND.other;
}

/** The envelope fields {@link shopeeErrorFromEnvelope} reads. */
export interface ShopeeErrorEnvelope {
  readonly error: string;
  readonly message: string | null;
  readonly request_id: string | null;
  readonly warning: string | null;
}

export interface ShopeeErrorContext {
  readonly path: string;
  readonly httpStatus: number;
  readonly surface: ShopeeSurface;
  readonly retryAfterSeconds?: number | null;
}

/**
 * Build the right {@link ShopeeApiError} subclass for a failing envelope.
 *
 * ⚠️ Shopee's `message` is carried into the thrown message on purpose — it is the
 * only human-readable text an operator gets. It describes an ERROR and is never
 * a credential: the token endpoints carry the credential in
 * `access_token`/`refresh_token`, which are absent from a failing body and are
 * never read here.
 */
export function shopeeErrorFromEnvelope(
  env: ShopeeErrorEnvelope,
  ctx: ShopeeErrorContext,
): ShopeeApiError {
  const kind = classifyShopeeError(env.error, ctx.surface);
  const detalhe = env.message !== null && env.message !== '' ? ` — ${env.message}` : '';
  const message = `Shopee ${ctx.path} respondeu ${env.error} (HTTP ${String(ctx.httpStatus)})${detalhe}`;
  const init: ShopeeApiErrorInit = {
    code: env.error,
    kind,
    httpStatus: ctx.httpStatus,
    path: ctx.path,
    requestId: env.request_id,
    warning: env.warning,
  };

  if (kind === SHOPEE_ERROR_KIND.reauth) return new ShopeeReauthRequiredError(message, init);
  if (kind === SHOPEE_ERROR_KIND.burst || kind === SHOPEE_ERROR_KIND.daily) {
    return new ShopeeRateLimitError(message, {
      ...init,
      kind,
      retryAfterSeconds: ctx.retryAfterSeconds ?? null,
    });
  }
  return new ShopeeApiError(message, init);
}

/**
 * The PER-CONTA containment boundary shared by this channel's per-conta sweeps.
 *
 * It was `orderBackfill.ts`'s private `contidoPorConta` until the WEEKLY
 * settlement sweep (#1514, step 6) needed the identical decision. Promoted
 * verbatim, with its docblocks, rather than copied: a containment list is
 * exactly the kind of thing that drifts toward plausible in two files at once —
 * one of them gains a class, both keep a comment saying they agree, and a
 * `ShopeeConfigError` starts being swallowed on one sweep and rethrown on the
 * other.
 */
import {
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import { ShopeeCredencialInvalidaError } from './credentialStore';
import { ShopeeContaNotConfiguredError } from './shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from './tokenStore';
import { ShopeeTasksDisabledError } from '../shopeeTasks';

/**
 * Admin-SDK Firestore and Cloud Tasks enqueue failures surface as `Error`s
 * carrying a numeric gRPC status `code`. Narrowed to the actual status range
 * (integers 1–16; 0 = OK never rides an error) so a coding-bug `Error` that
 * happens to expose some other numeric `code` is NOT contained. Verbatim from
 * `conta/expiracaoSweep.ts`.
 */
export function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * The per-conta containment boundary: an expected failure family is recorded on
 * the conta's cursor document and the loop moves on; anything else rethrows and
 * fails the tick loudly.
 *
 * ⚠️ It names the classes, NOT the `ShopeeError` base — because
 * `ShopeeConfigError` extends that base and must RETHROW. A missing partner id
 * or key is OUR misconfiguration, and the execution that names the missing
 * binding is the one that has to fail (#778); containing it would turn a broken
 * deploy into N identical `lastError` strings and a green tick.
 * `conta/expiracaoSweep.ts` can safely catch the base class only because
 * nothing inside its loop can raise a config error.
 *
 * `ShopeeReauthRequiredError` and `ShopeeRateLimitError` extend
 * `ShopeeApiError`, so they are contained by that arm. Reauth is deliberately
 * NOT escalated into an aviso here: the dead-grant aviso has exactly one
 * producer (`avisos/autorizacao.ts`), and a second one would fork the row.
 *
 * `ShopeeContaSemShopIdError` cannot fire on the callers that already skipped a
 * conta without a raw `shop_id`, and it stays because the boundary names a
 * FAMILY, not today's call graph: a conta whose `shop_id` is cleared between
 * the enumeration and `loadShopeeContext` must not cost every other conta its
 * tick.
 *
 * ⚠️ The three CREDENTIAL classes are here for that same reason, and they are
 * the ones these sweeps can actually raise: the client carries the token as a
 * FUNCTION, so `getOrRefreshAccessToken` runs INSIDE the Shopee call — inside
 * the loop. `ShopeeRefreshEmAndamentoError` is another instance holding the
 * refresh lease past the poll budget (transient by construction, and the route
 * answers it 503 + Retry-After); `ShopeeSemCredencialError` and
 * `ShopeeCredencialInvalidaError` are per-conta STATES the conta route already
 * renders. All three are about ONE conta's grant, never about our deployment,
 * so each belongs on that conta's `lastError` rather than costing every other
 * conta its tick. `ShopeeConfigError` still rethrows: that one IS ours.
 */
export function erroContidoPorConta(err: unknown): err is Error {
  return (
    err instanceof ShopeeApiError ||
    err instanceof ShopeeNetworkError ||
    err instanceof ShopeeHttpError ||
    err instanceof ShopeeSchemaError ||
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeRefreshEmAndamentoError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeeTasksDisabledError ||
    isGrpcCodedError(err)
  );
}

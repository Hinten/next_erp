/**
 * Browser-safe entry — the typed client for the `apps/integrations`
 * Melhor Envio freight routes. Imported by `apps/web`. No server deps.
 */
export {
  createFreightHttpClient,
  type FreightComprarResult,
  type FreightContaResult,
  type FreightHttpClient,
  type FreightHttpClientConfig,
  type FreightImprimirResult,
  type FreightOAuthStartResult,
  type FreightRastrearResult,
} from './client';

export {
  FreightAuthError,
  FreightBadRequestError,
  FreightHttpError,
  FreightLabelTerminalError,
  FreightNetworkError,
  FreightNotFoundError,
  FreightReauthRequiredError,
  FreightServerError,
  FreightValidationError,
} from './errors';

// Re-export the ME wire types apps/web needs to build calculate requests
// and render quote responses (type-only — erased from the bundle).
export type {
  Balance,
  CalculateOption,
  CalculateRequest,
  CalculateResponse,
  Company,
  DimensionsWeight,
  Me,
} from '../melhor-envio/types';
export { isErroredOption } from '../melhor-envio/types';

// Pure request builder (package-vs-volumes) — apps/web composes the
// calculate request with it before calling `client.calculate`.
export {
  buildCalculatePayload,
  type BuildCalculateParams,
  type VolumeInput,
} from '../melhor-envio/calculate';

// Pure cart-item builder + its primitive inputs — apps/web resolves the
// pedido/filial/endereço/cliente into these and composes the `comprar`
// request before calling `client.comprar`. Domain-neutral, no server deps.
export {
  buildCartItem,
  type BuildCartItemParams,
  type CartAddressInput,
  type CartOptionsInput,
  type CartProductInput,
} from '../melhor-envio/cart';
export type { CartInsertRequest } from '../melhor-envio/types';

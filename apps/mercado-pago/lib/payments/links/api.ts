/**
 * How the link orchestrations build their Mercado Pago client (#367): from the
 * account's live access token, already resolved (and, if it was near expiry,
 * refreshed) by `ctx.resolveAccessToken()`.
 *
 * One factory instead of four copies, and the seam every orchestration's tests
 * (and `deps.api`) replace: a test hands in a fake client and never touches the
 * network.
 */
import { createMercadoPagoApi, type MercadoPagoApi } from '@delfrance/integrations-mercado-pago';

/** Builds a client from a live access token. */
export type FabricaApi = (token: string) => MercadoPagoApi;

/** The real client: the token is fetched once by the caller and reused. */
export const fabricaApiPadrao: FabricaApi = (token) =>
  createMercadoPagoApi({ getAccessToken: async () => token });

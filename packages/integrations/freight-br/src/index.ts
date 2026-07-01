/**
 * `@delfrance/integrations-freight-br` — Brazilian freight providers.
 *
 * The root entry is the **server-facing** Melhor Envio core (OAuth,
 * token lifecycle, API client). It's fetch-based and platform-neutral
 * but is meant to run in `apps/integrations`, which holds the OAuth
 * `client_secret` and persists tokens via an injected `TokenStore`.
 *
 * The browser-safe typed client for the `apps/integrations` freight
 * routes lives at the `./http-client` subpath (imported by `apps/web`),
 * mirroring the nfe package's `./http-provider` split.
 *
 * Decision: freight is integrated directly — this typed HTTP client + the
 * `comprarEtiqueta` pipeline + the per-tipo `FREIGHT_TIPO_CAPS` table in
 * `@delfrance/schemas` — NOT via a `core/plugins` registry contract. That
 * 3-method shape couldn't express OAuth + cart→checkout→generate + per-tipo UI.
 * See the freight-integrations skill for the rationale.
 */
export * from './melhor-envio';

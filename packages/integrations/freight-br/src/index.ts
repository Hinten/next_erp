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
 * Decision: this package **bypasses** the `core/plugins` `FreightProvider`
 * registry — that 3-method contract can't express OAuth +
 * cart→checkout→generate + per-tipo UI, and has no consumers. See the
 * freight-integrations skill (F5) for the rationale.
 */
export * from './melhor-envio';

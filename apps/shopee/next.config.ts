import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No client-side React tree here, but Next still wants this for the
  // build pipeline. Workspace packages need transpilation.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/data',
    '@delfrance/schemas',
    '@delfrance/integrations-shopee',
  ],
  // ⚠️ LOAD-BEARING — do not "tidy" this away. `firebase-admin` is in Next's
  // DEFAULT `serverExternalPackages`; `@google-cloud/firestore` is not, and this
  // app imports its `/pipelines` subpath directly (the stock discovery in
  // lib/shopee/estoque/, step 12). Without this entry the two reach the package
  // through different resolution paths and Turbopack instantiates it SEPARATELY —
  // the pipeline builders come from one copy while `db` comes from another.
  //
  // The Pipelines API overloads every stage on `instanceof`
  // (`pipeline-util.js`: `isExpr` / `isAliasedExpr`), so a cross-copy expression
  // is not rejected — `define()`/`select()` silently reinterpret it as an
  // options object and the request dies with the runtime
  // `TypeError: selectables is not iterable`. Nothing fails at build or typecheck
  // time, vitest runs unbundled, and the emulator cannot run pipelines at all — so
  // the ONLY signal is a 500 in production (Mercado Livre's
  // `/api/marketplace/mercado-livre/enviar-estoque` was the worked example).
  //
  // Listing it here leaves a plain `require()` at runtime, resolved from
  // node_modules — hence the real `dependencies` entry in package.json, which an
  // externalized package needs. Enforced by
  // `packages/config-eslint/rules/next-firestore-external.test.js`.
  serverExternalPackages: ['@google-cloud/firestore'],
};

export default config;

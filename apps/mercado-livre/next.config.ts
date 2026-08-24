import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No client-side React tree here, but Next still wants this for the
  // build pipeline. Workspace packages need transpilation.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/data',
    '@delfrance/schemas',
    '@delfrance/integrations-mercado-livre',
  ],
  // ⚠️ LOAD-BEARING — do not "tidy" this away. `firebase-admin` is in Next's
  // DEFAULT `serverExternalPackages`; `@google-cloud/firestore` is not, and this
  // app imports its `/pipelines` subpath directly
  // (lib/marketplace/estoque/bulkEstoquePlan.ts). Without this entry the two
  // reach the package through different resolution paths and Turbopack
  // instantiates it SEPARATELY — the stock sweep's builders came from one copy
  // while `db` came from another.
  //
  // The Pipelines API overloads every stage on `instanceof`
  // (`pipeline-util.js`: `isExpr` / `isAliasedExpr`), so a cross-copy expression
  // is not rejected — `define()`/`select()` silently reinterpret it as an
  // options object and iterate `undefined`, and the request dies with the
  // runtime `TypeError: selectables is not iterable`. Nothing fails at build or
  // typecheck time, vitest runs unbundled (one instance, `instanceof` always
  // holds), and the emulator cannot run pipelines at all — so the ONLY signal is
  // a 500 in production. That was `/api/marketplace/mercado-livre/enviar-estoque`.
  //
  // Listing it here leaves a plain `require()` at runtime, resolved from
  // node_modules — hence the real `dependencies` entry in package.json, which an
  // externalized package needs. Enforced by
  // `packages/config-eslint/rules/next-firestore-external.test.js`.
  serverExternalPackages: ['@google-cloud/firestore'],
};

export default config;

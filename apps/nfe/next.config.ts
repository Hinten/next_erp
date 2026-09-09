import type { NextConfig } from 'next';

// NOTE: `apps/nfe/functions/` is a deploy-artifact-only sub-build (the `nfe`
// Cloud Functions codebase) — it imports `firebase-functions` and is built by its
// own esbuild lane (functions/build.mjs), NEVER by `next build`. It lives outside
// `app/`, so Next never bundles it; it is only type-checked via the shared
// tsconfig. Do not add it (or `firebase-functions`) to transpilePackages.
const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages need transpilation. The library lives in
  // @delfrance/integrations-nfe; the rest are shared with apps/integrations.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/data',
    '@delfrance/integrations-nfe',
    '@delfrance/schemas',
  ],
  // Server-only npm deps that ship native / binary / data assets read at
  // runtime relative to their own dir. Bundling them under Turbopack rewrites
  // `__dirname` / `import.meta.url` to virtual paths and the runtime can't
  // locate the sibling file — e.g. xmllint.wasm, soap WSDLs, node-forge
  // crypto, and pdfkit's Standard-14 AFM fonts
  // (`pdfkit/js/data/Helvetica.afm`, read via `fs.readFileSync`). Leaving
  // them as externals means Next emits a plain `require()` at runtime and the
  // package resolves its own sibling files via real node_modules paths.
  // Same fix-pattern as `apps/nfe/lib/nfe/runtime.ts:resolveChainPath`.
  // `@google-cloud/firestore` is NOT in Next 16's default externals, and this
  // app now imports its `/pipelines` subpath directly (the Simples Nacional
  // apuração aggregate). Without this entry `db` — which comes from
  // `firebase-admin/firestore` — and the pipeline builders reach ONE package
  // through TWO resolution paths, Turbopack instantiates it twice, and the
  // `instanceof` overloads inside the Pipelines API fall through to the wrong
  // branch. It does not throw where you'd look: it dies later with
  // `TypeError: selectables is not iterable`. See
  // `packages/config-eslint/rules/next-firestore-external.test.js`.
  serverExternalPackages: [
    '@google-cloud/firestore',
    'xmllint-wasm',
    'soap',
    'node-forge',
    'pdfkit',
    'fontkit',
    'bwip-js',
  ],
};

export default config;

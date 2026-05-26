import type { NextConfig } from 'next';

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
  // Server-only npm deps that ship native / binary assets. Bundling
  // them under Turbopack rewrites `__dirname` / `import.meta.url` to
  // virtual paths and the runtime can't locate the sibling binary
  // (xmllint.wasm, soap WSDLs, node-forge crypto). Leaving them as
  // externals means Next emits a plain `require()` at runtime and the
  // package resolves its own sibling files via real node_modules paths.
  // Same fix-pattern as `apps/nfe/lib/nfe/runtime.ts:resolveChainPath`.
  serverExternalPackages: ['xmllint-wasm', 'soap', 'node-forge'],
};

export default config;

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No client-side React tree here, but Next still wants this for the
  // build pipeline. Workspace packages need transpilation.
  // No `serverExternalPackages`: none of these imports `@google-cloud/firestore`
  // (`next-firestore-external.test.js` walks the closure).
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/core',
    '@delfrance/data',
    '@delfrance/schemas',
    '@delfrance/integrations-amazon-sp-api',
  ],
  /**
   * `Referrer-Policy: no-referrer` on EVERY response of this backend, site-wide
   * (step-2 plan §3 decision 7). The OAuth callback is a URL the operator's
   * browser lands on carrying a single-use `state` and a live authorization
   * code; no `Referer` may carry either onward. The same header is also set
   * explicitly by `lib/amazon/core/respond.ts` (every route answer) and by
   * `proxy.ts` (the CORS preflight), which is what a unit test can observe —
   * `proxy.test.ts` asserts this function too.
   */
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ]),
};

export default config;

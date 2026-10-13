import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No client-side React tree here, but Next still wants this for the
  // build pipeline. Workspace packages need transpilation.
  // No `serverExternalPackages`: none of these imports `@google-cloud/firestore`.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/data',
    '@delfrance/schemas',
    '@delfrance/integrations-loja-integrada',
  ],
};

export default config;

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
};

export default config;

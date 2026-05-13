import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // apps/web is client-first; transpile workspace packages.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/core',
    '@delfrance/data',
    '@delfrance/schemas',
    '@delfrance/ui',
  ],
  experimental: {
    // Mantine v7 + Next 15 requires this for proper RSC interop on the
    // bits we do render server-side (root layout shell only).
    optimizePackageImports: ['@mantine/core', '@mantine/hooks', '@mantine/dates'],
  },
};

export default config;
